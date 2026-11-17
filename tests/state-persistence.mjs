/**
 * 清理/清空后的重启语义回归：
 * - 清理 segments 后成品仍在，重启不能把 done 改成 interrupted；
 * - 清空已完成记录后重启，任务不能复活。
 *
 * 用法：node tests/state-persistence.mjs
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const WORK = join(ROOT, 'tests', '.work-state');
const ENTRY = join(ROOT, 'src', 'server.ts');
const PORT = 7813;
const ORIGIN = 7814;
const NOTE = '清理测试';
const SEG_BYTES = 200;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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

const origin = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${ORIGIN}`);
  if (url.pathname === '/play.m3u8') {
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    res.end(
      '#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:0.2,\nseg1.ts\n#EXTINF:0.2,\nseg2.ts\n#EXTINF:0.2,\nseg3.ts\n#EXT-X-ENDLIST\n',
    );
    return;
  }
  if (/^\/seg[123]\.ts$/.test(url.pathname)) {
    const body = Buffer.alloc(SEG_BYTES, 65);
    res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Content-Length': String(body.length) });
    res.end(body);
    return;
  }
  res.writeHead(404).end('no');
});

function spawnGui() {
  const child = spawn(process.execPath, [ENTRY], {
    cwd: WORK,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => console.log(`  [gui] ${String(d).trim()}`));
  child.stderr.on('data', (d) => console.log(`  [gui!] ${String(d).trim()}`));
  return child;
}

async function api(path, init) {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, init);
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { ok: res.ok, status: res.status, body };
}

const post = (path, payload = {}) =>
  api(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

async function waitFor(fn, { timeout = 15000, label = '条件' } = {}) {
  const until = Date.now() + timeout;
  for (;;) {
    const value = await fn().catch(() => null);
    if (value) return value;
    if (Date.now() > until) throw new Error(`等待超时：${label}`);
    await sleep(100);
  }
}

let gui = null;
async function boot() {
  gui = spawnGui();
  await waitFor(async () => (await api('/api/state')).ok, { label: '服务启动' });
}
async function kill() {
  gui.kill('SIGKILL');
  await new Promise((r) => gui.once('exit', r));
  gui = null;
  await sleep(300);
}

try {
  await rm(WORK, { recursive: true, force: true });
  await mkdir(WORK, { recursive: true });
  await new Promise((r) => origin.listen(ORIGIN, '127.0.0.1', r));

  await boot();
  console.log('\n1. 下载并清理分片');
  const added = await post('/api/queue', {
    urls: [`http://127.0.0.1:${ORIGIN}/play.m3u8`],
    note: NOTE,
    speed: 0,
    jitter: 0,
    retries: 0,
  });
  check(added.ok && added.body.added === 1, '入队成功', JSON.stringify(added.body?.added));
  await post('/api/queue/start');
  const done = await waitFor(async () => {
    const items = (await api('/api/queue')).body.items;
    const item = items.find((i) => i.note === NOTE);
    return item && item.status === 'done' ? item : null;
  }, { label: '任务完成' });
  const taskDir = join(WORK, 'downloads', done.taskName);
  const segmentsDir = join(taskDir, 'segments');
  const segFiles = (await readdir(segmentsDir).catch(() => [])).filter((n) => n.endsWith('.ts'));
  check(segFiles.length === 3, '分片目录存在且包含 3 片', `${segFiles.length} 片`);

  const cleanup = await post('/api/cleanup', { job: done.id });
  check(cleanup.ok, '清理接口返回成功', JSON.stringify(cleanup.body));
  check(!(await stat(segmentsDir).catch(() => null)), 'segments 已删除');
  check(Boolean(await stat(join(taskDir, 'output.ts')).catch(() => null)), 'output.ts 保留');

  const renamed = await post('/api/queue/note', { id: done.id, note: '清理改名' });
  check(renamed.ok, '清理后改名成功', JSON.stringify(renamed.body));

  console.log('\n2. 清理后重启');
  await sleep(700);
  await kill();
  await boot();
  const afterCleanup = (await api('/api/queue')).body.items.find((i) => i.note === '清理改名');
  check(afterCleanup?.status === 'done', '清理后重启仍为 done', String(afterCleanup?.status));
  check(afterCleanup?.downloaded === afterCleanup?.total, '已下载数仍为满额', `${afterCleanup?.downloaded}/${afterCleanup?.total}`);
  check(Array.isArray(afterCleanup?.failed) && afterCleanup.failed.length === 0, '失败列表为空', JSON.stringify(afterCleanup?.failed));
  check(Boolean(afterCleanup?.outputPath), '成品路径仍可下载', String(afterCleanup?.outputPath));

  console.log('\n3. 清空已完成后重启');
  const cleared = await post('/api/queue/clear');
  check(cleared.ok && cleared.body.removed === 1, '清空已完成', JSON.stringify(cleared.body));
  await sleep(700);
  await kill();
  await boot();
  const afterClear = (await api('/api/queue')).body.items;
  check(!afterClear.some((i) => i.note === '清理改名'), '清空后重启不再复活', afterClear.map((i) => i.note).join(','));
} finally {
  if (gui) gui.kill('SIGKILL');
  origin.close();
  await sleep(300);
  await rm(WORK, { recursive: true, force: true }).catch(() => {});
}

console.log(`\n${passed}/${passed + failed} 项通过`);
if (failed > 0) {
  console.log('有失败项 ❌');
  process.exit(1);
}
console.log('全部通过 ✅');
process.exit(0);
