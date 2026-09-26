export type Confidence = 1 | 2 | 3 | 4 | 5;

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

/** 片段级来源信息：哪个标签页、何时、基于哪个版本修改了该片段。 */
export interface SegmentMeta {
  tabId: string;
  editedAt: number;
  version: number;
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
  savedAt: number;
  /** 断网期间写入、恢复网络后待提交的草稿标记。 */
  pendingSync?: boolean;
  project: ProjectData;
}

/** 旧版（schema 1）整页草稿，打开时迁移为片段级结构。 */
export interface LegacyEnvelopeV1 {
  schema: 1;
  revision: number;
  tabId: string;
  savedAt: number;
  project: ProjectData;
}

/** 参与冲突检测的片段字段：正文、发言人、时间码、置信度、标记、关联。 */
export type ConflictField = "text" | "speakerId" | "timecode" | "confidence" | "flags" | "tagIds";

export interface FieldConflict {
  trackId: string;
  segmentId: string;
  field: ConflictField;
  localValue: unknown;
  incomingValue: unknown;
  localMeta: SegmentMeta;
  incomingMeta: SegmentMeta;
}
