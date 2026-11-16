/**
 * 文件面板数据源：目录名与用户备注的区分。
 *
 * 场景：任务目录是 URL 推导出来的名字（play-1739…），但用户给任务起了备注；
 * 文件面板必须把备注作为主标题返回，目录名仍作为删除 / 定位用的 id。
 *
 * 用法：node tests/files-note.mjs
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { scanTaskDir } from '../src/files.ts';

const ROOT = resolve(import.meta.dirname, '..');
const WORK = join(ROOT, 'tests', '.work-files');
const NOTE = '第 04 讲 · 抓包实战';

let passed = 0;
let failed = 0;
function check(ok, label, extra = '') {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${label}${extra ? `  ${extra}` : ''}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${extra ? `  ${extra}` : ''}`);
  }
}

await rm(WORK, { recursive: true, force: true });

const dir = join(WORK, 'play-1739000000000');
await mkdir(join(dir, 'segments'), { recursive: true });
await writeFile(join(dir, 'segments', '0001.ts'), Buffer.alloc(100, 1));
await writeFile(join(dir, 'segments', '0002.ts'), Buffer.alloc(100, 2));
await writeFile(join(dir, 'output.ts'), Buffer.alloc(200, 3));
await writeFile(
  join(dir, 'state.json'),
  JSON.stringify({
    version: 2,
    url: 'https://example.com/play.m3u8',
    createdAt: new Date().toISOString(),
    t0: Date.now(),
    speed: 2,
    total: 2,
    failed: [],
    note: NOTE,
    taskName: 'play-1739000000000',
    status: 'done',
    elapsedMs: 12345,
  }),
);

const withNote = await scanTaskDir(dir, 'play-1739000000000');
check(Boolean(withNote), '扫描到任务目录');
check(withNote?.note === NOTE, '返回用户备注', withNote?.note ?? '-');
check(withNote?.name === 'play-1739000000000', '目录名仍然保留（删除/定位要用）', withNote?.name ?? '-');
check(withNote?.id === withNote?.name, 'id 仍是目录名');
check(withNote?.segments === 2, '分片数正确', String(withNote?.segments));
check(withNote?.hasOutput === true, '成品识别正确');

// 没有 note 的老目录：只返回目录名，不造假备注
const plain = join(WORK, 'old-task');
await mkdir(join(plain, 'segments'), { recursive: true });
await writeFile(join(plain, 'segments', '0001.ts'), Buffer.alloc(10, 1));
await writeFile(
  join(plain, 'state.json'),
  JSON.stringify({ version: 2, url: '', createdAt: new Date().toISOString(), t0: Date.now(), speed: 2, total: 1, failed: [] }),
);

const noNote = await scanTaskDir(plain, 'old-task');
check(noNote?.note === undefined, '没有备注时 note 为空（界面回退到目录名）');

// 备注为空字符串也当作没有
const blank = join(WORK, 'blank-note');
await mkdir(join(blank, 'segments'), { recursive: true });
await writeFile(join(blank, 'segments', '0001.ts'), Buffer.alloc(10, 1));
await writeFile(
  join(blank, 'state.json'),
  JSON.stringify({ version: 2, url: '', createdAt: new Date().toISOString(), t0: Date.now(), speed: 2, total: 1, failed: [], note: '   ' }),
);
const blankNote = await scanTaskDir(blank, 'blank-note');
check(blankNote?.note === undefined, '空白备注被忽略');

console.log(`\n${passed}/${passed + failed} 项通过`);
if (failed > 0) {
  console.log('有失败项 ❌');
  process.exit(1);
}
console.log('全部通过 ✅');
await rm(WORK, { recursive: true, force: true });
process.exit(0);
