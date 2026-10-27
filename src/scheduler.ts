import { CancelledError, sleep } from './control.ts';
import type { TaskControl } from './control.ts';
import type { HttpClient, Segment } from './types.ts';

export interface SegmentReport {
  index: number;
  ok: boolean;
  bytes: number;
  attempts: number;
  duration: number;
  plannedAt: number;
  startedAt: number;
  finishedAt: number;
}

export interface SchedulerOptions {
  /** 倍速；0 表示关闭节拍、全速下载。 */
  speed: number;
  /** 抖动幅度（毫秒），在计划时刻上做 ±jitter 的均匀偏移。 */
  jitterMs: number;
  /** 单分片重试次数（不含首次）。 */
  retries: number;
  /** 已下载分片是否仍消耗时间轴（resume=pace 时为 true）。 */
  paceExisting: boolean;
}

export interface SchedulerHooks {
  isDone(index: number): Promise<boolean>;
  save(index: number, data: Buffer): Promise<void>;
  onSegment(report: SegmentReport): void;
  onError(index: number, message: string, attempt: number): void;
}

export interface SchedulerResult {
  failed: number[];
  downloaded: number;
  bytes: number;
}

/**
 * 节拍调度器 —— 整个项目的核心。
 *
 * 采用**绝对时间轴**而非逐片累加睡眠：
 *   第 i 片的计划时刻 = t0 + (Σ_{j<i} EXTINF[j]) / speed
 *
 * 这样做的两个后果都是想要的：
 *   1. 总耗时 ≈ 视频总时长 / speed，与网速无关；
 *   2. 单片的网络抖动或重试不会累积成后续的漂移。
 *
 * 慢片（下载耗时超过间隔）不追赶——补偿性突发反而比匀速更不像播放器。
 */
export async function runSchedule(
  segments: Segment[],
  client: HttpClient,
  control: TaskControl,
  options: SchedulerOptions,
  hooks: SchedulerHooks,
): Promise<SchedulerResult> {
  const t0 = Date.now();
  let cumulative = 0;

  const failed: number[] = [];
  let downloaded = 0;
  let bytes = 0;

  /** 等待到本片的计划时刻。返回最终采用的计划时刻。 */
  const waitUntil = async (intervalMs: number): Promise<number> => {
    const jitter = options.jitterMs > 0 ? (Math.random() * 2 - 1) * options.jitterMs : 0;
    for (;;) {
      control.throwIfCancelled();
      if (control.paused) {
        await sleep(100);
        continue;
      }
      // 暂停时长通过 totalPausedMs 平移进时间轴，恢复后不会集中补发
      const plannedAt = t0 + control.totalPausedMs + intervalMs + jitter;
      const remain = plannedAt - Date.now();
      if (remain <= 0) return plannedAt;
      await sleep(Math.min(remain, 200));
    }
  };

  /** 可被取消/暂停打断的等待，用于重试退避。 */
  const interruptibleSleep = async (ms: number): Promise<void> => {
    const until = Date.now() + ms;
    for (;;) {
      control.throwIfCancelled();
      if (control.paused) {
        await sleep(100);
        continue;
      }
      const remain = until - Date.now();
      if (remain <= 0) return;
      await sleep(Math.min(remain, 100));
    }
  };

  for (const segment of segments) {
    control.throwIfCancelled();

    const intervalMs = options.speed > 0 ? (cumulative * 1000) / options.speed : 0;

    if (await hooks.isDone(segment.index)) {
      if (options.paceExisting) {
        await waitUntil(intervalMs);
      }
      cumulative += segment.duration;
      continue;
    }

    const plannedAt = await waitUntil(intervalMs);
    const startedAt = Date.now();

    let attempts = 0;
    let ok = false;
    let size = 0;

    while (attempts <= options.retries) {
      attempts += 1;
      try {
        const data = await client.get(segment.uri, { signal: control.signal });
        await hooks.save(segment.index, data);
        size = data.length;
        ok = true;
        break;
      } catch (err) {
        if (control.cancelled || err instanceof CancelledError) throw new CancelledError();
        const message = err instanceof Error ? err.message : String(err);
        hooks.onError(segment.index, message, attempts);
        if (attempts <= options.retries) {
          await interruptibleSleep(Math.min(1000 * 2 ** (attempts - 1), 8000));
        }
      }
    }

    if (ok) {
      downloaded += 1;
      bytes += size;
    } else {
      failed.push(segment.index);
    }

    hooks.onSegment({
      index: segment.index,
      ok,
      bytes: size,
      attempts,
      duration: segment.duration,
      plannedAt,
      startedAt,
      finishedAt: Date.now(),
    });

    // 无论成功与否都推进时间轴，保持与视频播放进度对齐
    cumulative += segment.duration;
  }

  return { failed, downloaded, bytes };
}
