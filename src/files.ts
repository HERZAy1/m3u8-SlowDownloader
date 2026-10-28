import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { TaskFileInfo } from './types.ts';

/**
 * 扫描一个任务目录，统计分片与成品的占用。
 *
 * 只有分片和成品都不存在时才返回 null——这样"有任何文件就显示"的语义由调用方直接使用。
 */
export async function scanTaskDir(dir: string, name: string): Promise<TaskFileInfo | null> {
  const info = await stat(dir).catch(() => null);
  if (!info || !info.isDirectory()) return null;

  let segments = 0;
  let segmentBytes = 0;
  let newest = 0;

  const segDir = join(dir, 'segments');
  const entries = await readdir(segDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const file = await stat(join(segDir, entry.name)).catch(() => null);
    if (!file) continue;
    segments += 1;
    segmentBytes += file.size;
    if (file.mtimeMs > newest) newest = file.mtimeMs;
  }

  const output = await stat(join(dir, 'output.ts')).catch(() => null);
  const outputBytes = output ? output.size : 0;
  if (output && output.mtimeMs > newest) newest = output.mtimeMs;

  if (segments === 0 && outputBytes === 0) return null;

  let startedAt = info.birthtimeMs > 0 ? info.birthtimeMs : info.mtimeMs;
  let durationMs: number | null = null;

  const raw = await readFile(join(dir, 'state.json'), 'utf8').catch(() => null);
  if (raw) {
    try {
      const state = JSON.parse(raw) as {
        createdAt?: string;
        t0?: number;
        elapsedMs?: number;
      };
      if (state.createdAt) {
        const parsed = Date.parse(state.createdAt);
        if (!Number.isNaN(parsed)) startedAt = parsed;
      } else if (typeof state.t0 === 'number') {
        startedAt = state.t0;
      }
      if (typeof state.elapsedMs === 'number' && state.elapsedMs > 0) durationMs = state.elapsedMs;
    } catch {
      /* state.json 损坏就退回文件时间 */
    }
  }

  if (durationMs === null && newest > 0) durationMs = Math.max(0, newest - startedAt);

  return {
    id: name,
    name,
    path: dir,
    segments,
    segmentBytes,
    outputBytes,
    totalBytes: segmentBytes + outputBytes,
    startedAt: startedAt || null,
    durationMs,
    hasOutput: Boolean(output),
  };
}
