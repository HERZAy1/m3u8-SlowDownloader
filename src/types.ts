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

/** 只下载播放列表中的一段（1-based，含首含尾）。 */
export interface SegmentRange {
  start: number;
  end: number;
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
  | {
      type: 'playlist';
      total: number;
      totalDuration: number;
      discontinuities: number;
      isVod: boolean;
      /** 按需下载时的区间（未设置表示整条） */
      range?: SegmentRange;
      /** 整条播放列表的分片总数，便于界面显示「第 200–300 片 / 共 1074 片」 */
      playlistTotal?: number;
    }
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

/**
 * interrupted = 上次进程是异常退出（断电/崩溃），磁盘上还有分片，可以续传。
 * 与 cancelled 的区别：cancelled 是用户主动停的，interrupted 是没来得及停。
 */
export type QueueStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted';

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
  /** 剩余分片按当前倍速还需要多久（毫秒），未知为 null */
  remainingMs?: number | null;
  /** 按需下载的区间；undefined 表示整条视频 */
  range?: SegmentRange;
  /** 整条播放列表的分片数（按需下载时用于显示「第 a–b 片 / 共 N 片」） */
  playlistTotal?: number;
  error?: string;
  addedAt: number;
  startedAt?: number;
  finishedAt?: number;
  /** 这条记录是从磁盘扫描恢复回来的（不是本次手动添加的） */
  recovered?: boolean;
}

/** 磁盘扫描出的一个任务目录，用于断电后把任务找回来 */
export interface DiskTaskInfo {
  /** 绝对路径 */
  dir: string;
  /** 相对路径，形如 downloads/xxx */
  relDir: string;
  name: string;
  /** state.json 里记录的播放列表地址；老目录可能没有 */
  url: string;
  total: number;
  present: number;
  missing: number[];
  hasOutput: boolean;
  startedAt: number | null;
  elapsedMs: number;
  durationSec: number | null;
}

/** 磁盘上一个任务留下的文件 */
export interface TaskFileInfo {
  id: string;
  /** 目录名 */
  name: string;
  /** 用户备注（state.json 里记的），没有就是 undefined */
  note?: string;
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
