import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { readFile, rename, rm, stat } from 'node:fs/promises';
import type { SegmentStore } from './store.ts';

export interface MergeOptions {
  outputPath: string;
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

  try {
    let done = 0;
    for (const i of indices) {
      const path = store.pathFor(i);
      const info = await stat(path).catch(() => null);
      if (!info || info.size === 0) {
        throw new Error(`合并失败：缺少分片 ${i}（${path}）`);
      }
      const buf = await readFile(path);
      if (!out.write(buf)) {
        await once(out, 'drain');
      }
      bytes += buf.length;
      done += 1;
      opts.onProgress?.(done, indices.length);
    }

    await new Promise<void>((resolve, reject) => {
      out.end(() => resolve());
      out.once('error', reject);
    });

    await rename(partPath, opts.outputPath);
  } catch (err) {
    out.destroy();
    await rm(partPath, { force: true }).catch(() => {});
    throw err;
  }

  return bytes;
}
