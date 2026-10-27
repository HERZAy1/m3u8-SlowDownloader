import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { CancelledError, TaskControl } from './control.ts';
import { CHROME_HEADERS } from './headers.ts';
import { FetchHttpClient } from './http.ts';
import { mergeSegments } from './merge.ts';
import { parsePlaylist } from './playlist.ts';
import { runSchedule } from './scheduler.ts';
import { SegmentStore } from './store.ts';
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
    await store.savePlaylist(text);
    this.emit({ type: 'log', message: `输出目录：${outDir}` });

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

    const emitProgress = (): void => {
      const remainingDuration = Math.max(0, totalDuration - completedDuration);
      const elapsedMs = Date.now() - startedAt - this.control.totalPausedMs;
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
    };

    emitProgress();

    const result = await runSchedule(
      segments,
      client,
      this.control,
      { speed, jitterMs, retries, paceExisting: resumeMode === 'pace' },
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

    let outputPath: string | null = null;

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

    await store.writeState({
      version: 1,
      url: this.options.url,
      createdAt: new Date(startedAt).toISOString(),
      t0: startedAt,
      speed,
      total,
      failed: result.failed,
    });

    const elapsedMs = Date.now() - startedAt - this.control.totalPausedMs;
    this.emit({
      type: 'done',
      failed: result.failed,
      outputPath,
      elapsedMs,
      bytes: result.bytes,
    });
    this.emit({ type: 'phase', phase: 'done' });

    return {
      playlist,
      total,
      downloaded: result.downloaded,
      failed: result.failed,
      bytes: result.bytes,
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
