import { rename, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { FetchHttpClient } from './http.ts';
import { parsePlaylist } from './playlist.ts';
import { DownloadTask } from './task.ts';
import type {
  QueueItemSnapshot,
  QueueStatus,
  QueueSummaryEntry,
  ServerEvent,
  TaskEvent,
} from './types.ts';

export interface QueueParams {
  speed: number;
  jitterMs: number;
  retries: number;
  limit?: number;
  outDir?: string;
  remux: boolean;
  merge: boolean;
  /** 用户备注：填了就用它当目录名与显示名 */
  note?: string;
}

/** 把备注清洗成安全的目录名 */
export function sanitizeNote(input: string): string {
  const cleaned = input
    .trim()
    .replace(/[\\/:*?"<>|\r\n\t]/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, 60)
    .trim();
  if (cleaned === '.' || cleaned === '..') return '';
  return cleaned;
}

interface QueueItem {
  id: string;
  url: string;
  params: QueueParams;
  status: QueueStatus;
  taskName: string;
  outDir: string;
  /** 当前生效的备注名 */
  note?: string;
  /** 运行中改了备注时暂存，等任务结束后再改目录 */
  pendingNote?: string;
  addedAt: number;
  startedAt?: number;
  finishedAt?: number;
  total: number;
  downloaded: number;
  failed: number[];
  bytes: number;
  elapsedMs: number;
  outputPath: string | null;
  /** 播放列表总时长（秒），入队后异步探测 */
  durationSec: number | null;
  error?: string;
}

export function defaultOutDir(url: string): string {
  try {
    const parsed = new URL(url);
    const base = parsed.pathname.split('/').filter(Boolean).pop() ?? 'task';
    return `downloads/${base.replace(/\.m3u8?$/i, '') || 'task'}`;
  } catch {
    return 'downloads/task';
  }
}

/**
 * 顺序下载队列。
 *
 * - 逐个串行执行，前一个结束（成功或失败）才启动下一个
 * - 运行中允许继续追加或删除待处理项
 * - 全部结束后广播一次 queue-done，携带每个任务的成败与缺失分片
 */
export class DownloadQueue {
  readonly maxItems: number;
  private readonly emit: (event: ServerEvent) => void;
  private items: QueueItem[] = [];
  private seq = 0;
  private current: DownloadTask | null = null;
  private currentId: string | null = null;
  private loopRunning = false;
  private stopped = false;
  private paused = false;

  constructor(emit: (event: ServerEvent) => void, maxItems = 20) {
    this.emit = emit;
    this.maxItems = maxItems;
  }

  get size(): number {
    return this.items.length;
  }

  get runningId(): string | null {
    return this.currentId;
  }

  get isRunning(): boolean {
    return this.loopRunning;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  snapshot(): { items: QueueItemSnapshot[]; runningId: string | null; paused: boolean } {
    return { items: this.items.map(toSnapshot), runningId: this.currentId, paused: this.paused };
  }

  summary(): QueueSummaryEntry[] {
    return this.items.map((item, index) => ({ ...toSnapshot(item), index: index + 1 }));
  }

  outDirOf(id: string): string | null {
    return this.items.find((i) => i.id === id)?.outDir ?? null;
  }

  taskNameOf(id: string): string | null {
    return this.items.find((i) => i.id === id)?.taskName ?? null;
  }

  outputPathOf(id: string): string | null {
    return this.items.find((i) => i.id === id)?.outputPath ?? null;
  }

  /** 队列中所有任务的输出目录（绝对路径），供文件扫描使用。 */
  outDirs(): string[] {
    return this.items.map((i) => resolve(i.outDir));
  }

  async add(
    urls: string[],
    params: QueueParams,
  ): Promise<{ added: number; duplicates: number; overflow: number }> {
    let added = 0;
    let duplicates = 0;
    let overflow = 0;

    const baseNote = params.note ? sanitizeNote(params.note) : '';
    const targets = urls.map((u) => u.trim()).filter(Boolean);
    let batchIndex = 0;

    for (const url of targets) {
      if (this.items.length >= this.maxItems) {
        overflow += 1;
        continue;
      }
      const exists = this.items.some(
        (i) => i.url === url && (i.status === 'pending' || i.status === 'running'),
      );
      if (exists) {
        duplicates += 1;
        continue;
      }

      batchIndex += 1;
      this.seq += 1;

      let note: string | undefined;
      let outDir: string;

      if (baseNote) {
        const wanted = targets.length > 1 ? `${baseNote}-${batchIndex}` : baseNote;
        note = await this.uniqueName(wanted);
        outDir = `downloads/${note}`;
      } else {
        outDir = params.outDir && params.outDir.trim() ? params.outDir.trim() : defaultOutDir(url);
      }

      this.items.push({
        id: `q${this.seq}`,
        url,
        params: { ...params },
        status: 'pending',
        taskName: outDir.split(/[\\/]/).pop() || 'task',
        outDir,
        note,
        addedAt: Date.now(),
        total: 0,
        downloaded: 0,
        failed: [],
        bytes: 0,
        elapsedMs: 0,
        outputPath: null,
        durationSec: null,
      });
      added += 1;
      void this.probe(this.items[this.items.length - 1]);
    }

    this.publish();
    return { added, duplicates, overflow };
  }

  /** 找一个既不在磁盘上、也没被队列占用的目录名 */
  private async uniqueName(base: string): Promise<string> {
    let candidate = base;
    let n = 1;
    for (;;) {
      const dir = `downloads/${candidate}`;
      const onDisk = await stat(resolve(dir)).catch(() => null);
      const inQueue = this.items.some((i) => i.outDir === dir);
      if (!onDisk && !inQueue) return candidate;
      n += 1;
      candidate = `${base}-${n}`;
    }
  }

  /**
   * 修改备注名。
   * - 待处理：直接改目录（磁盘上还没有文件）
   * - 运行中：只改显示名，目录等任务结束再改（运行中改目录会让写入路径失效）
   * - 已完成/失败：立即重命名目录
   */
  async setNote(
    id: string,
    rawNote: string,
  ): Promise<{ ok: boolean; error?: string; note?: string }> {
    const item = this.items.find((i) => i.id === id);
    if (!item) return { ok: false, error: '没有这个任务' };

    const clean = sanitizeNote(rawNote);
    if (!clean) return { ok: false, error: '备注不能为空或包含非法字符' };
    if (clean === item.note) return { ok: true, note: clean };

    if (item.status === 'pending') {
      const unique = await this.uniqueName(clean);
      item.note = unique;
      item.taskName = unique;
      item.outDir = `downloads/${unique}`;
      this.publish();
      return { ok: true, note: unique };
    }

    if (item.status === 'running') {
      item.pendingNote = clean;
      item.note = clean;
      this.publish();
      return { ok: true, note: clean };
    }

    const result = await this.renameTaskDir(item, clean);
    this.publish();
    return result;
  }

  /** 把任务目录改名为 downloads/<name>，并同步 outDir / taskName / outputPath */
  private async renameTaskDir(
    item: QueueItem,
    name: string,
  ): Promise<{ ok: boolean; error?: string; note?: string }> {
    const unique = await this.uniqueName(name);
    const oldDir = resolve(item.outDir);
    const newDir = resolve(`downloads/${unique}`);

    if (oldDir !== newDir) {
      try {
        await rename(oldDir, newDir);
      } catch {
        return { ok: false, error: '重命名失败：目录可能不存在或被占用' };
      }
    }

    item.note = unique;
    item.taskName = unique;
    item.outDir = `downloads/${unique}`;

    if (item.outputPath) {
      const fileName = item.outputPath.split(/[\\/]/).pop() || 'output.ts';
      item.outputPath = join(newDir, fileName);
    }
    return { ok: true, note: unique };
  }

  /** 入队后探测播放列表总时长，用于队列总耗时估算；失败不影响下载。 */
  private async probe(item: QueueItem): Promise<void> {
    try {
      const client = new FetchHttpClient({}, 15_000);
      const text = (await client.get(item.url)).toString('utf8');
      const playlist = parsePlaylist(text, item.url);
      item.durationSec = playlist.totalDuration;
      this.publish();
    } catch {
      /* 探测失败就保持未知，不阻塞队列 */
    }
  }

  remove(id: string): { ok: boolean; reason?: string } {
    const index = this.items.findIndex((i) => i.id === id);
    if (index < 0) return { ok: false, reason: '没有这个任务' };
    if (this.items[index].status === 'running') return { ok: false, reason: '正在运行的任务不能删除' };
    this.items.splice(index, 1);
    this.publish();
    return { ok: true };
  }

  clearFinished(): number {
    const before = this.items.length;
    this.items = this.items.filter((i) => i.status === 'pending' || i.status === 'running');
    this.publish();
    return before - this.items.length;
  }

  /** 把失败/取消的项重置为待处理，复用它原有的 URL 与参数（fast 续传只会补缺失分片）。 */
  retry(id: string): boolean {
    const item = this.items.find((i) => i.id === id);
    if (!item) return false;
    if (item.status !== 'failed' && item.status !== 'cancelled') return false;
    this.reset(item);
    this.publish();
    return true;
  }

  /** 重置所有失败/取消的项，返回重置数量。 */
  retryAll(): number {
    let count = 0;
    for (const item of this.items) {
      if (item.status === 'failed' || item.status === 'cancelled') {
        this.reset(item);
        count += 1;
      }
    }
    if (count > 0) this.publish();
    return count;
  }

  private reset(item: QueueItem): void {
    item.status = 'pending';
    item.failed = [];
    item.downloaded = 0;
    item.total = 0;
    item.bytes = 0;
    item.elapsedMs = 0;
    item.outputPath = null;
    item.error = undefined;
    item.startedAt = undefined;
    item.finishedAt = undefined;
  }

  pause(): void {
    this.paused = true;
    this.current?.pause();
    this.publish();
  }

  resume(): void {
    this.paused = false;
    this.current?.resume();
    this.publish();
  }

  stop(): void {
    this.stopped = true;
    this.current?.cancel();
    this.publish();
  }

  async start(): Promise<void> {
    if (this.loopRunning) return;
    this.loopRunning = true;
    this.stopped = false;

    try {
      for (;;) {
        if (this.stopped) break;
        const next = this.items.find((i) => i.status === 'pending');
        if (!next) break;
        await this.runOne(next);
      }
    } finally {
      this.loopRunning = false;
      this.current = null;
      this.currentId = null;
      this.paused = false;
      this.publish();
      this.emit({ type: 'queue-done', summary: this.summary() });
    }
  }

  private async runOne(item: QueueItem): Promise<void> {
    item.status = 'running';
    item.startedAt = Date.now();
    this.currentId = item.id;
    this.publish();

    const task = new DownloadTask({
      url: item.url,
      outDir: item.outDir,
      speed: item.params.speed,
      jitterMs: item.params.jitterMs,
      retries: item.params.retries,
      limit: item.params.limit,
      remux: item.params.remux,
      merge: item.params.merge,
    });

    this.current = task;
    task.on((event: TaskEvent) => this.emit({ ...event, jobId: item.id }));

    try {
      const result = await task.run();
      item.total = result.total;
      item.downloaded = result.downloaded;
      item.failed = result.failed;
      item.bytes = result.bytes;
      item.elapsedMs = result.elapsedMs;
      item.outputPath = result.outputPath;
      item.status = result.failed.length > 0 ? 'failed' : 'done';
    } catch (err) {
      item.status = this.stopped ? 'cancelled' : 'failed';
      item.error = err instanceof Error ? err.message : String(err);
    }

    item.finishedAt = Date.now();

    // 运行中改过备注的话，等任务结束再把目录改名（运行中改会让写入路径失效）
    if (item.pendingNote) {
      const target = item.pendingNote;
      item.pendingNote = undefined;
      await this.renameTaskDir(item, target);
    }

    this.current = null;
    this.currentId = null;
    this.publish();
  }

  private publish(): void {
    const snap = this.snapshot();
    this.emit({ type: 'queue', items: snap.items, runningId: snap.runningId, paused: snap.paused });
  }
}

function toSnapshot(item: QueueItem): QueueItemSnapshot {
  return {
    id: item.id,
    url: item.url,
    status: item.status,
    taskName: item.taskName,
    note: item.note,
    total: item.total,
    downloaded: item.downloaded,
    failed: item.failed,
    bytes: item.bytes,
    elapsedMs: item.elapsedMs,
    outputPath: item.outputPath,
    durationSec: item.durationSec,
    estimateMs:
      item.durationSec !== null
        ? (item.durationSec * 1000) / Math.max(0.1, item.params.speed)
        : null,
    error: item.error,
    addedAt: item.addedAt,
    startedAt: item.startedAt,
    finishedAt: item.finishedAt,
  };
}
