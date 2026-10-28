import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface TaskStateFile {
  version: 1;
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
}

/**
 * 分片落盘与任务状态。
 *
 * 目录布局：
 *   <out>/playlist.m3u8
 *   <out>/state.json
 *   <out>/segments/0001.ts ...
 *   <out>/output.ts
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
    await writeFile(this.pathFor(index), data);
  }

  async savePlaylist(text: string): Promise<void> {
    await writeFile(join(this.root, 'playlist.m3u8'), text, 'utf8');
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
    await writeFile(join(this.root, 'state.json'), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  }
}
