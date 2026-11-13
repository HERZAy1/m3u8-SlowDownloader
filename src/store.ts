import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** 任务在磁盘上的状态。'running' 只应出现在进程存活期间——读到它就说明上次是异常退出。 */
export type StateStatus = 'running' | 'done' | 'failed' | 'interrupted';

export interface TaskStateFile {
  version: number;
  /** 播放列表原始地址，断电恢复后靠它续传 */
  url: string;
  createdAt: string;
  /** 时间轴原点（毫秒），暂停恢复时用于平移。 */
  t0: number;
  speed: number;
  total: number;
  failed: number[];
  /** 扣除暂停后的实际耗时（毫秒），供文件管理页显示 */
  elapsedMs?: number;
  finishedAt?: string;
  status?: StateStatus;
  /** 用户备注（= 目录名），恢复时复原显示名 */
  note?: string;
  taskName?: string;
  downloaded?: number;
  bytes?: number;
  merge?: boolean;
  remux?: boolean;
  limit?: number;
  jitterMs?: number;
  retries?: number;
  /** 最后一次状态写入时间 */
  updatedAt?: string;
}

/**
 * 分片落盘与任务状态。
 *
 * 目录布局：
 *   <out>/playlist.m3u8
 *   <out>/state.json
 *   <out>/segments/0001.ts ...
 *   <out>/output.ts
 *
 * 所有写入都走"临时文件 + rename"：断电/崩溃时最终文件名要么不存在、
 * 要么是完整内容，绝不会留下"名字像完成了、内容只有一半"的假分片。
 */
export class SegmentStore {
  readonly root: string;
  readonly segmentsDir: string;

  constructor(root: string) {
    this.root = root;
    this.segmentsDir = join(root, 'segments');
  }

  async init(): Promise<void> {
    await mkdir(this.segmentsDir, { recursive: true });
  }

  pathFor(index: number): string {
    return join(this.segmentsDir, `${String(index).padStart(4, '0')}.ts`);
  }

  async has(index: number): Promise<boolean> {
    try {
      const info = await stat(this.pathFor(index));
      return info.size > 0;
    } catch {
      return false;
    }
  }

  async write(index: number, data: Buffer): Promise<void> {
    const final = this.pathFor(index);
    const tmp = `${final}.part`;
    await writeFile(tmp, data);
    await rename(tmp, final);
  }

  /** 清掉上次异常退出留下的半截文件，返回删除数量。 */
  async cleanupPartials(): Promise<number> {
    let removed = 0;
    const entries = await readdir(this.segmentsDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.part')) continue;
      const ok = await rm(join(this.segmentsDir, entry.name), { force: true }).then(
        () => true,
        () => false,
      );
      if (ok) removed += 1;
    }
    const outPart = join(this.root, 'output.ts.part');
    if (await stat(outPart).catch(() => null)) {
      const ok = await rm(outPart, { force: true }).then(
        () => true,
        () => false,
      );
      if (ok) removed += 1;
    }
    return removed;
  }

  async savePlaylist(text: string): Promise<void> {
    await writeAtomic(join(this.root, 'playlist.m3u8'), text);
  }

  async readState(): Promise<TaskStateFile | null> {
    try {
      const raw = await readFile(join(this.root, 'state.json'), 'utf8');
      return JSON.parse(raw) as TaskStateFile;
    } catch {
      return null;
    }
  }

  async writeState(state: TaskStateFile): Promise<void> {
    await writeAtomic(join(this.root, 'state.json'), `${JSON.stringify(state, null, 2)}\n`);
  }
}

/** 写临时文件再 rename，保证断电后不会读到写了一半的 json/m3u8 */
export async function writeAtomic(path: string, data: string | Buffer): Promise<void> {
  const tmp = `${path}.part`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}
