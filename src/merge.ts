import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { readFile, rename, rm, stat } from 'node:fs/promises';
import { CancelledError } from './control.ts';
import type { SegmentStore } from './store.ts';

export interface MergeOptions {
  outputPath: string;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}

/**
 * 按给定序号把分片二进制拼接成单一 .ts。
 *
 * 序号来自播放列表（按需下载时可能是 0200…0300），所以不能简单地 1..total。
 * 输出是原始 TS（决策 D5），不需要 ffmpeg。
 * 注意：203 个 #EXT-X-DISCONTINUITY 会让 TS 时间戳跳变，多数播放器可容忍；
 * 若出现音画不同步，用 --remux 走 ffmpeg 修复。
 *
 * 拼接先写 output.ts.part，全部写完才 rename 成 output.ts。否则断电时
 * 会留下一个"看起来存在、实际只有前几片"的成品，续传时被当成已完成。
 */
export async function mergeSegments(store: SegmentStore, indices: number[], opts: MergeOptions): Promise<number> {
  const partPath = `${opts.outputPath}.part`;
  const out = createWriteStream(partPath);
  let bytes = 0;

  // 必须在创建流后立刻挂 error 监听：磁盘写满时 EventEmitter 的 error
  // 没有监听器会直接抛出未捕获异常，导致整个服务进程退出。
  let streamError: Error | null = null;
  out.on('error', (err) => {
    streamError = err;
  });

  const onAbort = (): void => {
    out.destroy(new CancelledError());
  };
  opts.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    let done = 0;
    for (const i of indices) {
      if (opts.signal?.aborted) throw new CancelledError();
      if (streamError) throw streamError;

      const path = store.pathFor(i);
      const info = await stat(path).catch(() => null);
      if (!info || info.size === 0) {
        throw new Error(`合并失败：缺少分片 ${i}（${path}）`);
      }
      const buf = await readFile(path);
      if (streamError) throw streamError;
      if (!out.write(buf)) {
        await once(out, 'drain');
      }
      if (streamError) throw streamError;

      bytes += buf.length;
      done += 1;
      opts.onProgress?.(done, indices.length);
    }

    if (opts.signal?.aborted) throw new CancelledError();
    if (streamError) throw streamError;

    await new Promise<void>((resolve, reject) => {
      out.end(() => resolve());
      out.once('error', reject);
    });

    if (opts.signal?.aborted) throw new CancelledError();
    await rename(partPath, opts.outputPath);
  } catch (err) {
    out.destroy();
    await rm(partPath, { force: true }).catch(() => {});
    throw err;
  } finally {
    opts.signal?.removeEventListener('abort', onAbort);
  }

  return bytes;
}
