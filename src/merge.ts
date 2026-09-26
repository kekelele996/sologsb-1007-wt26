import type {
  FieldConflict,
  FieldKey,
  ProjectData,
  ReviewComment,
  Reply,
  Segment,
  TranscriptTrack,
  VersionVector,
  ConflictMap,
  ConflictCandidate,
} from "./types";
import { conflictKey } from "./types";

export const MERGE_FIELDS: FieldKey[] = [
  "text",
  "speakerId",
  "start",
  "end",
  "confidence",
  "flags",
  "tagIds",
];

const clone = <T>(value: T): T => structuredClone(value);

/* ------------------------------------------------------------------ */
/* Version vectors                                                     */
/* ------------------------------------------------------------------ */

/** -1 = a dominates b, 1 = b dominates a, 0 = equal, NaN = concurrent */
export function compareVectors(a: VersionVector, b: VersionVector): number {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  let aGreater = false;
  let bGreater = false;
  for (const key of keys) {
    const av = a[key] ?? 0;
    const bv = b[key] ?? 0;
    if (av > bv) aGreater = true;
    if (av < bv) bGreater = true;
  }
  if (aGreater && bGreater) return NaN;
  if (aGreater) return -1;
  if (bGreater) return 1;
  return 0;
}

export function vectorUnion(a: VersionVector, b: VersionVector): VersionVector {
  const out: VersionVector = { ...a };
  for (const [key, value] of Object.entries(b)) out[key] = Math.max(out[key] ?? 0, value);
  return out;
}

export function vectorDominates(winner: VersionVector, loser: VersionVector): boolean {
  return Object.entries(loser).every(([key, value]) => (winner[key] ?? 0) >= value);
}

/* ------------------------------------------------------------------ */
/* Value helpers                                                       */
/* ------------------------------------------------------------------ */

const getFieldValue = (segment: Segment, field: FieldKey): unknown => {
  switch (field) {
    case "text": return segment.text;
    case "speakerId": return segment.speakerId;
    case "start": return segment.start;
    case "end": return segment.end;
    case "confidence": return segment.confidence;
    case "flags": return segment.flags;
    case "tagIds": return segment.tagIds;
  }
};

export function sameFieldValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => sameFieldValue(item, b[index]));
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ak = Object.keys(a as object);
    const bk = Object.keys(b as object);
    return ak.length === bk.length && ak.every((key) =>
      sameFieldValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
  }
  return false;
}

const emptyFieldMeta = (tabId: string, author: string, stamp: number) => ({
  vector: { [tabId]: 1 },
  originTab: tabId,
  originAuthor: author,
  updatedAt: stamp,
});

/* ------------------------------------------------------------------ */
/* Local edit stamping                                                 */
/* ------------------------------------------------------------------ */

/**
 * Compare the pre/post project of a local edit and attach a new vector
 * component to every segment field that actually changed. Newly created
 * segments start with a fresh component on every mergeable field.
 */
export function stampLocalEdits(
  previous: ProjectData,
  next: ProjectData,
  tabId: string,
  author: string,
): ProjectData {
  const now = Date.now();
  const prevIndex = new Map<string, Segment>();
  for (const track of previous.tracks) {
    for (const segment of track.segments) prevIndex.set(`${track.id}/${segment.id}`, segment);
  }
  for (const track of next.tracks) {
    for (const segment of track.segments) {
      const before = prevIndex.get(`${track.id}/${segment.id}`);
      if (!before) {
        segment.meta = {
          fields: Object.fromEntries(
            MERGE_FIELDS.map((field) => [field, emptyFieldMeta(tabId, author, now)]),
          ) as Segment["meta"]["fields"],
          reviewedAt: 0,
          reviewedBy: "",
          createdAt: now,
        };
        continue;
      }
      segment.meta = clone(segment.meta ?? before.meta);
      segment.meta.createdAt = before.meta?.createdAt ?? now;
      for (const field of MERGE_FIELDS) {
        if (sameFieldValue(getFieldValue(before, field), getFieldValue(segment, field))) continue;
        const previousVector = segment.meta.fields[field]?.vector ?? {};
        segment.meta.fields[field] = {
          vector: { ...previousVector, [tabId]: (previousVector[tabId] ?? 0) + 1 },
          originTab: tabId,
          originAuthor: author,
          updatedAt: now,
        };
      }
      if (before.reviewed !== segment.reviewed) {
        segment.meta.reviewedAt = now;
        segment.meta.reviewedBy = author;
      } else {
        segment.meta.reviewedAt = before.meta?.reviewedAt ?? 0;
        segment.meta.reviewedBy = before.meta?.reviewedBy ?? "";
      }
    }
  }
  return next;
}

/* ------------------------------------------------------------------ */
/* Comments: union by id, replies never lost                           */
/* ------------------------------------------------------------------ */

function mergeComment(local: ReviewComment, remote: ReviewComment): ReviewComment {
  const replies = new Map<string, Reply>();
  for (const reply of local.replies) replies.set(reply.id, reply);
  for (const reply of remote.replies) {
    const existing = replies.get(reply.id);
    if (!existing || existing.createdAt < reply.createdAt) replies.set(reply.id, reply);
  }
  const localResolvedAt = local.resolvedAt ?? 0;
  const remoteResolvedAt = remote.resolvedAt ?? 0;
  const resolved = remoteResolvedAt > localResolvedAt ? remote.resolved : local.resolved;
  const resolvedAt = Math.max(localResolvedAt, remoteResolvedAt);
  const bodySource = local.createdAt >= remote.createdAt ? local : remote;
  return {
    id: local.id,
    author: local.author || remote.author,
    body: bodySource.body,
    createdAt: local.createdAt <= remote.createdAt ? local.createdAt : remote.createdAt,
    resolved,
    resolvedAt,
    replies: [...replies.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
  };
}

/** Merge the comment lists of the same segment on two tabs. */
function mergeComments(local: ReviewComment[], remote: ReviewComment[]): ReviewComment[] {
  const byId = new Map<string, ReviewComment>();
  for (const comment of local) byId.set(comment.id, clone(comment));
  for (const comment of remote) {
    const existing = byId.get(comment.id);
    byId.set(comment.id, existing ? mergeComment(existing, comment) : clone(comment));
  }
  return [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/* ------------------------------------------------------------------ */
/* Segment / track merge                                               */
/* ------------------------------------------------------------------ */

interface MergeContext {
  tabId: string;
  author: string;
  conflicts: ConflictMap;
  /** Conflicts already known locally before this merge round. */
  known: ConflictMap;
}

/** A carried branch is obsolete once its originating tab produced a successor. */
function branchObsolete(candidate: ConflictCandidate, mergedVector: VersionVector): boolean {
  if (!vectorDominates(mergedVector, candidate.vector)) return false;
  return (mergedVector[candidate.tabId] ?? 0) > (candidate.vector[candidate.tabId] ?? 0);
}

/**
 * Rebuild the candidate set for one concurrent field. Branches carried over
 * from known conflicts are kept unless a later edit or a resolution supersedes
 * them; then only surviving / fresh branches remain.
 */
function registerConflict(
  ctx: MergeContext,
  key: string,
  trackId: string,
  segmentId: string,
  field: FieldKey,
  fresh: ConflictCandidate[],
  mergedVector: VersionVector,
) {
  const carried = ctx.known[key]?.candidates ?? [];
  const collected = new Map<string, ConflictCandidate>();

  const add = (candidate: ConflictCandidate) => {
    const existing = collected.get(candidate.tabId);
    if (!existing) {
      collected.set(candidate.tabId, candidate);
      return;
    }
    const relation = compareVectors(candidate.vector, existing.vector);
    if (relation === -1) collected.set(candidate.tabId, candidate); // candidate dominates
    else if (Number.isNaN(relation) && candidate.updatedAt > existing.updatedAt) {
      collected.set(candidate.tabId, candidate);
    }
  };

  for (const candidate of carried) add(candidate);
  for (const candidate of fresh) add(candidate);

  const survivors = [...collected.values()].filter(
    (candidate) => !branchObsolete(candidate, mergedVector),
  );

  // Drop a survivor if another survivor strictly dominates it.
  const pruned = survivors.filter((candidate) =>
    !survivors.some(
      (other) => other !== candidate && compareVectors(other.vector, candidate.vector) === -1,
    ),
  );

  // Collapse identical values.
  const byValue: ConflictCandidate[] = [];
  for (const candidate of pruned) {
    const same = byValue.find((item) => sameFieldValue(item.value, candidate.value));
    if (same) same.vector = vectorUnion(same.vector, candidate.vector);
    else byValue.push(candidate);
  }

  if (byValue.length >= 2) {
    ctx.conflicts[key] = {
      trackId,
      segmentId,
      field,
      candidates: byValue.sort((a, b) => a.updatedAt - b.updatedAt),
    };
  } else {
    delete ctx.conflicts[key];
  }
}

function mergeSegmentFields(local: Segment, remote: Segment, trackId: string, ctx: MergeContext): Segment {
  const merged: Segment = clone(local);
  merged.meta = clone(local.meta);

  for (const field of MERGE_FIELDS) {
    const lm = local.meta.fields[field];
    const rm = remote.meta?.fields[field];
    if (!rm) continue; // remote predates the field metadata; local value stays.
    if (!lm) {
      (merged as unknown as Record<FieldKey, unknown>)[field] = clone(getFieldValue(remote, field));
      merged.meta.fields[field] = clone(rm);
      continue;
    }
    const localValue = getFieldValue(local, field);
    const remoteValue = getFieldValue(remote, field);
    const relation = compareVectors(lm.vector, rm.vector);
    const key = conflictKey(trackId, local.id, field);

    if (!Number.isNaN(relation) && relation <= 0) {
      // Equal or local dominates: keep local value, but widen the vector.
      merged.meta.fields[field] = {
        ...lm,
        vector: vectorUnion(lm.vector, rm.vector),
      };
      continue;
    }
    if (relation === 1) {
      (merged as unknown as Record<FieldKey, unknown>)[field] = clone(remoteValue);
      merged.meta.fields[field] = {
        ...rm,
        vector: vectorUnion(lm.vector, rm.vector),
      };
      continue;
    }
    // Concurrent edits.
    const union = vectorUnion(lm.vector, rm.vector);
    merged.meta.fields[field] = {
      ...lm,
      vector: union,
    };
    // The stored field vector is a widened union, so reuse the true branch
    // vector from any carried conflict to avoid mis-dominating other tabs.
    const carriedCandidates = ctx.known[key]?.candidates ?? [];
    const branchOf = (sideTab: string, sideVector: VersionVector, value: unknown): VersionVector => {
      const match = carriedCandidates.find(
        (candidate) => candidate.tabId === sideTab && sameFieldValue(candidate.value, value),
      );
      return match ? match.vector : sideVector;
    };
    const fresh: ConflictCandidate[] = [
      { tabId: lm.originTab, author: lm.originAuthor, updatedAt: lm.updatedAt, value: clone(localValue), vector: clone(branchOf(lm.originTab, lm.vector, localValue)) },
      { tabId: rm.originTab, author: rm.originAuthor, updatedAt: rm.updatedAt, value: clone(remoteValue), vector: clone(branchOf(rm.originTab, rm.vector, remoteValue)) },
    ];
    if (sameFieldValue(localValue, remoteValue)) {
      // Both sides agree now; a carried third branch may still disagree.
      if (carriedCandidates.length) registerConflict(ctx, key, trackId, local.id, field, fresh, union);
      continue;
    }
    // Keep the local value in the editor; carry both branches as candidates.
    (merged as unknown as Record<FieldKey, unknown>)[field] = clone(localValue);
    registerConflict(ctx, key, trackId, local.id, field, fresh, union);
  }

  // Reviewed flag is workflow state: last writer wins, never blocks merge.
  const lr = local.meta.reviewedAt ?? 0;
  const rr = remote.meta?.reviewedAt ?? 0;
  if (rr > lr) {
    merged.reviewed = remote.reviewed;
    merged.meta.reviewedAt = rr;
    merged.meta.reviewedBy = remote.meta?.reviewedBy ?? "";
  }
  merged.meta.createdAt = Math.min(local.meta.createdAt ?? Date.now(), remote.meta?.createdAt ?? Date.now());
  merged.comments = mergeComments(local.comments, remote.comments);
  return merged;
}

/** Insert remote-only segments near the neighbours they had on the remote tab. */
function mergeSegmentList(local: Segment[], remote: Segment[], trackId: string, ctx: MergeContext): Segment[] {
  const remoteById = new Map(remote.map((segment) => [segment.id, segment]));
  const result = local.map((segment) => {
    const other = remoteById.get(segment.id);
    return other ? mergeSegmentFields(segment, other, trackId, ctx) : clone(segment);
  });

  const present = new Set(result.map((segment) => segment.id));
  for (let index = 0; index < remote.length; index++) {
    const incoming = remote[index];
    if (present.has(incoming.id)) continue;
    const fresh = clone(incoming);
    let inserted = false;
    for (let back = index - 1; back >= 0; back--) {
      const at = result.findIndex((segment) => segment.id === remote[back].id);
      if (at >= 0) {
        result.splice(at + 1, 0, fresh);
        inserted = true;
        break;
      }
    }
    if (!inserted) {
      for (let forward = index + 1; forward < remote.length; forward++) {
        const at = result.findIndex((segment) => segment.id === remote[forward].id);
        if (at >= 0) {
          result.splice(at, 0, fresh);
          inserted = true;
          break;
        }
      }
    }
    if (!inserted) result.push(fresh);
    present.add(fresh.id);
  }
  return result;
}

function mergeTrack(local: TranscriptTrack, remote: TranscriptTrack, ctx: MergeContext): TranscriptTrack {
  return {
    ...local,
    segments: mergeSegmentList(local.segments, remote.segments, local.id, ctx),
  };
}

/* ------------------------------------------------------------------ */
/* Project merge                                                       */
/* ------------------------------------------------------------------ */

/** Comments surviving a split/merge may end up duplicated across segments. */
function dedupCommentsProjectWide(project: ProjectData) {
  const chosen = new Map<string, { comment: ReviewComment; trackId: string; segmentId: string }>();
  for (const track of project.tracks) {
    for (const segment of track.segments) {
      for (const comment of segment.comments) {
        const existing = chosen.get(comment.id);
        if (!existing) {
          chosen.set(comment.id, { comment, trackId: track.id, segmentId: segment.id });
        } else {
          chosen.set(comment.id, {
            comment: mergeComment(existing.comment, comment),
            trackId: existing.trackId,
            segmentId: existing.segmentId,
          });
        }
      }
    }
  }
  for (const track of project.tracks) {
    for (const segment of track.segments) {
      segment.comments = segment.comments
        .filter((comment) => chosen.get(comment.id)?.segmentId === segment.id)
        .map((comment) => chosen.get(comment.id)!.comment);
    }
  }
}

const mergeById = <T extends { id: string }>(local: T[], remote: T[]): T[] => {
  const byId = new Map(local.map((item) => [item.id, item]));
  for (const item of remote) if (!byId.has(item.id)) byId.set(item.id, item);
  return [...byId.values()];
};

const newerIso = (a: string, b: string) => (Date.parse(a) >= Date.parse(b) ? a : b);

/**
 * Three-way style merge driven by per-field version vectors.
 * Returns the merged project plus a refreshed conflict map; the input
 * conflict map holds branches from tabs whose latest save has not arrived.
 */
export function mergeProjects(
  local: ProjectData,
  remote: ProjectData,
  localCtx: { tabId: string; author: string },
  knownConflicts: ConflictMap,
): { project: ProjectData; conflicts: ConflictMap } {
  const merged: ProjectData = clone(local);
  const conflicts: ConflictMap = {};
  const ctx: MergeContext = { ...localCtx, conflicts, known: knownConflicts };

  const remoteTracks = new Map(remote.tracks.map((track) => [track.id, track]));
  for (const track of merged.tracks) {
    const other = remoteTracks.get(track.id);
    if (other) Object.assign(track, mergeTrack(track, other, ctx));
  }
  for (const track of remote.tracks) {
    if (!merged.tracks.some((item) => item.id === track.id)) merged.tracks.push(clone(track));
  }
  merged.speakers = mergeById(local.speakers, remote.speakers);
  merged.tags = mergeById(local.tags, remote.tags);

  // Project metadata follows the newest writer.
  if (Date.parse(remote.updatedAt) > Date.parse(local.updatedAt)) {
    merged.title = remote.title;
    merged.interviewee = remote.interviewee;
    merged.recordingDate = remote.recordingDate;
  }
  merged.updatedAt = newerIso(local.updatedAt, remote.updatedAt);
  dedupCommentsProjectWide(merged);

  // Carry over conflicts untouched by this merge, retiring only those whose
  // field has since been superseded (a later edit or a reviewer's choice).
  const segmentIndex = new Map<string, { trackId: string; segment: Segment }>();
  for (const track of merged.tracks) {
    for (const segment of track.segments) segmentIndex.set(`${track.id}/${segment.id}`, { trackId: track.id, segment });
  }
  for (const [key, known] of Object.entries(knownConflicts)) {
    if (conflicts[key]) continue; // already rebuilt by the merge above
    const located = segmentIndex.get(`${known.trackId}/${known.segmentId}`);
    if (!located) continue; // segment removed
    const meta = located.segment.meta.fields[known.field];
    if (!meta) {
      conflicts[key] = known;
      continue;
    }
    const alive = known.candidates.filter((candidate) => !branchObsolete(candidate, meta.vector));
    const distinct = alive.filter(
      (candidate, index) => !alive.slice(0, index).some((other) => sameFieldValue(other.value, candidate.value)),
    );
    if (distinct.length >= 2) conflicts[key] = { ...known, candidates: alive };
  }

  return { project: merged, conflicts };
}

/* ------------------------------------------------------------------ */
/* Applying reviewer choices                                           */
/* ------------------------------------------------------------------ */

/**
 * Resolve conflicts item by item. The chosen branch's value is written and
 * the deciding tab advances its own counter on top of the union of all branch
 * vectors, so the choice dominates every tab and no conflict reappears.
 */
export function applyConflictChoices(
  project: ProjectData,
  choices: { conflict: FieldConflict; candidateIndex: number }[],
  decidingTabId: string,
): ProjectData {
  const next = clone(project);
  for (const { conflict, candidateIndex } of choices) {
    const track = next.tracks.find((item) => item.id === conflict.trackId);
    const segment = track?.segments.find((item) => item.id === conflict.segmentId);
    if (!track || !segment) continue;
    const candidate = conflict.candidates[candidateIndex];
    if (!candidate) continue;
    (segment as unknown as Record<FieldKey, unknown>)[conflict.field] = clone(candidate.value);
    const previous = segment.meta.fields[conflict.field];
    const union = conflict.candidates.reduce(
      (acc, item) => vectorUnion(acc, item.vector),
      previous?.vector ?? {},
    );
    union[decidingTabId] = (union[decidingTabId] ?? 0) + 1;
    segment.meta.fields[conflict.field] = {
      vector: union,
      originTab: decidingTabId,
      originAuthor: candidate.author,
      updatedAt: Date.now(),
    };
  }
  next.updatedAt = new Date().toISOString();
  return next;
}

/* ------------------------------------------------------------------ */
/* Character diff for the review UI                                    */
/* ------------------------------------------------------------------ */

export interface DiffPart {
  text: string;
  /** present in the local value */
  local: boolean;
  /** present in the incoming value */
  incoming: boolean;
}

export function charDiff(localText: string, incomingText: string): DiffPart[] {
  const a = [...localText];
  const b = [...incomingText];
  const rows = a.length;
  const cols = b.length;
  const lcs: number[][] = Array.from({ length: rows + 1 }, () => new Array<number>(cols + 1).fill(0));
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = cols - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j]
        ? lcs[i + 1][j + 1] + 1
        : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const parts: DiffPart[] = [];
  const push = (text: string, local: boolean, incoming: boolean) => {
    if (!text) return;
    const last = parts.at(-1);
    if (last && last.local === local && last.incoming === incoming) last.text += text;
    else parts.push({ text, local, incoming });
  };
  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (a[i] === b[j]) {
      push(a[i], true, true);
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      push(a[i], true, false);
      i++;
    } else {
      push(b[j], false, true);
      j++;
    }
  }
  push(a.slice(i).join(""), true, false);
  push(b.slice(j).join(""), false, true);
  return parts;
}
