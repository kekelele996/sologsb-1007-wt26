import { Checkbox } from "@kobalte/core/checkbox";
import { Dialog } from "@kobalte/core/dialog";
import { Tabs } from "@kobalte/core/tabs";
import {
  For,
  Show,
  batch,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import { uid } from "../data";
import {
  applyConflictChoices,
  charDiff,
  mergeProjects,
  sameFieldValue,
  stampLocalEdits,
} from "../merge";
import {
  downloadText,
  formatTime,
  getAuthor,
  getTabId,
  loadConflicts,
  loadProject,
  parseTime,
  saveConflicts,
  saveProject,
  setAuthor,
} from "../persistence";
import type {
  Confidence,
  ConflictCandidate,
  ConflictMap,
  FieldConflict,
  FieldKey,
  PersistedEnvelope,
  ProjectData,
  Segment,
  TranscriptTrack,
} from "../types";
import { conflictKey } from "../types";

const CHANNEL_NAME = "sologsb-1007-editor-v2";
const TAB_ID = getTabId();

const FIELD_LABELS: Record<FieldKey, string> = {
  text: "正文",
  speakerId: "发言人",
  start: "开始时间码",
  end: "结束时间码",
  confidence: "置信度",
  flags: "校对标记",
  tagIds: "片段关联",
};

function statusText(status: "saved" | "saving" | "offline") {
  if (status === "saving") return "正在保存";
  if (status === "offline") return "离线草稿";
  return "已自动保存";
}

function parseTimedTranscript(input: string, trackName: string): TranscriptTrack {
  const blocks = input.trim().split(/\n\s*\n/);
  const segments: Segment[] = [];
  const srtPattern = /(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})/;
  const bracketPattern = /^\[?(\d{1,2}:\d{2}(?::\d{2})?)\]?\s*[-–]?\s*(.*)$/;

  const blankSegment = (start: number, end: number, text: string): Segment => ({
    id: uid("seg"),
    start,
    end,
    speakerId: text.match(/^([^：:]{1,10})[：:]/) ? "sp-custom" : "sp-interviewer",
    text: text.replace(/^[^：:]{1,10}[：:]\s*/, ""),
    confidence: 3,
    reviewed: false,
    flags: { lowConfidence: false, dialect: false, properNoun: false },
    tagIds: [],
    comments: [],
    meta: { fields: {}, reviewedAt: 0, reviewedBy: "", createdAt: Date.now() },
  });

  for (const rawBlock of blocks) {
    const lines = rawBlock.split("\n").map((line) => line.trim()).filter(Boolean);
    if (!lines.length) continue;
    const srtIndex = lines.findIndex((line) => srtPattern.test(line));
    if (srtIndex >= 0) {
      const match = srtPattern.exec(lines[srtIndex]);
      const text = lines.slice(srtIndex + 1).join(" ");
      segments.push(blankSegment(parseTime(match?.[1] ?? "0"), parseTime(match?.[2] ?? "1"), text));
      continue;
    }
    for (const line of lines) {
      const match = bracketPattern.exec(line);
      if (!match) continue;
      const start = parseTime(match[1]);
      const text = match[2];
      segments.push(blankSegment(start, start + Math.max(3, text.length / 5), text));
    }
  }

  if (!segments.length && input.trim()) {
    input.split("\n").map((line) => line.trim()).filter(Boolean).forEach((text, index) => {
      segments.push(blankSegment(index * 6, index * 6 + 5.4, text));
    });
  }

  return {
    id: uid("track"),
    name: trackName || "导入轨",
    language: "待识别",
    status: "待校对",
    segments,
  };
}

export default function OralHistoryEditor() {
  const loaded = loadProject();
  const [project, setProject] = createSignal<ProjectData>(loaded.project);
  const [revision, setRevision] = createSignal(loaded.revision);
  const [past, setPast] = createSignal<ProjectData[]>([]);
  const [future, setFuture] = createSignal<ProjectData[]>([]);
  const [selectedId, setSelectedId] = createSignal(
    loaded.project.tracks.find((track) => track.id === loaded.project.activeTrackId)?.segments[0]?.id
      ?? loaded.project.tracks[0]?.segments[0]?.id
      ?? "",
  );
  const [saveStatus, setSaveStatus] = createSignal<"saved" | "saving" | "offline">("saved");
  const [lastAction, setLastAction] = createSignal(loaded.migrated ? "旧草稿已升级为按片段合并的新结构" : "示例项目已就绪");
  const [conflicts, setConflicts] = createSignal<ConflictMap>(loadConflicts(TAB_ID));
  const [choices, setChoices] = createSignal<Record<string, number>>({});
  const [activeTab, setActiveTab] = createSignal(loaded.project.activeTrackId);
  const [online, setOnline] = createSignal(true);
  const [pendingCount, setPendingCount] = createSignal(0);
  const [helpOpen, setHelpOpen] = createSignal(false);
  const [commentDraft, setCommentDraft] = createSignal("");
  const [replyDrafts, setReplyDrafts] = createSignal<Record<string, string>>({});
  const [authorName, setAuthorName] = createSignal(getAuthor());
  const [trackFilter, setTrackFilter] = createSignal<"all" | "unreviewed" | "low">("all");
  let editorRef: HTMLTextAreaElement | undefined;
  let fileInputRef: HTMLInputElement | undefined;
  let saveTimer: number | undefined;
  let hydrated = false;
  let dirty = false;
  let offlineEdits = 0;

  const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(CHANNEL_NAME) : null;
  const activeTrack = createMemo(() => {
    const data = project();
    return data.tracks.find((track) => track.id === activeTab()) ?? data.tracks[0];
  });
  const activeSegment = createMemo(() => activeTrack()?.segments.find((item) => item.id === selectedId()) ?? null);

  const visibleSegments = createMemo(() => {
    const segments = activeTrack()?.segments ?? [];
    if (trackFilter() === "unreviewed") return segments.filter((segment) => !segment.reviewed);
    if (trackFilter() === "low") return segments.filter((segment) => segment.confidence <= 2 || segment.flags.lowConfidence);
    return segments;
  });
  const completedPercent = createMemo(() => {
    const segments = project().tracks.flatMap((track) => track.segments);
    if (!segments.length) return 0;
    return Math.round((segments.filter((segment) => segment.reviewed).length / segments.length) * 100);
  });
  const speakerById = (speakerId: string) =>
    project().speakers.find((speaker) => speaker.id === speakerId) ?? project().speakers[0];
  const tagById = (tagId: string) => project().tags.find((tag) => tag.id === tagId);

  const conflictList = createMemo(() => {
    const map = conflicts();
    return Object.keys(map)
      .sort()
      .map((key) => map[key])
      .filter((entry): entry is FieldConflict => Boolean(entry));
  });
  const conflictTrackCount = createMemo(() => {
    const set = new Set<string>();
    for (const item of conflictList()) set.add(item.trackId);
    return set;
  });
  const segmentConflictCount = (trackId: string, segmentId: string) =>
    conflictList().filter((item) => item.trackId === trackId && item.segmentId === segmentId).length;
  const activeSegmentConflicts = createMemo(() =>
    conflictList().filter((item) => item.trackId === activeTrack()?.id && item.segmentId === selectedId()));

  const commit = (label: string, mutate: (draft: ProjectData) => void) => {
    const current = project();
    const before = structuredClone(current);
    const draft = structuredClone(current);
    mutate(draft);
    draft.updatedAt = new Date().toISOString();
    const stamped = stampLocalEdits(before, draft, TAB_ID, authorName());
    batch(() => {
      setPast((items) => [...items.slice(-49), before]);
      setFuture([]);
      setProject(stamped);
      setRevision((value) => value + 1);
      setLastAction(label);
    });
    dirty = true;
    if (!online()) offlineEdits += 1;
  };

  const commitSegment = (label: string, mutate: (segment: Segment, draft: ProjectData) => void) => {
    const id = selectedId();
    commit(label, (draft) => {
      const track = draft.tracks.find((item) => item.id === activeTab());
      const segment = track?.segments.find((item) => item.id === id);
      if (segment) mutate(segment, draft);
    });
  };

  const undo = () => {
    const stack = past();
    if (!stack.length) return;
    const previous = stack[stack.length - 1];
    setFuture((items) => [structuredClone(project()), ...items].slice(0, 50));
    setPast(stack.slice(0, -1));
    setProject(previous);
    setRevision((value) => value + 1);
    setLastAction("已撤销上一步");
    dirty = true;
    if (!online()) offlineEdits += 1;
  };

  const redo = () => {
    const stack = future();
    if (!stack.length) return;
    const next = stack[0];
    setPast((items) => [...items.slice(-49), structuredClone(project())]);
    setFuture(stack.slice(1));
    setProject(next);
    setRevision((value) => value + 1);
    setLastAction("已重做");
    dirty = true;
    if (!online()) offlineEdits += 1;
  };

  const switchTrack = (trackId: string) => {
    setActiveTab(trackId);
    setSelectedId(project().tracks.find((track) => track.id === trackId)?.segments[0]?.id ?? "");
    setLastAction("切换文本轨");
  };

  const moveSelection = (direction: 1 | -1) => {
    const segments = activeTrack()?.segments ?? [];
    if (!segments.length) return;
    const index = Math.max(0, segments.findIndex((segment) => segment.id === selectedId()));
    const nextIndex = (index + direction + segments.length) % segments.length;
    setSelectedId(segments[nextIndex].id);
    document.getElementById(`segment-${segments[nextIndex].id}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  };

  const splitSelection = () => {
    const segment = activeSegment();
    if (!segment || segment.text.trim().length < 2) return;
    const cursor = editorRef?.selectionStart ?? Math.floor(segment.text.length / 2);
    const safeCursor = Math.max(1, Math.min(cursor, segment.text.length - 1));
    const firstText = segment.text.slice(0, safeCursor).trim();
    const secondText = segment.text.slice(safeCursor).trim();
    if (!firstText || !secondText) return;
    const ratio = firstText.length / segment.text.length;
    const boundary = segment.start + (segment.end - segment.start) * ratio;
    const secondId = uid("seg");
    commitSegment("拆分片段", (current, draft) => {
      const original = structuredClone(current);
      current.text = firstText;
      current.end = Number(boundary.toFixed(1));
      const trackIndex = draft.tracks.findIndex((track) => track.id === activeTab());
      if (trackIndex >= 0) {
        const segmentIndex = draft.tracks[trackIndex].segments.findIndex((item) => item.id === current.id);
        draft.tracks[trackIndex].segments.splice(segmentIndex + 1, 0, {
          ...original,
          id: secondId,
          start: Number(boundary.toFixed(1)),
          text: secondText,
          reviewed: false,
          comments: [],
          meta: { fields: {}, reviewedAt: 0, reviewedBy: "", createdAt: Date.now() },
        });
      }
      setSelectedId(secondId);
    });
  };

  const mergeWithNext = () => {
    const track = activeTrack();
    const segment = activeSegment();
    if (!track || !segment) return;
    const index = track.segments.findIndex((item) => item.id === segment.id);
    const next = track.segments[index + 1];
    if (!next) return;
    commitSegment("合并下一片段", (current, draft) => {
      current.text = `${current.text.trim()} ${next.text.trim()}`;
      current.end = next.end;
      current.tagIds = [...new Set([...current.tagIds, ...next.tagIds])];
      current.comments.push(...next.comments);
      current.confidence = Math.min(current.confidence, next.confidence) as Confidence;
      const sourceTrack = draft.tracks.find((item) => item.id === activeTab());
      sourceTrack?.segments.splice(index + 1, 1);
      current.reviewed = false;
    });
  };

  const toggleFlag = (flag: keyof Segment["flags"]) => {
    commitSegment("修改校对标记", (segment) => {
      segment.flags[flag] = !segment.flags[flag];
      segment.reviewed = false;
    });
  };

  const setConfidence = (confidence: Confidence) => {
    commitSegment("校正置信度", (segment) => {
      segment.confidence = confidence;
      segment.flags.lowConfidence = confidence <= 2;
      segment.reviewed = false;
    });
  };

  const addComment = () => {
    const body = commentDraft().trim();
    if (!body) return;
    commitSegment("添加批注", (segment) => {
      segment.comments.unshift({
        id: uid("comment"),
        author: authorName(),
        body,
        createdAt: new Date().toISOString(),
        resolved: false,
        resolvedAt: 0,
        replies: [],
      });
      segment.reviewed = false;
    });
    setCommentDraft("");
  };

  const addReply = (commentId: string) => {
    const body = (replyDrafts()[commentId] ?? "").trim();
    if (!body) return;
    commitSegment("回复批注", (segment) => {
      const comment = segment.comments.find((item) => item.id === commentId);
      comment?.replies.push({
        id: uid("reply"),
        author: authorName(),
        body,
        createdAt: new Date().toISOString(),
      });
    });
    setReplyDrafts((drafts) => ({ ...drafts, [commentId]: "" }));
  };

  const toggleComment = (commentId: string) => {
    commitSegment("更新批注状态", (segment) => {
      const comment = segment.comments.find((item) => item.id === commentId);
      if (comment) {
        comment.resolved = !comment.resolved;
        comment.resolvedAt = comment.resolved ? Date.now() : 0;
      }
    });
  };

  const toggleTag = (tagId: string) => {
    commitSegment("更新主题关联", (segment) => {
      segment.tagIds = segment.tagIds.includes(tagId)
        ? segment.tagIds.filter((id) => id !== tagId)
        : [...segment.tagIds, tagId];
      segment.reviewed = false;
    });
  };

  const exportSrt = () => {
    const lines = activeTrack().segments.map((segment, index) => {
      const speaker = speakerById(segment.speakerId)?.name ?? "未知";
      return `${index + 1}\n${formatTime(segment.start)} --> ${formatTime(segment.end)}\n${speaker}：${segment.text}\n`;
    });
    downloadText(`${project().title}-${activeTrack().name}.srt`, lines.join("\n"), "application/x-subrip;charset=utf-8");
  };

  const importFile = async (file: File) => {
    const text = await file.text();
    const imported = parseTimedTranscript(text, file.name.replace(/\.[^.]+$/, ""));
    if (!imported.segments.length) {
      setLastAction("未识别到带时间码的文本");
      return;
    }
    commit("导入转写文本", (draft) => {
      draft.tracks.push(imported);
      draft.activeTrackId = imported.id;
      setActiveTab(imported.id);
      setSelectedId(imported.segments[0].id);
    });
  };

  /* ---------------------------------------------------------------- */
  /* Cross-tab merge ingestion                                        */
  /* ---------------------------------------------------------------- */

  const ingestEnvelope = (incoming: PersistedEnvelope) => {
    if (incoming.tabId === TAB_ID) return;
    if (incoming.schema !== 2 || !incoming.project?.tracks?.length) return;
    // Vector comparison — not the page-wide revision — decides what merges.

    const before = project();
    const { project: merged, conflicts: nextConflicts } = mergeProjects(
      before,
      incoming.project,
      { tabId: TAB_ID, author: authorName() },
      conflicts(),
    );

    const changed = !sameFieldValue(before, merged);
    const conflictKeysBefore = Object.keys(conflicts()).sort().join("|");
    const conflictKeysAfter = Object.keys(nextConflicts).sort().join("|");
    if (!changed && conflictKeysBefore === conflictKeysAfter) return;

    const resolvedAway = conflictKeysBefore.split("|").filter((key) => key && !nextConflicts[key]).length;
    const appeared = conflictKeysAfter.split("|").filter((key) => key && !conflicts()[key]).length;

    batch(() => {
      setProject(merged);
      setConflicts(nextConflicts);
      saveConflicts(TAB_ID, nextConflicts);
      if (changed) {
        if (appeared) setLastAction(`已自动合并「${incoming.author}」的修改，${appeared} 处字段待裁定`);
        else if (resolvedAway) setLastAction(`已合并「${incoming.author}」的修改，${resolvedAway} 处冲突已解决`);
        else setLastAction(`已自动合并「${incoming.author}」在其他片段的修改`);
      }
    });

    // Persist the merged result immediately so a third tab converges too.
    window.clearTimeout(saveTimer);
    const envelope = saveProject(merged, revision() + 1, TAB_ID, authorName());
    setSaveStatus(online() ? "saved" : "offline");
    channel?.postMessage(envelope);
  };

  const pickConflict = (key: string, candidateIndex: number) => {
    setChoices((current) => ({ ...current, [key]: candidateIndex }));
  };

  const pickAllForSegment = (items: FieldConflict[], candidateIndex: number) => {
    setChoices((current) => {
      const next = { ...current };
      for (const item of items) {
        const max = item.candidates.length - 1;
        next[conflictKey(item.trackId, item.segmentId, item.field)] = Math.min(candidateIndex, max);
      }
      return next;
    });
  };

  const applyChoices = (items: FieldConflict[]) => {
    const unresolved = items.filter(
      (item) => choices()[conflictKey(item.trackId, item.segmentId, item.field)] === undefined,
    );
    if (unresolved.length) {
      setLastAction(`还有 ${unresolved.length} 处未选择，请逐项裁定`);
      return;
    }
    const selected = items.map((item) => ({
      conflict: item,
      candidateIndex: choices()[conflictKey(item.trackId, item.segmentId, item.field)],
    }));
    const nextProject = applyConflictChoices(project(), selected, TAB_ID);
    const removedKeys = new Set(items.map((item) => conflictKey(item.trackId, item.segmentId, item.field)));
    const remaining: ConflictMap = {};
    for (const [key, value] of Object.entries(conflicts())) {
      if (!removedKeys.has(key)) remaining[key] = value;
    }
    batch(() => {
      setPast((list) => [...list.slice(-49), structuredClone(project())]);
      setProject(nextProject);
      setRevision((value) => value + 1);
      setConflicts(remaining);
      setChoices((current) => {
        const next = { ...current };
        removedKeys.forEach((key) => delete next[key]);
        return next;
      });
      setLastAction(`已按逐项选择解决 ${selected.length} 处字段差异`);
    });
    saveConflicts(TAB_ID, remaining);
    dirty = true;
    if (!online()) offlineEdits += 1;
    window.clearTimeout(saveTimer);
    const envelope = saveProject(nextProject, revision(), TAB_ID, authorName());
    setSaveStatus(online() ? "saved" : "offline");
    channel?.postMessage(envelope);
  };

  onMount(() => {
    hydrated = true;
    const handleOnline = () => {
      setOnline(true);
      setSaveStatus("saving");
      // Re-submit edits made while offline and ask other tabs to resync.
      const envelope = saveProject(project(), revision(), TAB_ID, authorName());
      channel?.postMessage(envelope);
      channel?.postMessage({ type: "sync-request", from: TAB_ID, author: authorName() });
      setPendingCount(0);
      offlineEdits = 0;
      setLastAction("网络已恢复，离线修改已提交并重新同步");
      setSaveStatus("saved");
    };
    const handleOffline = () => {
      setOnline(false);
      setSaveStatus("offline");
    };
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== "sologsb-1007-project-v1" || !event.newValue) return;
      try {
        const incoming = JSON.parse(event.newValue) as PersistedEnvelope;
        ingestEnvelope(incoming);
      } catch {
        // Ignore unrelated or malformed storage events.
      }
    };
    const handleKeydown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const editing = target?.matches("input, textarea, select, [contenteditable='true']");
      const command = event.metaKey || event.ctrlKey;
      if (command && event.key.toLowerCase() === "z") {
        event.preventDefault();
        event.shiftKey ? redo() : undo();
        return;
      }
      if (command && event.key.toLowerCase() === "s") {
        event.preventDefault();
        window.clearTimeout(saveTimer);
        const envelope = saveProject(project(), revision(), TAB_ID, authorName());
        setSaveStatus(online() ? "saved" : "offline");
        setLastAction(online() ? "已保存本地草稿" : "已写入离线草稿，联网后提交");
        channel?.postMessage(envelope);
        dirty = false;
        return;
      }
      if (editing) return;
      if (event.key === "j" || event.key === "ArrowDown") {
        event.preventDefault();
        moveSelection(1);
      } else if (event.key === "k" || event.key === "ArrowUp") {
        event.preventDefault();
        moveSelection(-1);
      } else if (event.key.toLowerCase() === "m") {
        event.preventDefault();
        mergeWithNext();
      } else if (event.key.toLowerCase() === "r" && activeSegment()) {
        event.preventDefault();
        commitSegment("标记片段已校对", (segment) => { segment.reviewed = true; });
      } else if (event.key === "?" || (event.shiftKey && event.key === "/")) {
        event.preventDefault();
        setHelpOpen(true);
      }
    };
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    window.addEventListener("storage", handleStorage);
    window.addEventListener("keydown", handleKeydown);
    setOnline(navigator.onLine);
    setSaveStatus(navigator.onLine ? "saved" : "offline");
    onCleanup(() => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener("keydown", handleKeydown);
    });
  });

  channel?.addEventListener("message", (event: MessageEvent) => {
    const data = event.data as PersistedEnvelope | { type?: string; from?: string };
    if (data && typeof data === "object" && "type" in data && data.type === "sync-request") {
      // Another tab came back online; resend our latest envelope.
      if ((data as { from?: string }).from !== TAB_ID) {
        window.clearTimeout(saveTimer);
        const envelope = saveProject(project(), revision(), TAB_ID, authorName());
        channel?.postMessage(envelope);
      }
      return;
    }
    ingestEnvelope(data as PersistedEnvelope);
  });

  createEffect(() => {
    const current = project();
    const currentRevision = revision();
    if (!hydrated) return;
    setSaveStatus(online() ? "saving" : "offline");
    if (!online()) setPendingCount(offlineEdits);
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      const envelope = saveProject(current, currentRevision, TAB_ID, authorName());
      setSaveStatus(online() ? "saved" : "offline");
      if (online() && dirty) {
        channel?.postMessage(envelope);
        dirty = false;
      }
    }, 420);
  });

  onCleanup(() => {
    window.clearTimeout(saveTimer);
    channel?.close();
  });

  const clickSegment = (id: string) => {
    setSelectedId(id);
    queueMicrotask(() => editorRef?.focus());
  };

  const commitAuthor = () => {
    const trimmed = authorName().trim() || "校对员";
    setAuthorName(trimmed);
    setAuthor(trimmed);
    setLastAction("校对员身份已更新，后续修改会以此署名");
  };

  /* ---------------------------------------------------------------- */
  /* Conflict value rendering                                         */
  /* ---------------------------------------------------------------- */

  const speakerName = (id: string) => project().speakers.find((speaker) => speaker.id === id)?.name ?? id;
  const tagLabels = (ids: unknown) =>
    Array.isArray(ids) && ids.length
      ? (ids as string[]).map((id) => tagById(id)?.label ?? id).join("、")
      : "（无关联）";

  const candidateText = (candidate: ConflictCandidate, field: FieldKey): string => {
    const value = candidate.value;
    if (field === "text") return String(value ?? "");
    if (field === "speakerId") return speakerName(String(value));
    if (field === "start" || field === "end") return formatTime(Number(value));
    if (field === "confidence") return `${value} / 5`;
    if (field === "flags") {
      const flags = value as Segment["flags"];
      const parts: string[] = [];
      if (flags?.lowConfidence) parts.push("低置信词句");
      if (flags?.dialect) parts.push("方言表达");
      if (flags?.properNoun) parts.push("专有名词");
      return parts.length ? parts.join("、") : "无标记";
    }
    return tagLabels(value);
  };

  const isLocalCandidate = (candidate: ConflictCandidate) => candidate.tabId === TAB_ID;
  const candidateSource = (candidate: ConflictCandidate, index: number) =>
    isLocalCandidate(candidate) ? "本页修改" : candidate.author || `标签页 ${candidate.tabId.slice(-4)}`;

  return (
    <div class="app-shell">
      <Show when={conflictList().length}>
        <div class="conflict-banner" role="alert">
          <div>
            <strong>{conflictList().length} 处同片段字段差异待裁定</strong>
            <span>不同片段的修改已自动合并；同一片段的冲突保留了双方版本，请到片段右侧逐项选择，批注与回复均已保留。</span>
          </div>
          <div class="conflict-actions">
            <button class="btn btn-quiet" onClick={() => {
              const first = conflictList()[0];
              setActiveTab(first.trackId);
              setSelectedId(first.segmentId);
              document.getElementById(`segment-${first.segmentId}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
            }}>前往处理</button>
          </div>
        </div>
      </Show>

      <Show when={!online() && pendingCount() > 0}>
        <div class="offline-banner" role="status">
          <strong>离线中：{pendingCount()} 处修改已存入本地</strong>
          <span>恢复网络后会自动提交，并与其他校对员的片段自动合并。</span>
        </div>
      </Show>

      <header class="topbar">
        <div class="brand-mark" aria-hidden="true"><span>口述</span><b>1007</b></div>
        <div class="project-heading">
          <input
            aria-label="项目标题"
            value={project().title}
            onChange={(event) => commit("修改项目标题", (draft) => { draft.title = event.currentTarget.value; })}
          />
          <div class="project-meta">
            <span>{project().interviewee}</span>
            <span>{project().recordingDate}</span>
            <span class={`save-state ${saveStatus()}`}>{statusText(saveStatus())}</span>
          </div>
        </div>
        <div class="top-actions">
          <input
            class="author-input"
            aria-label="校对员署名"
            value={authorName()}
            onInput={(event) => setAuthorName(event.currentTarget.value)}
            onChange={commitAuthor}
            title="修改会以该署名记录来源与时间"
          />
          <span class={`network-chip ${online() ? "online" : "offline"}`}>{online() ? "在线" : "离线可编辑"}</span>
          <button class="icon-btn" title="撤销 Ctrl/Cmd+Z" disabled={!past().length} onClick={undo}>↶</button>
          <button class="icon-btn" title="重做 Ctrl/Cmd+Shift+Z" disabled={!future().length} onClick={redo}>↷</button>
          <button class="btn btn-quiet" onClick={() => setHelpOpen(true)}>快捷键 <kbd>?</kbd></button>
          <button class="btn btn-primary" onClick={exportSrt}>导出 SRT</button>
        </div>
      </header>

      <div class="workspace">
        <aside class="left-panel">
          <section class="panel-section overview-card">
            <div class="eyebrow">校对进度</div>
            <div class="progress-row">
              <strong>{completedPercent()}%</strong>
              <span>{project().tracks.flatMap((track) => track.segments).filter((segment) => segment.reviewed).length} / {project().tracks.flatMap((track) => track.segments).length} 片段</span>
            </div>
            <div class="progress-track"><i style={{ width: `${completedPercent()}%` }} /></div>
            <p>按片段自动保存来源、时间与版本；不同片段的修改直接合并，不再整页拦截。</p>
          </section>

          <section class="panel-section">
            <div class="section-title"><h2>文本轨道</h2><span>{project().tracks.length}</span></div>
            <div class="track-list">
              <For each={project().tracks}>
                {(track) => (
                  <button class={`track-card ${track.id === activeTab() ? "active" : ""}`} onClick={() => switchTrack(track.id)}>
                    <span class="track-icon">{track.language === "English" ? "EN" : track.language === "福州话转写" ? "方" : "普"}</span>
                    <span class="track-info"><strong>{track.name}</strong><small>{track.segments.length} 段 · {track.status}</small></span>
                    <span class="track-dot-wrap">
                      <Show when={conflictTrackCount().has(track.id)}>
                        <i class="track-conflict-badge">{conflictList().filter((item) => item.trackId === track.id).length}</i>
                      </Show>
                      <span class="track-dot" style={{ background: track.status === "已完成" ? "#15803d" : track.status === "校对中" ? "#d97706" : "#94a3b8" }} />
                    </span>
                  </button>
                )}
              </For>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".srt,.txt,.vtt"
              hidden
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                if (file) void importFile(file);
                event.currentTarget.value = "";
              }}
            />
            <button class="wide-action" onClick={() => fileInputRef?.click()}><span>＋</span> 导入带时间码文本</button>
            <div class="hint">支持 SRT / VTT / 每行 `[00:12] 文本`</div>
          </section>

          <section class="panel-section tag-summary">
            <div class="section-title"><h2>待裁定差异</h2><span>{conflictList().length}</span></div>
            <Show when={conflictList().length} fallback={<p>暂无同片段冲突。其他标签页修改不同片段时会静默合并。</p>}>
              <div class="conflict-jump-list">
                <For each={conflictList()}>
                  {(item) => {
                    const track = project().tracks.find((t) => t.id === item.trackId);
                    return (
                      <button
                        class="conflict-jump"
                        classList={{ current: item.trackId === activeTrack()?.id && item.segmentId === selectedId() }}
                        onClick={() => {
                          setActiveTab(item.trackId);
                          setSelectedId(item.segmentId);
                        }}
                      >
                        <b>{FIELD_LABELS[item.field]}</b>
                        <span>{track?.name} · {item.candidates.length} 个版本</span>
                      </button>
                    );
                  }}
                </For>
              </div>
            </Show>
          </section>
        </aside>

        <main class="transcript-panel">
          <div class="panel-toolbar">
            <div>
              <div class="eyebrow">当前轨道</div>
              <h1>{activeTrack().name}</h1>
            </div>
            <div class="filters" role="group" aria-label="片段筛选">
              <button class={trackFilter() === "all" ? "active" : ""} onClick={() => setTrackFilter("all")}>全部</button>
              <button class={trackFilter() === "unreviewed" ? "active" : ""} onClick={() => setTrackFilter("unreviewed")}>未校对</button>
              <button class={trackFilter() === "low" ? "active" : ""} onClick={() => setTrackFilter("low")}>低置信</button>
            </div>
          </div>

          <div class="transcript-list" role="listbox" aria-label="转写片段">
            <For each={visibleSegments()}>
              {(segment, index) => {
                const conflictCount = () => segmentConflictCount(activeTrack().id, segment.id);
                return (
                  <article
                    id={`segment-${segment.id}`}
                    role="option"
                    aria-selected={segment.id === selectedId()}
                    class={`segment-card ${segment.id === selectedId() ? "selected" : ""} ${segment.reviewed ? "reviewed" : ""} ${conflictCount() ? "has-conflict" : ""}`}
                    onClick={() => clickSegment(segment.id)}
                  >
                    <div class="segment-rail" style={{ background: speakerById(segment.speakerId)?.color ?? "#64748b" }} />
                    <div class="segment-time">
                      <span>{formatTime(segment.start, false)}</span>
                      <small>{formatTime(segment.end, false)}</small>
                    </div>
                    <div class="segment-body">
                      <div class="segment-meta">
                        <b>{speakerById(segment.speakerId)?.name ?? "未知发言人"}</b>
                        <span class={`confidence c${segment.confidence}`}>置信 {segment.confidence}/5</span>
                        <Show when={segment.flags.lowConfidence}><span class="pill alert">低置信</span></Show>
                        <Show when={segment.flags.dialect}><span class="pill dialect">方言</span></Show>
                        <Show when={segment.flags.properNoun}><span class="pill proper">专名</span></Show>
                        <Show when={segment.reviewed}><span class="pill done">✓ 已校对</span></Show>
                        <Show when={conflictCount()}>
                          <span class="pill conflict-pill">⚠ {conflictCount()} 处待裁定</span>
                        </Show>
                      </div>
                      <p>{segment.text}</p>
                      <div class="segment-tags">
                        <For each={segment.tagIds.map(tagById).filter(Boolean)}>
                          {(tag) => <span style={{ "--tag-color": tag!.color } as any}>#{tag!.label}</span>}
                        </For>
                      </div>
                      <Show when={segment.comments.length}>
                        <div class="segment-comment-hint">批注 {segment.comments.length} · 回复 {segment.comments.reduce((sum, comment) => sum + comment.replies.length, 0)}</div>
                      </Show>
                    </div>
                    <span class="segment-index">{index() + 1}</span>
                  </article>
                );
              }}
            </For>
            <Show when={!visibleSegments().length}>
              <div class="empty-state"><b>没有符合筛选条件的片段</b><span>切换到“全部”继续校对。</span></div>
            </Show>
          </div>
        </main>

        <aside class="inspector">
          <Show when={activeSegment()} fallback={<div class="empty-inspector"><b>选择一个片段</b><p>在中间列表点击片段后即可校正发言人、置信度、标记和批注。</p></div>}>
            {(segment) => (
              <Tabs defaultValue="correct" class="inspector-tabs">
                <Tabs.List class="tab-list">
                  <Tabs.Trigger value="correct">校对</Tabs.Trigger>
                  <Tabs.Trigger value="annotate">标注</Tabs.Trigger>
                  <Tabs.Trigger value="comments">批注 <span>{segment().comments.length}</span></Tabs.Trigger>
                </Tabs.List>

                <Tabs.Content value="correct" class="tab-content">
                  <For each={activeSegmentConflicts()}>
                    {(item) => (
                      <ConflictCard
                        item={item}
                        selectedIndex={choices()[conflictKey(item.trackId, item.segmentId, item.field)]}
                        onPick={(candidateIndex) => pickConflict(conflictKey(item.trackId, item.segmentId, item.field), candidateIndex)}
                        candidateText={(candidate) => candidateText(candidate, item.field)}
                        candidateSource={candidateSource}
                        isLocal={isLocalCandidate}
                      />
                    )}
                  </For>
                  <Show when={activeSegmentConflicts().length}>
                    <div class="conflict-bulk">
                      <button class="btn btn-quiet" onClick={() => pickAllForSegment(activeSegmentConflicts(), 0)}>全选本页版本</button>
                      <button class="btn btn-primary" onClick={() => applyChoices(activeSegmentConflicts())}>应用本片段选择</button>
                    </div>
                  </Show>

                  <div class="inspector-heading">
                    <div><span>片段 {activeTrack().segments.findIndex((item) => item.id === segment().id) + 1}</span><strong>{formatTime(segment().start, false)} — {formatTime(segment().end, false)}</strong></div>
                    <button class={`review-button ${segment().reviewed ? "done" : ""}`} onClick={() => commitSegment("标记片段已校对", (item) => { item.reviewed = true; })}>
                      {segment().reviewed ? "✓ 已校对" : "标记已校对"}
                    </button>
                  </div>

                  <label class="field-label" for="speaker-select">发言人</label>
                  <select
                    id="speaker-select"
                    value={segment().speakerId}
                    onChange={(event) => commitSegment("校正发言人", (item) => { item.speakerId = event.currentTarget.value; item.reviewed = false; })}
                  >
                    <For each={project().speakers}>{(speaker) => <option value={speaker.id}>{speaker.name} · {speaker.role}</option>}</For>
                  </select>
                  <FieldProvenance segment={segment()} field="speakerId" />

                  <div class="time-grid">
                    <label>开始<input type="text" value={formatTime(segment().start)} onChange={(event) => commitSegment("修改开始时间", (item) => { item.start = parseTime(event.currentTarget.value); })} /></label>
                    <label>结束<input type="text" value={formatTime(segment().end)} onChange={(event) => commitSegment("修改结束时间", (item) => { item.end = parseTime(event.currentTarget.value); })} /></label>
                  </div>
                  <FieldProvenance segment={segment()} field="start" />
                  <FieldProvenance segment={segment()} field="end" />

                  <label class="field-label" for="transcript-editor">转写文本</label>
                  <textarea
                    id="transcript-editor"
                    ref={editorRef}
                    rows="7"
                    value={segment().text}
                    onChange={(event) => commitSegment("校正转写文本", (item) => { item.text = event.currentTarget.value; item.reviewed = false; })}
                  />
                  <FieldProvenance segment={segment()} field="text" />
                  <div class="textarea-help">光标停在句中后点击“拆分”，系统会保留两侧时间码比例。</div>

                  <div class="field-label">置信度</div>
                  <div class="confidence-picker" role="radiogroup" aria-label="置信度">
                    <For each={[1, 2, 3, 4, 5] as Confidence[]}>
                      {(value) => <button class={segment().confidence === value ? "active" : ""} onClick={() => setConfidence(value)}>{value}</button>}
                    </For>
                  </div>
                  <FieldProvenance segment={segment()} field="confidence" />

                  <div class="field-label">校对标记</div>
                  <div class="flag-list">
                    <Checkbox checked={segment().flags.lowConfidence} onChange={() => toggleFlag("lowConfidence")} class="flag-row">
                      <Checkbox.Input />
                      <Checkbox.Control><Checkbox.Indicator>✓</Checkbox.Indicator></Checkbox.Control>
                      <Checkbox.Label>低置信词或句</Checkbox.Label>
                    </Checkbox>
                    <Checkbox checked={segment().flags.dialect} onChange={() => toggleFlag("dialect")} class="flag-row">
                      <Checkbox.Input />
                      <Checkbox.Control><Checkbox.Indicator>✓</Checkbox.Indicator></Checkbox.Control>
                      <Checkbox.Label>方言表达</Checkbox.Label>
                    </Checkbox>
                    <Checkbox checked={segment().flags.properNoun} onChange={() => toggleFlag("properNoun")} class="flag-row">
                      <Checkbox.Input />
                      <Checkbox.Control><Checkbox.Indicator>✓</Checkbox.Indicator></Checkbox.Control>
                      <Checkbox.Label>专有名词</Checkbox.Label>
                    </Checkbox>
                  </div>
                  <FieldProvenance segment={segment()} field="flags" />

                  <div class="split-actions">
                    <button onClick={splitSelection}>⌁ 按光标拆分</button>
                    <button disabled={activeTrack().segments.at(-1)?.id === segment().id} onClick={mergeWithNext}>合 合并下一段</button>
                  </div>
                </Tabs.Content>

                <Tabs.Content value="annotate" class="tab-content">
                  <For each={activeSegmentConflicts()}>
                    {(item) => (
                      <ConflictCard
                        item={item}
                        selectedIndex={choices()[conflictKey(item.trackId, item.segmentId, item.field)]}
                        onPick={(candidateIndex) => pickConflict(conflictKey(item.trackId, item.segmentId, item.field), candidateIndex)}
                        candidateText={(candidate) => candidateText(candidate, item.field)}
                        candidateSource={candidateSource}
                        isLocal={isLocalCandidate}
                      />
                    )}
                  </For>
                  <Show when={activeSegmentConflicts().length}>
                    <div class="conflict-bulk">
                      <button class="btn btn-quiet" onClick={() => pickAllForSegment(activeSegmentConflicts(), 0)}>全选本页版本</button>
                      <button class="btn btn-primary" onClick={() => applyChoices(activeSegmentConflicts())}>应用本片段选择</button>
                    </div>
                  </Show>
                  <div class="content-title"><h3>关联主题、事件与人物</h3><p>一个片段可关联多个实体；同一片段的关联若被两边同时改动，会保留两版供选择。</p></div>
                  <For each={project().tags}>
                    {(tag) => (
                      <button class={`tag-option ${segment().tagIds.includes(tag.id) ? "selected" : ""}`} onClick={() => toggleTag(tag.id)}>
                        <i style={{ background: tag.color }} />
                        <span><strong>#{tag.label}</strong><small>{tag.type === "topic" ? "主题" : tag.type === "event" ? "事件" : "人物"}</small></span>
                        <b>{segment().tagIds.includes(tag.id) ? "✓" : "＋"}</b>
                      </button>
                    )}
                  </For>
                  <FieldProvenance segment={segment()} field="tagIds" />
                </Tabs.Content>

                <Tabs.Content value="comments" class="tab-content comments-content">
                  <div class="content-title"><h3>批注与回复</h3><p>批注按原片段随合并保留，多人回复按条目并集，绝不丢失。</p></div>
                  <div class="comment-compose">
                    <textarea rows="3" placeholder="记录读音、词义或专名依据…" value={commentDraft()} onInput={(event) => setCommentDraft(event.currentTarget.value)} />
                    <button class="btn btn-primary" onClick={addComment}>添加批注</button>
                  </div>
                  <For each={segment().comments} fallback={<div class="mini-empty">当前片段还没有批注。</div>}>
                    {(comment) => (
                      <article class={`comment-card ${comment.resolved ? "resolved" : ""}`}>
                        <header><strong>{comment.author}</strong><time>{new Date(comment.createdAt).toLocaleString()}</time></header>
                        <p>{comment.body}</p>
                        <For each={comment.replies}>
                          {(reply) => <div class="reply"><b>{reply.author}</b><span>{reply.body}</span></div>}
                        </For>
                        <div class="reply-row">
                          <input
                            value={replyDrafts()[comment.id] ?? ""}
                            placeholder="回复…"
                            onInput={(event) => setReplyDrafts((drafts) => ({ ...drafts, [comment.id]: event.currentTarget.value }))}
                            onKeyDown={(event) => { if (event.key === "Enter") addReply(comment.id); }}
                          />
                          <button onClick={() => addReply(comment.id)}>回复</button>
                        </div>
                        <button class="resolve-link" onClick={() => toggleComment(comment.id)}>{comment.resolved ? "重新打开" : "标记已解决"}</button>
                      </article>
                    )}
                  </For>
                </Tabs.Content>
              </Tabs>
            )}
          </Show>
        </aside>
      </div>

      <footer class="statusbar">
        <span>最近操作：{lastAction()}</span>
        <span>版本 {revision() + 1} · 片段级合并{conflictList().length ? ` · 待裁定 ${conflictList().length}` : ""}</span>
        <span class="status-shortcuts">J/K 浏览　R 已校对　M 合并　? 帮助</span>
      </footer>

      <Dialog open={helpOpen()} onOpenChange={setHelpOpen}>
        <Dialog.Portal>
          <Dialog.Overlay class="dialog-overlay" />
          <Dialog.Content class="dialog-content">
            <Dialog.Title>键盘校对</Dialog.Title>
            <Dialog.Description>光标在输入框中时，单键快捷键不会抢占文字输入。</Dialog.Description>
            <div class="shortcut-grid">
              <span><kbd>J</kbd><kbd>↓</kbd> 下一片段</span>
              <span><kbd>K</kbd><kbd>↑</kbd> 上一片段</span>
              <span><kbd>R</kbd> 标记已校对</span>
              <span><kbd>M</kbd> 合并下一片段</span>
              <span><kbd>Ctrl/⌘ Z</kbd> 撤销</span>
              <span><kbd>Ctrl/⌘ ⇧ Z</kbd> 重做</span>
              <span><kbd>Ctrl/⌘ S</kbd> 立即保存</span>
              <span><kbd>?</kbd> 显示本帮助</span>
            </div>
            <div class="dialog-footer"><button class="btn btn-primary" onClick={() => setHelpOpen(false)}>开始校对</button></div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Small components                                                   */
/* ------------------------------------------------------------------ */

function FieldProvenance(props: { segment: Segment; field: FieldKey }) {
  const meta = () => props.segment.meta?.fields[props.field];
  const tabTag = (tabId: string) => {
    if (tabId === TAB_ID) return "本页";
    if (tabId === "legacy-draft") return "旧草稿";
    if (tabId === "seed-project") return "示例";
    return `标签页 ${tabId.slice(-4)}`;
  };
  return (
    <Show when={meta()}>
      {(m) => (
        <div class="field-provenance">
          来源：{m().originAuthor || "未知校对员"}（{tabTag(m().originTab)}） · {new Date(m().updatedAt).toLocaleString()}
        </div>
      )}
    </Show>
  );
}

function ConflictCard(props: {
  item: FieldConflict;
  selectedIndex: number | undefined;
  onPick: (candidateIndex: number) => void;
  candidateText: (candidate: ConflictCandidate) => string;
  candidateSource: (candidate: ConflictCandidate, index: number) => string;
  isLocal: (candidate: ConflictCandidate) => boolean;
}) {
  const diffParts = createMemo(() => {
    if (props.item.field !== "text" || props.item.candidates.length < 2) return null;
    return charDiff(props.candidateText(props.item.candidates[0]), props.candidateText(props.item.candidates[1]));
  });
  return (
    <section class="conflict-card" role="group" aria-label={`${FIELD_LABELS[props.item.field]}冲突`}>
      <header>
        <b>{FIELD_LABELS[props.item.field]}存在差异</b>
        <small>{props.item.candidates.length} 个版本 · 请逐项选择</small>
      </header>
      <For each={props.item.candidates}>
        {(candidate, index) => {
          const selected = () => props.selectedIndex === index();
          return (
            <button
              class={`conflict-option ${selected() ? "selected" : ""} ${props.isLocal(candidate) ? "local" : "remote"}`}
              onClick={() => props.onPick(index())}
              aria-pressed={selected()}
            >
              <span class="conflict-option-head">
                <i class="conflict-radio" aria-hidden="true" />
                <b>{props.candidateSource(candidate, index())}</b>
                <time>{new Date(candidate.updatedAt).toLocaleString()}</time>
              </span>
              <Show
                when={diffParts() && index() <= 1}
                fallback={<span class="conflict-value">{props.candidateText(candidate)}</span>}
              >
                <span class="conflict-diff">
                  <For each={diffParts()!}>
                    {(part) => (
                      <span
                        classList={{
                          "diff-del": index() === 0 && part.local && !part.incoming,
                          "diff-ins": index() === 1 && part.incoming && !part.local,
                        }}
                      >
                        {part.text}
                      </span>
                    )}
                  </For>
                </span>
              </Show>
            </button>
          );
        }}
      </For>
    </section>
  );
}
