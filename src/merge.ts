import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { readFile, rename, rm, stat } from 'node:fs/promises';
import type { SegmentStore } from './store.ts';

export interface MergeOptions {
  outputPath: string;
  onProgress?: (done: number, total: number) => void;
}

/**
 * 把 segments/0001.ts ... 按序号二进制拼接成单一 .ts。
 *
 * 输出是原始 TS（决策 D5），因此不需要 ffmpeg。
 * 注意：203 个 #EXT-X-DISCONTINUITY 会让 TS 时间戳跳变，多数播放器可容忍；
 * 若出现音画不同步，用 --remux 走 ffmpeg 修复。
 *
 * 拼接先写 output.ts.part，全部写完才 rename 成 output.ts。否则断电时
 * 会留下一个"看起来存在、实际只有前几片"的成品，续传时被当成已完成。
 */
export async function mergeSegments(store: SegmentStore, total: number, opts: MergeOptions): Promise<number> {
  const partPath = `${opts.outputPath}.part`;
  const out = createWriteStream(partPath);
  let bytes = 0;

  try {
    for (let i = 1; i <= total; i += 1) {
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
      opts.onProgress?.(i, total);
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
