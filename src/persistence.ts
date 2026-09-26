import { createSeedProject } from "./data";
import type {
  ConflictField,
  FieldConflict,
  LegacyEnvelopeV1,
  PersistedEnvelope,
  ProjectData,
  ReviewComment,
  Segment,
  TranscriptTrack,
} from "./types";

export const STORAGE_KEY = "sologsb-1007-project-v1";
export const SESSION_KEY = "sologsb-1007-session";

/** 参与三方合并与冲突检测的字段，批注始终合并、不参与冲突。 */
const CONFLICT_FIELDS: ConflictField[] = ["text", "speakerId", "timecode", "confidence", "flags", "tagIds"];

/** 旧草稿（schema 1）或缺字段的片段补齐来源信息，沿用新结构。 */
function migrateProject(project: ProjectData, fallback: { tabId: string; editedAt: number; version: number }) {
  for (const track of project.tracks ?? []) {
    for (const segment of track.segments ?? []) {
      if (!segment.meta) segment.meta = { ...fallback };
      segment.comments = segment.comments ?? [];
      for (const comment of segment.comments) comment.replies = comment.replies ?? [];
    }
  }
}

export function loadProject(): { project: ProjectData; revision: number; pendingSync: boolean } {
  if (typeof localStorage === "undefined") {
    return { project: createSeedProject(), revision: 0, pendingSync: false };
  }
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "") as PersistedEnvelope | LegacyEnvelopeV1;
    if ((parsed?.schema === 1 || parsed?.schema === 2) && parsed.project?.tracks?.length) {
      migrateProject(parsed.project, {
        tabId: parsed.tabId || "旧草稿",
        editedAt: parsed.savedAt ?? Date.now(),
        version: parsed.revision ?? 0,
      });
      return {
        project: parsed.project,
        revision: parsed.revision ?? 0,
        pendingSync: parsed.schema === 2 ? Boolean(parsed.pendingSync) : false,
      };
    }
  } catch {
    // A malformed local draft falls back to the bundled sample.
  }
  return { project: createSeedProject(), revision: 0, pendingSync: false };
}

export function saveProject(project: ProjectData, revision: number, tabId: string, pendingSync = false) {
  const envelope: PersistedEnvelope = {
    schema: 2,
    revision,
    tabId,
    savedAt: Date.now(),
    pendingSync,
    project,
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(envelope));
  return envelope;
}

export function readEnvelope(): PersistedEnvelope | null {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "") as PersistedEnvelope;
  } catch {
    return null;
  }
}

export function fieldValue(segment: Segment, field: ConflictField): unknown {
  switch (field) {
    case "timecode":
      return [segment.start, segment.end] as [number, number];
    case "flags":
      return { ...segment.flags };
    case "tagIds":
      return [...segment.tagIds];
    default:
      return segment[field];
  }
}

export function applyFieldValue(segment: Segment, field: ConflictField, value: unknown) {
  switch (field) {
    case "text":
      segment.text = value as string;
      break;
    case "speakerId":
      segment.speakerId = value as string;
      break;
    case "confidence":
      segment.confidence = value as Segment["confidence"];
      break;
    case "timecode": {
      const [start, end] = value as [number, number];
      segment.start = start;
      segment.end = end;
      break;
    }
    case "flags":
      segment.flags = { ...(value as Segment["flags"]) };
      break;
    case "tagIds":
      segment.tagIds = [...(value as string[])];
      break;
  }
}

function sameField(field: ConflictField, a: unknown, b: unknown): boolean {
  if (field === "flags") {
    const fa = a as Segment["flags"];
    const fb = b as Segment["flags"];
    return fa.lowConfidence === fb.lowConfidence && fa.dialect === fb.dialect && fa.properNoun === fb.properNoun;
  }
  if (field === "tagIds") {
    const sa = [...(a as string[])].sort();
    const sb = [...(b as string[])].sort();
    return JSON.stringify(sa) === JSON.stringify(sb);
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

/** 批注与回复按 id 合并：双方的新批注、新回复都保留，绝不丢弃。 */
function mergeComments(local: ReviewComment[], incoming: ReviewComment[]): ReviewComment[] {
  const byId = new Map<string, ReviewComment>();
  for (const comment of local) byId.set(comment.id, structuredClone(comment));
  for (const comment of incoming) {
    const existing = byId.get(comment.id);
    if (!existing) {
      byId.set(comment.id, structuredClone(comment));
      continue;
    }
    const replyIds = new Set(existing.replies.map((reply) => reply.id));
    for (const reply of comment.replies) {
      if (!replyIds.has(reply.id)) existing.replies.push(structuredClone(reply));
    }
    existing.replies.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    existing.resolved = existing.resolved || comment.resolved;
  }
  return [...byId.values()];
}

/** 忽略 meta，比较两个片段正文内容是否一致（用于识别“对方已删除”）。 */
function sameContent(a: Segment, b: Segment): boolean {
  const strip = ({ meta, ...rest }: Segment) => rest;
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
}

function mergeSegment(
  trackId: string,
  local: Segment,
  incoming: Segment,
  base: Segment | undefined,
  conflicts: FieldConflict[],
): Segment {
  const result = structuredClone(local);
  const reference = base ?? local;
  for (const field of CONFLICT_FIELDS) {
    const localValue = fieldValue(local, field);
    const incomingValue = fieldValue(incoming, field);
    const baseValue = fieldValue(reference, field);
    if (sameField(field, localValue, incomingValue)) {
      applyFieldValue(result, field, localValue);
      continue;
    }
    const localChanged = !sameField(field, localValue, baseValue);
    const incomingChanged = !sameField(field, incomingValue, baseValue);
    if (incomingChanged && !localChanged) applyFieldValue(result, field, incomingValue);
    else if (localChanged && !incomingChanged) applyFieldValue(result, field, localValue);
    else {
      // 双方对同一字段改了不同的值：保留两版，交给校对员逐项选择。
      conflicts.push({
        trackId,
        segmentId: local.id,
        field,
        localValue,
        incomingValue,
        localMeta: { ...local.meta },
        incomingMeta: { ...incoming.meta },
      });
    }
  }
  const baseReviewed = reference.reviewed;
  result.reviewed = local.reviewed !== baseReviewed ? local.reviewed : incoming.reviewed;
  result.comments = mergeComments(local.comments, incoming.comments);
  result.meta = local.meta.editedAt >= incoming.meta.editedAt ? { ...local.meta } : { ...incoming.meta };
  return result;
}

function mergeTrack(
  local: TranscriptTrack,
  incoming: TranscriptTrack,
  base: TranscriptTrack | undefined,
  conflicts: FieldConflict[],
): TranscriptTrack {
  const track = structuredClone(local);
  if (base) {
    if (incoming.name !== base.name) track.name = incoming.name;
    if (incoming.language !== base.language) track.language = incoming.language;
    if (incoming.status !== base.status) track.status = incoming.status;
  }
  const baseById = new Map((base?.segments ?? []).map((segment) => [segment.id, segment]));
  const incomingById = new Map(incoming.segments.map((segment) => [segment.id, segment]));
  const localIds = new Set(local.segments.map((segment) => segment.id));
  const merged: Segment[] = [];

  for (const localSegment of local.segments) {
    const incomingSegment = incomingById.get(localSegment.id);
    if (!incomingSegment) {
      // 对方删除了该片段：本页未改动过才接受删除，否则保留。
      const baseSegment = baseById.get(localSegment.id);
      if (baseSegment && sameContent(localSegment, baseSegment)) continue;
      merged.push(structuredClone(localSegment));
      continue;
    }
    merged.push(mergeSegment(local.id, localSegment, incomingSegment, baseById.get(localSegment.id), conflicts));
  }
  for (const incomingSegment of incoming.segments) {
    if (localIds.has(incomingSegment.id)) continue;
    // 本页删除了该片段：对方未改动过才接受删除，否则按对方版本恢复。
    const baseSegment = baseById.get(incomingSegment.id);
    if (baseSegment && sameContent(incomingSegment, baseSegment)) continue;
    merged.push(structuredClone(incomingSegment));
  }
  merged.sort((a, b) => a.start - b.start);
  track.segments = merged;
  return track;
}

function mergeById<T extends { id: string }>(local: T[], incoming: T[]): T[] {
  const byId = new Map<string, T>();
  for (const item of local) byId.set(item.id, structuredClone(item));
  for (const item of incoming) if (!byId.has(item.id)) byId.set(item.id, structuredClone(item));
  return [...byId.values()];
}

/**
 * 三方合并：base 是双方最近共同看到的草稿。
 * 不同片段的修改直接合并；同一片段的同一字段被改成不同值时记入 conflicts，
 * 合并结果中先保留本页版本，由校对员在界面上逐项选择。
 */
export function mergeProjects(
  base: ProjectData,
  local: ProjectData,
  incoming: ProjectData,
): { merged: ProjectData; conflicts: FieldConflict[] } {
  const conflicts: FieldConflict[] = [];
  const merged = structuredClone(local);

  for (const key of ["title", "interviewee", "recordingDate", "activeTrackId"] as const) {
    if (incoming[key] !== base[key]) merged[key] = incoming[key];
  }
  merged.speakers = mergeById(local.speakers, incoming.speakers);
  merged.tags = mergeById(local.tags, incoming.tags);

  const baseTracks = new Map(base.tracks.map((track) => [track.id, track]));
  const incomingTracks = new Map(incoming.tracks.map((track) => [track.id, track]));
  const localTrackIds = new Set(local.tracks.map((track) => track.id));
  const tracks: TranscriptTrack[] = [];
  for (const localTrack of local.tracks) {
    const incomingTrack = incomingTracks.get(localTrack.id);
    if (!incomingTrack) {
      tracks.push(structuredClone(localTrack));
      continue;
    }
    tracks.push(mergeTrack(localTrack, incomingTrack, baseTracks.get(localTrack.id), conflicts));
  }
  for (const incomingTrack of incoming.tracks) {
    if (!localTrackIds.has(incomingTrack.id)) tracks.push(structuredClone(incomingTrack));
  }
  merged.tracks = tracks;
  merged.updatedAt = new Date().toISOString();
  return { merged, conflicts };
}

export function downloadText(filename: string, content: string, type = "text/plain;charset=utf-8") {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function formatTime(seconds: number, withMillis = true) {
  const safe = Math.max(0, seconds);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = Math.floor(safe % 60);
  const ms = Math.round((safe - Math.floor(safe)) * 1000);
  const head = [hours, minutes, secs].map((value) => String(value).padStart(2, "0")).join(":");
  return withMillis ? `${head}.${String(ms).padStart(3, "0")}` : head;
}

export function parseTime(value: string) {
  const normalized = value.trim().replace(",", ".");
  const parts = normalized.split(":").map(Number);
  if (parts.some(Number.isNaN)) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return Number(normalized) || 0;
}
