import { createSeedProject } from "./data";
import { MERGE_FIELDS } from "./merge";
import type {
  ConflictMap,
  LegacyEnvelope,
  PersistedEnvelope,
  ProjectData,
  Segment,
} from "./types";

export const STORAGE_KEY = "sologsb-1007-project-v1";
export const SESSION_KEY = "sologsb-1007-session";
export const AUTHOR_KEY = "sologsb-1007-author";

const idSuffix = () => Math.random().toString(36).slice(2, 8);

/** Tab id lives in sessionStorage so refreshes within the same tab keep their vector branch. */
export function getTabId(): string {
  if (typeof sessionStorage === "undefined") return `tab-${idSuffix()}`;
  let id = sessionStorage.getItem(SESSION_KEY);
  if (!id) {
    id = `tab-${Date.now().toString(36)}-${idSuffix()}`;
    sessionStorage.setItem(SESSION_KEY, id);
  }
  return id;
}

export function getAuthor(): string {
  if (typeof localStorage === "undefined") return "校对员";
  return localStorage.getItem(AUTHOR_KEY)?.trim() || "校对员";
}

export function setAuthor(name: string) {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(AUTHOR_KEY, name.trim() || "校对员");
}

const conflictStorageKey = (tabId: string) => `sologsb-1007-conflicts-${tabId}`;

export function loadConflicts(tabId: string): ConflictMap {
  if (typeof localStorage === "undefined") return {};
  try {
    return JSON.parse(localStorage.getItem(conflictStorageKey(tabId)) ?? "{}") as ConflictMap;
  } catch {
    return {};
  }
}

export function saveConflicts(tabId: string, conflicts: ConflictMap) {
  if (typeof localStorage === "undefined") return;
  const key = conflictStorageKey(tabId);
  if (Object.keys(conflicts).length) localStorage.setItem(key, JSON.stringify(conflicts));
  else localStorage.removeItem(key);
}

/* ------------------------------------------------------------------ */
/* Legacy migration: whole-page schema 1 -> per-field schema 2        */
/* ------------------------------------------------------------------ */

function migrateProject(project: ProjectData): ProjectData {
  const stamp = Date.now();
  for (const track of project.tracks) {
    for (const segment of track.segments) {
      if (segment.meta?.fields) continue;
      const fields = {} as Segment["meta"]["fields"];
      for (const field of MERGE_FIELDS) {
        fields[field] = {
          vector: { legacy: 1 },
          originTab: "legacy-draft",
          originAuthor: "旧草稿",
          updatedAt: stamp,
        };
      }
      segment.meta = { fields, reviewedAt: 0, reviewedBy: "", createdAt: stamp };
      for (const comment of segment.comments) comment.resolvedAt ??= 0;
    }
  }
  return project;
}

export interface LoadResult {
  project: ProjectData;
  revision: number;
  migrated: boolean;
}

export function loadProject(): LoadResult {
  if (typeof localStorage === "undefined") {
    return { project: createSeedProject(), revision: 0, migrated: false };
  }
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "") as
      | PersistedEnvelope
      | LegacyEnvelope
      | null;
    if (parsed?.project?.tracks?.length) {
      const migrated = parsed.schema !== 2;
      return {
        project: migrateProject(structuredClone(parsed.project)),
        revision: parsed.revision ?? 0,
        migrated,
      };
    }
  } catch {
    // A malformed local draft falls back to the bundled sample.
  }
  return { project: createSeedProject(), revision: 0, migrated: false };
}

export function saveProject(project: ProjectData, revision: number, tabId: string, author: string) {
  const envelope: PersistedEnvelope = {
    schema: 2,
    revision,
    tabId,
    author,
    savedAt: Date.now(),
    project,
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(envelope));
  return envelope;
}

export function readEnvelope(): PersistedEnvelope | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "") as PersistedEnvelope | null;
    return parsed?.schema === 2 ? parsed : null;
  } catch {
    return null;
  }
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
