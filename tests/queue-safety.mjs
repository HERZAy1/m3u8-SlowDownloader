/**
 * 队列目录安全回归：外部输出目录不被备注改名搬走；默认同名目录自动去重；
 * Windows 非法文件名清洗。
 *
 * 用法：node tests/queue-safety.mjs
 */
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DownloadQueue, defaultOutDir, sanitizeNote } from '../src/queue.ts';

const ROOT = resolve(import.meta.dirname, '..');
const WORK = join(ROOT, 'tests', '.work-queue-safety');
const EMPTY = { speed: 2, jitterMs: 0, retries: 0, remux: false, merge: true };

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
await mkdir(join(WORK, 'downloads'), { recursive: true });

const external = join(WORK, 'my-videos');
await mkdir(external, { recursive: true });
await writeFile(join(external, 'personal.txt'), 'keep me');

const queue = new DownloadQueue(() => {}, {
  downloadsDir: join(WORK, 'downloads'),
  stateFile: join(WORK, 'state', 'queue.json'),
  maxItems: 20,
});

console.log('\n1. 外部输出目录 + 备注改名');
await queue.add(['http://127.0.0.1:1/a/play.m3u8'], { ...EMPTY, outDir: external });
const first = queue.snapshot().items[0];
const noteResult = await queue.setNote(first.id, 'renamed');
check(noteResult.ok && noteResult.note === 'renamed', '备注改名成功', JSON.stringify(noteResult));
check(Boolean(await stat(join(external, 'personal.txt')).catch(() => null)), '外部目录里的用户文件仍在');
check(!(await stat(join(WORK, 'downloads', 'renamed')).catch(() => null)), '没有把外部目录搬进 downloads');

const conflict = await queue.add(['http://127.0.0.1:1/b/play.m3u8'], {
  ...EMPTY,
  outDir: external,
});
check(conflict.added === 0 && conflict.conflicts === 1, '同一 outDir 的第二个任务被拒绝', JSON.stringify(conflict));

console.log('\n2. 默认同名目录自动去重');
await queue.add(['http://127.0.0.1:1/c/play.m3u8'], EMPTY);
await queue.add(['http://127.0.0.1:1/d/play.m3u8'], EMPTY);
const names = queue.snapshot().items.map((i) => i.taskName);
check(names.includes('play') && names.includes('play-2'), '同名链接得到 play / play-2', names.join(', '));

console.log('\n3. 文件名清洗');
check(sanitizeNote('CON') === 'CON_', 'Windows 保留名 CON 被处理', sanitizeNote('CON'));
check(sanitizeNote('a:b') === 'ab', '冒号被移除', sanitizeNote('a:b'));
check(sanitizeNote('a\u0001b') === 'ab', '控制字符被移除', JSON.stringify(sanitizeNote('a\u0001b')));
check(sanitizeNote('foo.') === 'foo', '尾部点被移除', sanitizeNote('foo.'));
check(defaultOutDir('https://x/a:b.m3u8') === 'downloads/ab', 'URL 推导名也经过清洗', defaultOutDir('https://x/a:b.m3u8'));

await rm(WORK, { recursive: true, force: true });
console.log(`\n${passed}/${passed + failed} 项通过`);
if (failed > 0) {
  console.log('有失败项 ❌');
  process.exit(1);
}
console.log('全部通过 ✅');
process.exit(0);
