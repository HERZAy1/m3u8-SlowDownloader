import { spawn } from 'node:child_process';
import { basename, resolve } from 'node:path';
import { CancelledError, TaskControl } from './control.ts';
import { CHROME_HEADERS } from './headers.ts';
import { FetchHttpClient } from './http.ts';
import { mergeSegments } from './merge.ts';
import { parsePlaylist } from './playlist.ts';
import { runSchedule } from './scheduler.ts';
import { SegmentStore } from './store.ts';
import type { StateStatus, TaskStateFile } from './store.ts';
import type { HttpClient, Playlist, TaskEvent } from './types.ts';

export interface DownloadTaskOptions {
  url: string;
  outDir: string;
  /** 倍速，默认 2（决策 D2）；0 = 关闭节拍。 */
  speed?: number;
  jitterMs?: number;
  retries?: number;
  resume?: 'fast' | 'pace';
  /** 只处理前 N 片，调试用。 */
  limit?: number;
  merge?: boolean;
  remux?: boolean;
  dryRun?: boolean;
  /** 用户备注（= 目录名），只用于写进 state.json 供断电后恢复显示名 */
  note?: string;
  client?: HttpClient;
  headers?: Record<string, string>;
}

export interface RunResult {
  playlist: Playlist;
  total: number;
  downloaded: number;
  failed: number[];
  bytes: number;
  elapsedMs: number;
  outputPath: string | null;
}

/** 运行中多久落一次 state.json：太频繁会拖慢下载，太长则断电后丢失进度细节。 */
const STATE_SAVE_INTERVAL_MS = 5000;

export class DownloadTask {
  readonly control = new TaskControl();
  private readonly options: DownloadTaskOptions;
  private readonly listeners: Array<(event: TaskEvent) => void> = [];

  constructor(options: DownloadTaskOptions) {
    this.options = options;
  }

  on(listener: (event: TaskEvent) => void): void {
    this.listeners.push(listener);
  }

  private emit(event: TaskEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  pause(): void {
    this.control.pause();
  }

  resume(): void {
    this.control.resume();
  }

  cancel(): void {
    this.control.cancel();
  }

  async run(): Promise<RunResult> {
    const speed = this.options.speed ?? 2;
    const jitterMs = this.options.jitterMs ?? 300;
    const retries = this.options.retries ?? 3;
    const resumeMode = this.options.resume ?? 'fast';
    const shouldMerge = this.options.merge ?? true;
    const limit = this.options.limit ?? Number.POSITIVE_INFINITY;
    const startedAt = Date.now();

    const client = this.options.client ?? new FetchHttpClient(this.options.headers ?? { ...CHROME_HEADERS });

    this.emit({ type: 'phase', phase: 'parsing' });
    const text = (await client.get(this.options.url)).toString('utf8');
    const playlist = parsePlaylist(text, this.options.url);

    const segments = playlist.segments.slice(0, limit);
    const total = segments.length;
    const totalDuration = segments.reduce((sum, seg) => sum + seg.duration, 0);

    this.emit({
      type: 'playlist',
      total,
      totalDuration,
      discontinuities: playlist.discontinuityCount,
      isVod: playlist.isVod,
    });

    if (this.options.dryRun) {
      return {
        playlist,
        total,
        downloaded: 0,
        failed: [],
        bytes: 0,
        elapsedMs: Date.now() - startedAt,
        outputPath: null,
      };
    }

    const outDir = resolve(this.options.outDir);
    const store = new SegmentStore(outDir);
    await store.init();

    // 断电/崩溃可能留下半截分片，先清掉，免得被当成"已完成"混进成品
    const cleaned = await store.cleanupPartials();
    if (cleaned > 0) this.emit({ type: 'log', message: `清理了 ${cleaned} 个未写完的临时文件` });

    await store.savePlaylist(text);
    this.emit({ type: 'log', message: `输出目录：${outDir}` });

    // 一开跑就落一次状态：这样即使下一步就断电，磁盘上也已经记着"这个目录属于哪个链接"
    const stateBase: TaskStateFile = {
      version: 2,
      url: this.options.url,
      createdAt: new Date(startedAt).toISOString(),
      t0: startedAt,
      speed,
      total,
      failed: [],
      status: 'running',
      note: this.options.note,
      taskName: basename(outDir),
      downloaded: 0,
      bytes: 0,
      merge: shouldMerge,
      remux: this.options.remux ?? false,
      limit: Number.isFinite(limit) ? limit : undefined,
      jitterMs,
      retries,
      updatedAt: new Date().toISOString(),
    };
    await store.writeState(stateBase).catch(() => {});

    this.emit({ type: 'phase', phase: 'downloading' });

    let completed = 0;
    let completedDuration = 0;
    let bytes = 0;
    let currentIndex = 0;

    // 预扫描已完成的分片，让进度条一开始就是真实值
    for (const segment of segments) {
      if (await store.has(segment.index)) {
        completed += 1;
        completedDuration += segment.duration;
      }
    }

    let lastStateSave = Date.now();
    let savingState = false;
    const elapsedOf = (): number => Date.now() - startedAt - this.control.totalPausedMs;

    /** 节流落盘：断电后最多丢 5 秒的统计数字，分片文件本身是逐片原子的。 */
    const saveProgressState = (): void => {
      if (savingState || Date.now() - lastStateSave < STATE_SAVE_INTERVAL_MS) return;
      lastStateSave = Date.now();
      savingState = true;
      void store
        .writeState({
          ...stateBase,
          downloaded: completed,
          bytes,
          elapsedMs: elapsedOf(),
          updatedAt: new Date().toISOString(),
        })
        .catch(() => {})
        .finally(() => {
          savingState = false;
        });
    };

    const emitProgress = (): void => {
      const remainingDuration = Math.max(0, totalDuration - completedDuration);
      const elapsedMs = elapsedOf();
      this.emit({
        type: 'progress',
        snapshot: {
          phase: 'downloading',
          index: currentIndex,
          total,
          completed,
          failedCount: 0,
          bytes,
          elapsedMs,
          etaMs: speed > 0 ? (remainingDuration * 1000) / speed : 0,
          speed,
        },
      });
      saveProgressState();
    };

    emitProgress();

    let outputPath: string | null = null;
    let failedList: number[] = [];
    let downloadedCount = 0;
    let stateStatus: StateStatus = 'running';

    try {
      const result = await runSchedule(
        segments,
        client,
        this.control,
        { speed, jitterMs, retries, paceExisting: resumeMode === 'pace', onTick: emitProgress },
        {
          isDone: (index) => store.has(index),
          save: (index, data) => store.write(index, data),
          onSegment: (report) => {
            currentIndex = report.index;
            if (report.ok) {
              completed += 1;
              completedDuration += report.duration;
              bytes += report.bytes;
            }
            this.emit({
              type: 'segment',
              index: report.index,
              ok: report.ok,
              bytes: report.bytes,
              attempts: report.attempts,
              duration: report.duration,
              plannedAt: report.plannedAt,
              startedAt: report.startedAt,
              finishedAt: report.finishedAt,
            });
            emitProgress();
          },
          onError: (index, message, attempt) => {
            this.emit({ type: 'error', index, message, attempt });
          },
        },
      );

      failedList = result.failed;
      downloadedCount = result.downloaded;

      if (shouldMerge && result.failed.length === 0) {
        this.emit({ type: 'phase', phase: 'merging' });
        outputPath = resolve(outDir, 'output.ts');
        await mergeSegments(store, total, { outputPath });

        if (this.options.remux) {
          this.emit({ type: 'phase', phase: 'remuxing' });
          const fixedPath = outputPath.replace(/\.ts$/, '.fixed.ts');
          await remuxWithFfmpeg(outputPath, fixedPath);
          outputPath = fixedPath;
        }
      }

      stateStatus = failedList.length > 0 ? 'failed' : 'done';
    } catch (err) {
      // 取消 / 段错误：把已下载的部分标成"中断"，下次能直接续
      stateStatus = err instanceof CancelledError ? 'interrupted' : 'failed';
      throw err;
    } finally {
      const elapsedMs = elapsedOf();
      const finalState: TaskStateFile = {
        ...stateBase,
        failed: failedList,
        downloaded: downloadedCount,
        bytes,
        elapsedMs,
        status: stateStatus,
        updatedAt: new Date().toISOString(),
      };
      if (stateStatus !== 'running') finalState.finishedAt = new Date().toISOString();
      await store.writeState(finalState).catch(() => {});
    }

    const elapsedMs = elapsedOf();

    this.emit({
      type: 'done',
      failed: failedList,
      outputPath,
      elapsedMs,
      bytes,
    });
    this.emit({ type: 'phase', phase: 'done' });

    return {
      playlist,
      total,
      downloaded: downloadedCount,
      failed: failedList,
      bytes,
      elapsedMs,
      outputPath,
    };
  }
}

/**
 * 用 ffmpeg 重建时间戳。203 个 DISCONTINUITY 会让直接拼接的 TS 时间轴跳变，
 * 若播放出现音画不同步，用这个兜底（决策 D5 的例外路径）。
 */
function remuxWithFfmpeg(input: string, output: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'ffmpeg',
      ['-y', '-fflags', '+genpts', '-i', input, '-c', 'copy', '-copyts', '-muxdelay', '0', output],
      { stdio: 'inherit' },
    );
    child.on('error', (err) => reject(new Error(`无法启动 ffmpeg：${err.message}`)));
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg 退出码 ${code}`));
    });
  });
}

export { CancelledError };
