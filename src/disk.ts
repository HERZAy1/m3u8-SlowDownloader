import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';
import { parsePlaylist } from './playlist.ts';
import type { TaskStateFile } from './store.ts';
import type { DiskTaskInfo } from './types.ts';

export interface DiskScan extends DiskTaskInfo {
  state: TaskStateFile | null;
}

/** 老目录没记 url，用占位基址解析清单——只需要分片数量和时长。 */
const PLACEHOLDER_BASE = 'http://placeholder.invalid/p.m3u8';

/**
 * 扫描下载根目录下的所有任务目录。
 *
 * 断电恢复就靠这里：不依赖内存里的队列，直接从磁盘上的 playlist.m3u8 +
 * segments/ 算出"总共多少片、已经有多少片、缺哪几片、有没有成品"。
 */
export async function scanDiskTasks(root: string): Promise<DiskScan[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const out: DiskScan[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const scan = await scanTaskDirDeep(join(root, entry.name));
    if (scan) out.push(scan);
  }
  return out;
}

export async function scanTaskDirDeep(dir: string): Promise<DiskScan | null> {
  const info = await stat(dir).catch(() => null);
  if (!info || !info.isDirectory()) return null;

  const state = await readStateFile(dir);

  let total = typeof state?.total === 'number' ? state.total : 0;
  let durationSec: number | null = null;

  const playlistText = await readFile(join(dir, 'playlist.m3u8'), 'utf8').catch(() => null);
  if (playlistText) {
    try {
      const playlist = parsePlaylist(playlistText, state?.url || PLACEHOLDER_BASE);
      total = playlist.segments.length;
      durationSec = playlist.totalDuration;
    } catch {
      /* 清单损坏就退回 state.json 里的分片数 */
    }
  }

  const names = new Set<string>();
  const entries = await readdir(join(dir, 'segments'), { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.ts')) names.add(entry.name);
  }

  const present = names.size;
  const missing: number[] = [];
  if (total > 0) {
    for (let i = 1; i <= total; i += 1) {
      if (!names.has(`${String(i).padStart(4, '0')}.ts`)) missing.push(i);
    }
  }

  const output = await stat(join(dir, 'output.ts')).catch(() => null);
  const hasOutput = Boolean(output && output.size > 0);

  // 既没有状态、也没有分片和成品的目录不算任务（比如用户自己放的杂项目录）
  if (!state && present === 0 && !hasOutput) return null;

  const startedAt =
    (state?.createdAt ? Date.parse(state.createdAt) : NaN) ||
    (typeof state?.t0 === 'number' ? state.t0 : 0) ||
    (info.birthtimeMs > 0 ? info.birthtimeMs : info.mtimeMs);

  const abs = resolve(dir);
  const rel = relative(process.cwd(), abs);

  return {
    dir: abs,
    relDir: rel && !rel.startsWith('..') && !rel.includes(`..${sep}`) ? rel : abs,
    name: basename(abs),
    url: typeof state?.url === 'string' ? state.url : '',
    total,
    present,
    missing,
    hasOutput,
    startedAt: startedAt || null,
    elapsedMs: typeof state?.elapsedMs === 'number' ? state.elapsedMs : 0,
    durationSec,
    state,
  };
}

export async function readStateFile(dir: string): Promise<TaskStateFile | null> {
  const raw = await readFile(join(dir, 'state.json'), 'utf8').catch(() => null);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as TaskStateFile;
  } catch {
    return null;
  }
}
