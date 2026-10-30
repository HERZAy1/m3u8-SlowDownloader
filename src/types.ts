/** 一个分片在播放列表中的静态描述。 */
export interface Segment {
  /** 1-based 序号，与落盘文件名一致。 */
  index: number;
  /** 绝对 URL（已相对播放列表地址解析）。 */
  uri: string;
  /** #EXTINF 时长，单位秒。 */
  duration: number;
  /** 该分片前是否有 #EXT-X-DISCONTINUITY。 */
  discontinuity: boolean;
}

/** 解析后的媒体播放列表。 */
export interface Playlist {
  segments: Segment[];
  totalDuration: number;
  /** 是否带 #EXT-X-ENDLIST（静态点播）。 */
  isVod: boolean;
  discontinuityCount: number;
}

export interface HttpRequestOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * HTTP 层的唯一抽象。
 *
 * 调度器只依赖本接口，不 import 任何具体 HTTP 实现——这是将来把
 * fetch 换成 curl-impersonate / got-scraping 而不动调度逻辑的保证。
 */
export interface HttpClient {
  get(url: string, opts?: HttpRequestOptions): Promise<Buffer>;
}

export class HttpError extends Error {
  status: number;
  url: string;

  constructor(status: number, url: string) {
    super(`HTTP ${status} ${url}`);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
  }
}

export type TaskPhase =
  | 'idle'
  | 'parsing'
  | 'downloading'
  | 'merging'
  | 'remuxing'
  | 'done'
  | 'cancelled'
  | 'failed';

export interface ProgressSnapshot {
  phase: TaskPhase;
  /** 当前处理到的分片序号。 */
  index: number;
  /** 本次任务的总分片数（受 --limit 影响）。 */
  total: number;
  /** 已成功落盘的分片数。 */
  completed: number;
  failedCount: number;
  bytes: number;
  /** 扣除暂停时间后的已用时。 */
  elapsedMs: number;
  /** 预计剩余时间。 */
  etaMs: number;
  speed: number;
}

export type TaskEvent =
  | { type: 'phase'; phase: TaskPhase }
  | { type: 'playlist'; total: number; totalDuration: number; discontinuities: number; isVod: boolean }
  | { type: 'progress'; snapshot: ProgressSnapshot }
  | {
      type: 'segment';
      index: number;
      ok: boolean;
      bytes: number;
      attempts: number;
      duration: number;
      plannedAt: number;
      startedAt: number;
      finishedAt: number;
    }
  | { type: 'error'; index: number; message: string; attempt: number }
  | { type: 'log'; message: string }
  | { type: 'done'; failed: number[]; outputPath: string | null; elapsedMs: number; bytes: number };

/* ---------------- 队列 ---------------- */

export type QueueStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';

export interface QueueItemSnapshot {
  id: string;
  url: string;
  status: QueueStatus;
  /** 输出目录名，用于下载 / 清理时定位 */
  taskName: string;
  /** 用户备注名；有值时队列显示名与目录名都用它 */
  note?: string;
  total: number;
  downloaded: number;
  failed: number[];
  bytes: number;
  elapsedMs: number;
  outputPath: string | null;
  /** 探测到的播放列表总时长（秒），未知为 null */
  durationSec: number | null;
  /** 按该任务倍速估算的耗时（毫秒），未知为 null */
  estimateMs: number | null;
  error?: string;
  addedAt: number;
  startedAt?: number;
  finishedAt?: number;
}

/** 磁盘上一个任务留下的文件 */
export interface TaskFileInfo {
  id: string;
  name: string;
  path: string;
  segments: number;
  segmentBytes: number;
  outputBytes: number;
  totalBytes: number;
  startedAt: number | null;
  durationMs: number | null;
  hasOutput: boolean;
}

export interface QueueSummaryEntry extends QueueItemSnapshot {
  index: number;
}

export type QueueEvent =
  | { type: 'queue'; items: QueueItemSnapshot[]; runningId: string | null; paused: boolean }
  | { type: 'queue-done'; summary: QueueSummaryEntry[] };

/** SSE 上传输的所有事件：任务事件带 jobId，队列事件独立成组。 */
export type ServerEvent = (TaskEvent & { jobId?: string }) | QueueEvent;
