import { mkdir, readFile, rename, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { scanDiskTasks } from './disk.ts';
import type { DiskScan } from './disk.ts';
import { FetchHttpClient } from './http.ts';
import { parsePlaylist } from './playlist.ts';
import { writeAtomic } from './store.ts';
import { DownloadTask } from './task.ts';
import type {
  QueueItemSnapshot,
  QueueStatus,
  QueueSummaryEntry,
  SegmentRange,
  ServerEvent,
  TaskEvent,
} from './types.ts';

export interface QueueParams {
  speed: number;
  jitterMs: number;
  retries: number;
  limit?: number;
  /** 按需下载：只下 [start, end] 这一段（1-based，含首含尾） */
  range?: SegmentRange;
  outDir?: string;
  remux: boolean;
  merge: boolean;
  /** 用户备注：填了就用它当目录名与显示名 */
  note?: string;
}

export interface QueueConfig {
  /** 下载根目录（绝对路径），用于按 URL / 目录名找回断电前的任务 */
  downloadsDir: string;
  /** 队列存档文件（绝对路径） */
  stateFile: string;
  maxItems?: number;
}

export interface AddResult {
  added: number;
  duplicates: number;
  overflow: number;
  /** 复用了磁盘上已有目录（续传）的数量 */
  reused: number;
  /** 磁盘上已经是完整成品的数量（不下载，直接可下载） */
  completed: number;
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

/** 从 URL 猜一个任务名（= 老版本默认创建的目录名） */
function taskNameFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const base = parsed.pathname.split('/').filter(Boolean).pop() ?? 'task';
    return base.replace(/\.m3u8?$/i, '') || 'task';
  } catch {
    return 'task';
  }
}

/** 只比较去掉首尾空白后的完整地址：查询串可能带签名，不能丢 */
function sameUrl(a: string, b: string): boolean {
  return a.trim() === b.trim();
}

/** 两个区间是否等价（都为空也算等价：都是整片下载） */
function sameRange(a?: SegmentRange, b?: SegmentRange): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.start === b.start && a.end === b.end;
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
  /** 整条播放列表的分片数（按需下载时 total 只是区间长度） */
  playlistTotal?: number;
  error?: string;
  recovered?: boolean;
}

export function defaultOutDir(url: string): string {
  return `downloads/${taskNameFromUrl(url)}`;
}

/**
 * 顺序下载队列，带持久化与断电恢复。
 *
 * - 逐个串行执行，前一个结束（成功或失败）才启动下一个
 * - 运行中允许继续追加或删除待处理项
 * - 每次变更都把队列写进 stateFile；进程被 kill -9 或断电后，
 *   下次启动会读回来，并把当时在跑的任务标成「中断」
 * - 即使存档丢失，也会扫描磁盘上的任务目录把任务重新认领回来
 */
export class DownloadQueue {
  readonly maxItems: number;
  private readonly emit: (event: ServerEvent) => void;
  private readonly downloadsDir: string;
  private readonly stateFile: string;
  private items: QueueItem[] = [];
  private seq = 0;
  private current: DownloadTask | null = null;
  private currentId: string | null = null;
  private loopRunning = false;
  private stopped = false;
  private paused = false;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private persistInFlight = false;
  private persistQueued = false;

  constructor(emit: (event: ServerEvent) => void, config: QueueConfig) {
    this.emit = emit;
    this.downloadsDir = resolve(config.downloadsDir);
    this.stateFile = resolve(config.stateFile);
    this.maxItems = config.maxItems ?? 20;
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

  get interruptedCount(): number {
    return this.items.filter((i) => i.status === 'interrupted').length;
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

  /* ---------------- 启动恢复 ---------------- */

  /** 启动时调用：先读回存档，再扫磁盘补齐。 */
  async init(): Promise<{ restored: number; adopted: number; refreshed: number }> {
    const restored = await this.load();
    const { adopted, refreshed } = await this.recoverFromDisk();
    return { restored, adopted, refreshed };
  }

  /** 读回上次的队列存档；上次在跑的一律降级为「中断」。 */
  private async load(): Promise<number> {
    const raw = await readFile(this.stateFile, 'utf8').catch(() => null);
    if (!raw) return 0;

    let data: { seq?: number; items?: unknown };
    try {
      data = JSON.parse(raw) as { seq?: number; items?: unknown };
    } catch {
      return 0;
    }

    const list = Array.isArray(data.items) ? data.items : [];
    let restored = 0;

    for (const entry of list) {
      const item = reviveItem(entry);
      if (!item) continue;
      if (this.items.some((i) => i.id === item.id)) continue;

      if (item.status === 'running') {
        item.status = 'interrupted';
        item.error = '上次异常退出（断电或崩溃），已从磁盘恢复，可继续下载';
      }
      this.items.push(item);
      this.seq = Math.max(this.seq, idOf(item.id));
      restored += 1;
    }

    if (this.items.length > 0) this.publish();
    return restored;
  }

  /**
   * 扫描磁盘把任务认领回来。
   *
   * 这是断电恢复的兜底：队列存档丢了也能靠 playlist.m3u8 + segments/ 还原
   * 「哪个目录、属于哪个链接、还缺哪几片、成品在不在」。
   */
  async recoverFromDisk(): Promise<{ adopted: number; refreshed: number }> {
    const disk = await scanDiskTasks(this.downloadsDir);
    let adopted = 0;
    let refreshed = 0;

    for (const scan of disk) {
      const existing = this.items.find((i) => resolve(i.outDir) === scan.dir);
      if (existing) {
        if (existing.status === 'running') continue;
        if (this.refreshFromScan(existing, scan)) refreshed += 1;
        // 磁盘上的 state.json 也要跟着改口：不然断电后那份文件永远写着 running
        await this.syncStateFile(existing, scan);
        continue;
      }
      const item = this.itemFromScan(scan, scan.url, {
        speed: 2,
        jitterMs: 300,
        retries: 3,
        remux: false,
        merge: true,
      });
      item.recovered = true;
      if (!item.url) {
        item.error = '磁盘恢复：没有记录原始链接，续传前请先「绑定链接」';
      }
      this.items.push(item);
      adopted += 1;
      if (item.durationSec === null && item.url) void this.probe(item);
    }

    if (adopted > 0 || refreshed > 0) this.publish();
    return { adopted, refreshed };
  }

  /** 用磁盘现状刷新一条已有记录（分片数、缺口、成品）。 */
  private refreshFromScan(item: QueueItem, scan: DiskScan): boolean {
    let changed = false;
    const complete = scan.hasOutput && scan.missing.length === 0;

    if (scan.total > 0 && item.total !== scan.total) {
      item.total = scan.total;
      changed = true;
    }
    if (item.downloaded !== scan.present) {
      item.downloaded = scan.present;
      changed = true;
    }
    if (item.elapsedMs === 0 && scan.elapsedMs > 0) {
      item.elapsedMs = scan.elapsedMs;
      changed = true;
    }
    if (item.durationSec === null && scan.durationSec !== null) {
      item.durationSec = scan.durationSec;
      changed = true;
    }
    if (!item.url && scan.url) {
      item.url = scan.url;
      changed = true;
    }
    const outputPath = scan.hasOutput ? join(scan.dir, 'output.ts') : null;
    if (item.outputPath !== outputPath) {
      item.outputPath = outputPath;
      changed = true;
    }

    if (complete) {
      item.failed = [];
      if (item.status !== 'done') {
        item.status = 'done';
        item.finishedAt = item.finishedAt ?? Date.now();
        changed = true;
      }
    } else if (item.status === 'done' || item.status === 'interrupted' || item.status === 'pending') {
      if (item.status !== 'interrupted') {
        item.status = 'interrupted';
        if (!item.error) {
          item.error = '上次异常退出（断电或崩溃），已从磁盘恢复，可继续下载';
        }
        changed = true;
      }
      if (item.failed.length !== scan.missing.length) {
        item.failed = scan.missing;
        changed = true;
      }
    } else if (item.failed.length !== scan.missing.length) {
      item.failed = scan.missing;
      changed = true;
    }

    return changed;
  }

  /** 把队列里的判断结果写回磁盘的 state.json，让磁盘和界面说的是同一件事。 */
  private async syncStateFile(item: QueueItem, scan: DiskScan): Promise<void> {
    if (!scan.state) return;
    if (scan.state.status === item.status) return;
    try {
      await writeAtomic(
        join(scan.dir, 'state.json'),
        `${JSON.stringify(
          {
            ...scan.state,
            url: item.url || scan.state.url,
            note: item.note ?? scan.state.note,
            taskName: item.taskName,
            total: item.total,
            downloaded: item.downloaded,
            failed: item.failed,
            status: item.status,
            updatedAt: new Date().toISOString(),
          },
          null,
          2,
        )}\n`,
      );
    } catch {
      /* 写不进去也不影响内存里的状态 */
    }
  }

  private itemFromScan(scan: DiskScan, url: string, params: QueueParams): QueueItem {
    const complete = scan.hasOutput && scan.missing.length === 0;
    const state = scan.state;

    return {
      id: this.nextId(),
      url,
      params: {
        speed: typeof state?.speed === 'number' && state.speed > 0 ? state.speed : params.speed,
        jitterMs: typeof state?.jitterMs === 'number' ? state.jitterMs : params.jitterMs,
        retries: typeof state?.retries === 'number' ? state.retries : params.retries,
        limit: undefined,
        range: state?.range ?? params.range,
        remux: false,
        merge: state?.merge ?? params.merge,
      },
      status: complete ? 'done' : 'interrupted',
      taskName: scan.name,
      outDir: scan.relDir,
      note: scan.name,
      addedAt: scan.startedAt ?? Date.now(),
      startedAt: scan.startedAt ?? undefined,
      total: scan.total,
      downloaded: scan.present,
      failed: complete ? [] : scan.missing,
      bytes: 0,
      elapsedMs: scan.elapsedMs,
      outputPath: scan.hasOutput ? join(scan.dir, 'output.ts') : null,
      durationSec: scan.durationSec,
      playlistTotal: state?.playlistTotal,
    };
  }

  /** 把链接补进磁盘上的 state.json，下次断电也能靠它认回这个目录。 */
  private async stampState(item: QueueItem, note: string): Promise<void> {
    try {
      const dir = resolve(item.outDir);
      const path = join(dir, 'state.json');
      const existing = await readFile(path, 'utf8').catch(() => null);
      const base = existing ? (JSON.parse(existing) as Record<string, unknown>) : {};
      const merged = {
        version: 2,
        createdAt: new Date(item.addedAt).toISOString(),
        t0: item.addedAt,
        speed: item.params.speed,
        failed: [],
        ...base,
        url: item.url,
        note,
        taskName: item.taskName,
        total: item.total,
        status: 'interrupted',
        updatedAt: new Date().toISOString(),
      };
      await writeAtomic(path, `${JSON.stringify(merged, null, 2)}\n`);
    } catch {
      /* 补写失败不影响续传 */
    }
  }

  /* ---------------- 入队 ---------------- */

  private nextId(): string {
    this.seq += 1;
    return `q${this.seq}`;
  }

  async add(urls: string[], params: QueueParams): Promise<AddResult> {
    let added = 0;
    let duplicates = 0;
    let overflow = 0;
    let reused = 0;
    let completed = 0;

    const baseNote = params.note ? sanitizeNote(params.note) : '';
    const targets = urls.map((u) => u.trim()).filter(Boolean);
    const disk = await scanDiskTasks(this.downloadsDir);
    let batchIndex = 0;

    for (const url of targets) {
      if (this.items.length >= this.maxItems) {
        overflow += 1;
        continue;
      }

      const exists = this.items.some(
        (i) =>
          i.url &&
          sameUrl(i.url, url) &&
          sameRange(i.params.range, params.range) &&
          i.status !== 'cancelled',
      );
      if (exists) {
        duplicates += 1;
        continue;
      }

      batchIndex += 1;

      // 关键：磁盘上已经有这个链接的目录，就接管它续传，绝不新建目录重下
      const onDisk = this.findDisk(disk, url, params.range);
      if (onDisk) {
        const item = this.itemFromScan(onDisk, url, params);
        item.recovered = false;
        // 手动加入说明用户就想下它，直接排进队列；磁盘上已有的分片会被续传跳过
        if (item.status !== 'done') {
          item.status = 'pending';
          item.error = undefined;
        }

        if (baseNote && baseNote !== onDisk.name) {
          item.note = baseNote;
          this.items.push(item);
          const renamed = await this.renameTaskDir(item, baseNote);
          if (!renamed.ok) item.note = onDisk.name;
        } else {
          this.items.push(item);
        }

        await this.stampState(item, item.note ?? item.taskName);
        reused += 1;
        if (item.status === 'done') completed += 1;
        else {
          added += 1;
          void this.probe(item);
        }
        continue;
      }

      let note: string | undefined;
      let outDir: string;

      if (baseNote) {
        const wanted = targets.length > 1 ? `${baseNote}-${batchIndex}` : baseNote;
        note = await this.uniqueName(wanted);
        outDir = `downloads/${note}`;
      } else {
        // 按需下载的默认目录带区间后缀，避免与整片下载、其他区间互相覆盖
        const suffix = params.range ? `-${params.range.start}-${params.range.end}` : '';
        outDir =
          params.outDir && params.outDir.trim()
            ? params.outDir.trim()
            : `downloads/${taskNameFromUrl(url)}${suffix}`;
      }

      this.items.push({
        id: this.nextId(),
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
      void this.probe(this.items[this.items.length - 1] as QueueItem);
    }

    this.publish();
    return { added, duplicates, overflow, reused, completed };
  }

  /** 在磁盘扫描结果里找这个链接（且区间一致）对应的目录 */
  private findDisk(disk: DiskScan[], url: string, range?: SegmentRange): DiskScan | null {
    const claimed = (d: DiskScan): boolean => this.items.some((i) => resolve(i.outDir) === d.dir);
    const sameTask = (d: DiskScan): boolean => sameRange(d.state?.range, range);

    // 1) state.json 里记着同一个链接 —— 最可靠
    const byUrl = disk.find((d) => d.url && sameUrl(d.url, url) && sameTask(d) && !claimed(d));
    if (byUrl) return byUrl;

    // 2) 老目录没记链接（本功能之前建的），目录名又正好等于地址推导出的任务名
    const guess = taskNameFromUrl(url);
    const byName = disk.find((d) => !d.url && d.name === guess && sameTask(d) && !claimed(d));
    return byName ?? null;
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
   * - 待处理/中断：直接改目录（还没在写）
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

    if (item.status === 'pending' || item.status === 'interrupted') {
      const unique = await this.uniqueName(clean);
      const oldDir = resolve(item.outDir);
      const newDir = resolve(`downloads/${unique}`);
      if (oldDir !== newDir && (await stat(oldDir).catch(() => null))) {
        try {
          await rename(oldDir, newDir);
        } catch {
          return { ok: false, error: '重命名失败：目录可能被占用' };
        }
        if (item.outputPath) item.outputPath = join(newDir, basename(item.outputPath));
      }
      item.note = unique;
      item.taskName = unique;
      item.outDir = `downloads/${unique}`;
      await this.stampState(item, unique);
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

  /** 给从磁盘恢复出来、但没有原始链接的老任务补一个地址，好让它能续传。 */
  async attachUrl(id: string, rawUrl: string): Promise<{ ok: boolean; error?: string }> {
    const item = this.items.find((i) => i.id === id);
    if (!item) return { ok: false, error: '没有这个任务' };
    const url = rawUrl.trim();
    if (!url) return { ok: false, error: '地址不能为空' };

    item.url = url;
    item.error = undefined;
    await this.stampState(item, item.note ?? item.taskName);
    this.publish();
    return { ok: true };
  }

  /** 入队后探测播放列表总时长，用于队列总耗时估算；失败不影响下载。 */
  private async probe(item: QueueItem): Promise<void> {
    if (!item.url) return;
    try {
      const client = new FetchHttpClient({}, 15_000);
      const text = (await client.get(item.url)).toString('utf8');
      const playlist = parsePlaylist(text, item.url);
      const all = playlist.segments;
      item.playlistTotal = all.length;

      const range = item.params.range;
      if (range) {
        const from = Math.max(1, Math.min(range.start, all.length));
        const to = Math.max(from, Math.min(range.end, all.length));
        item.total = to - from + 1;
        item.durationSec = all.slice(from - 1, to).reduce((sum, seg) => sum + seg.duration, 0);
      } else {
        item.durationSec = playlist.totalDuration;
        if (item.total === 0) item.total = all.length;
      }
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
    this.items = this.items.filter(
      (i) => i.status === 'pending' || i.status === 'running' || i.status === 'interrupted',
    );
    this.publish();
    return before - this.items.length;
  }

  /** 把失败/取消/中断的项重置为待处理（fast 续传只会补缺失分片）。 */
  retry(id: string): { ok: boolean; error?: string } {
    const item = this.items.find((i) => i.id === id);
    if (!item) return { ok: false, error: '没有这个任务' };
    if (item.status !== 'failed' && item.status !== 'cancelled' && item.status !== 'interrupted') {
      return { ok: false, error: '只有失败、取消或中断的任务可以继续' };
    }
    if (!item.url) {
      return { ok: false, error: '这条记录没有原始链接，请先用「绑定链接」填入地址' };
    }
    this.reset(item, item.status === 'interrupted');
    this.publish();
    return { ok: true };
  }

  /** 重置所有失败/取消/中断的项，返回重置数量。 */
  retryAll(): number {
    let count = 0;
    for (const item of this.items) {
      if (
        (item.status === 'failed' || item.status === 'cancelled' || item.status === 'interrupted') &&
        item.url
      ) {
        this.reset(item, item.status === 'interrupted');
        count += 1;
      }
    }
    if (count > 0) this.publish();
    return count;
  }

  private reset(item: QueueItem, keepProgress = false): void {
    item.status = 'pending';
    item.failed = [];
    item.error = undefined;
    item.startedAt = undefined;
    item.finishedAt = undefined;
    item.elapsedMs = 0;
    item.outputPath = null;
    if (!keepProgress) {
      item.downloaded = 0;
      item.total = 0;
      item.bytes = 0;
    }
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
      await this.persistNow();
    }
  }

  private async runOne(item: QueueItem): Promise<void> {
    if (!item.url) {
      item.status = 'failed';
      item.error = '缺少播放列表地址，无法下载；请用「绑定链接」补上原地址';
      this.publish();
      return;
    }

    item.status = 'running';
    item.startedAt = Date.now();
    item.error = undefined;
    this.currentId = item.id;
    this.publish();

    const task = new DownloadTask({
      url: item.url,
      outDir: item.outDir,
      speed: item.params.speed,
      jitterMs: item.params.jitterMs,
      retries: item.params.retries,
      limit: item.params.limit,
      range: item.params.range,
      remux: item.params.remux,
      merge: item.params.merge,
      note: item.note,
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
      item.playlistTotal = result.playlistTotal;
      if (result.range) item.params.range = result.range;
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

  /* ---------------- 持久化 ---------------- */

  private publish(): void {
    const snap = this.snapshot();
    this.emit({ type: 'queue', items: snap.items, runningId: snap.runningId, paused: snap.paused });
    this.schedulePersist();
  }

  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persist();
    }, 400);
    this.persistTimer.unref?.();
  }

  async persistNow(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    await this.persist();
  }

  private async persist(): Promise<void> {
    if (this.persistInFlight) {
      this.persistQueued = true;
      return;
    }
    this.persistInFlight = true;
    try {
      await mkdir(dirname(this.stateFile), { recursive: true });
      const payload = {
        version: 1,
        savedAt: new Date().toISOString(),
        seq: this.seq,
        items: this.items,
      };
      await writeAtomic(this.stateFile, `${JSON.stringify(payload, null, 2)}\n`);
    } catch {
      /* 存档失败不该影响下载本身 */
    } finally {
      this.persistInFlight = false;
      if (this.persistQueued) {
        this.persistQueued = false;
        this.schedulePersist();
      }
    }
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
    range: item.params.range,
    playlistTotal: item.playlistTotal,
    estimateMs:
      item.durationSec !== null
        ? (item.durationSec * 1000) / Math.max(0.1, item.params.speed)
        : null,
    error: item.error,
    addedAt: item.addedAt,
    startedAt: item.startedAt,
    finishedAt: item.finishedAt,
    recovered: item.recovered,
  };
}

function idOf(id: string): number {
  const n = Number(id.replace(/[^0-9]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

/** 把存档里的 JSON 还原成队列项，字段缺失或类型不对就当这条作废 */
function reviveItem(raw: unknown): QueueItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const src = raw as Record<string, unknown>;
  const id = typeof src.id === 'string' ? src.id : '';
  const outDir = typeof src.outDir === 'string' ? src.outDir : '';
  if (!id || !outDir) return null;

  const status = src.status;
  const allowed: QueueStatus[] = ['pending', 'running', 'done', 'failed', 'cancelled', 'interrupted'];
  const params = (src.params ?? {}) as Record<string, unknown>;
  const rawRange = params.range as Record<string, unknown> | undefined;
  const range =
    rawRange && typeof rawRange.start === 'number' && typeof rawRange.end === 'number'
      ? { start: Math.trunc(rawRange.start), end: Math.trunc(rawRange.end) }
      : undefined;

  return {
    id,
    url: typeof src.url === 'string' ? src.url : '',
    params: {
      speed: typeof params.speed === 'number' && params.speed >= 0 ? params.speed : 2,
      jitterMs: typeof params.jitterMs === 'number' ? params.jitterMs : 300,
      retries: typeof params.retries === 'number' ? params.retries : 3,
      limit: typeof params.limit === 'number' ? params.limit : undefined,
      range,
      outDir: typeof params.outDir === 'string' ? params.outDir : undefined,
      remux: Boolean(params.remux),
      merge: params.merge !== false,
    },
    status: allowed.includes(status as QueueStatus) ? (status as QueueStatus) : 'pending',
    taskName: typeof src.taskName === 'string' ? src.taskName : basename(outDir),
    outDir,
    note: typeof src.note === 'string' ? src.note : undefined,
    pendingNote: undefined,
    addedAt: typeof src.addedAt === 'number' ? src.addedAt : Date.now(),
    startedAt: typeof src.startedAt === 'number' ? src.startedAt : undefined,
    finishedAt: typeof src.finishedAt === 'number' ? src.finishedAt : undefined,
    total: typeof src.total === 'number' ? src.total : 0,
    downloaded: typeof src.downloaded === 'number' ? src.downloaded : 0,
    failed: Array.isArray(src.failed) ? src.failed.filter((n): n is number => typeof n === 'number') : [],
    bytes: typeof src.bytes === 'number' ? src.bytes : 0,
    elapsedMs: typeof src.elapsedMs === 'number' ? src.elapsedMs : 0,
    outputPath: typeof src.outputPath === 'string' ? src.outputPath : null,
    durationSec: typeof src.durationSec === 'number' ? src.durationSec : null,
    playlistTotal: typeof src.playlistTotal === 'number' ? src.playlistTotal : undefined,
    error: typeof src.error === 'string' ? src.error : undefined,
    recovered: Boolean(src.recovered),
  };
}
