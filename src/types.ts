export type Confidence = 1 | 2 | 3 | 4 | 5;

export type FieldKey =
  | "text"
  | "speakerId"
  | "start"
  | "end"
  | "confidence"
  | "flags"
  | "tagIds";

/** Per-tab counter vector used to order concurrent field edits. */
export type VersionVector = Record<string, number>;

export interface FieldMeta {
  vector: VersionVector;
  /** Tab id that produced the current value. */
  originTab: string;
  /** Proofreader name captured when the value was written. */
  originAuthor: string;
  updatedAt: number;
}

export interface SegmentMeta {
  fields: Partial<Record<FieldKey, FieldMeta>>;
  reviewedAt: number;
  reviewedBy: string;
  createdAt: number;
}

export interface Reply {
  id: string;
  author: string;
  body: string;
  createdAt: string;
}

export interface ReviewComment {
  id: string;
  author: string;
  body: string;
  createdAt: string;
  resolved: boolean;
  /** Epoch ms of the last resolve/reopen action; 0 for legacy drafts. */
  resolvedAt?: number;
  replies: Reply[];
}

export interface Speaker {
  id: string;
  name: string;
  role: string;
  color: string;
}

export interface Tag {
  id: string;
  label: string;
  type: "topic" | "event" | "person";
  color: string;
}

export interface Segment {
  id: string;
  start: number;
  end: number;
  speakerId: string;
  text: string;
  confidence: Confidence;
  reviewed: boolean;
  flags: {
    lowConfidence: boolean;
    dialect: boolean;
    properNoun: boolean;
  };
  tagIds: string[];
  comments: ReviewComment[];
  meta: SegmentMeta;
}

export interface TranscriptTrack {
  id: string;
  name: string;
  language: string;
  status: "待校对" | "校对中" | "已完成";
  segments: Segment[];
}

export interface ProjectData {
  id: string;
  title: string;
  interviewee: string;
  recordingDate: string;
  activeTrackId: string;
  speakers: Speaker[];
  tags: Tag[];
  tracks: TranscriptTrack[];
  updatedAt: string;
}

export interface PersistedEnvelope {
  schema: 2;
  revision: number;
  tabId: string;
  author: string;
  savedAt: number;
  project: ProjectData;
}

/** Old whole-page envelope; accepted once and migrated on open. */
export interface LegacyEnvelope {
  schema: 1;
  revision: number;
  tabId: string;
  savedAt: number;
  project: ProjectData;
}

export interface ConflictCandidate {
  tabId: string;
  author: string;
  updatedAt: number;
  value: unknown;
  vector: VersionVector;
}

export interface FieldConflict {
  trackId: string;
  segmentId: string;
  field: FieldKey;
  /** Local candidate is always first; further candidates come from other tabs. */
  candidates: ConflictCandidate[];
}

export type ConflictMap = Record<string, FieldConflict>;

export const conflictKey = (trackId: string, segmentId: string, field: FieldKey) =>
  `${trackId}/${segmentId}/${field}`;
