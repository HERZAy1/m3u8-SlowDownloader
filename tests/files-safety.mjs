/**
 * 文件面板删除外部输出目录时的安全回归：
 * 只删除本工具写过的文件，不能把用户放在同一目录里的其它文件一起删掉。
 *
 * 用法：node tests/files-safety.mjs
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const WORK = join(ROOT, 'tests', '.work-files-safety');
const ENTRY = join(ROOT, 'src', 'server.ts');
const PORT = 7815;
const ORIGIN = 7816;
const EXTERNAL = join(WORK, 'my-videos');

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
    res.end('#EXTM3U\n#EXTINF:0.2,\nseg1.ts\n#EXT-X-ENDLIST\n');
    return;
  }
  if (url.pathname === '/seg1.ts') {
    const body = Buffer.alloc(300, 65);
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

async function waitFor(fn, timeout = 15000) {
  const until = Date.now() + timeout;
  for (;;) {
    const value = await fn().catch(() => null);
    if (value) return value;
    if (Date.now() > until) throw new Error('等待超时');
    await sleep(100);
  }
}

let gui = null;
try {
  await rm(WORK, { recursive: true, force: true });
  await mkdir(EXTERNAL, { recursive: true });
  await writeFile(join(EXTERNAL, 'personal.txt'), 'keep me');
  await new Promise((r) => origin.listen(ORIGIN, '127.0.0.1', r));

  gui = spawnGui();
  await waitFor(async () => (await api('/api/state')).ok);

  const added = await post('/api/queue', {
    urls: [`http://127.0.0.1:${ORIGIN}/play.m3u8`],
    outDir: EXTERNAL,
    speed: 0,
    jitter: 0,
    retries: 0,
  });
  check(added.ok && added.body.added === 1, '外部 outDir 任务入队');
  await post('/api/queue/start');
  const done = await waitFor(async () => {
    const item = (await api('/api/queue')).body.items[0];
    return item && item.status === 'done' ? item : null;
  });
  check(Boolean(await stat(join(EXTERNAL, 'output.ts')).catch(() => null)), '成品写在外部目录');
  const files = (await readdir(EXTERNAL)).sort();
  check(files.includes('personal.txt'), '用户文件存在', files.join(','));

  const renamed = await post('/api/queue/note', { id: done.id, note: 'external-renamed' });
  check(renamed.ok, '外部目录任务改名成功', JSON.stringify(renamed.body));
  check(Boolean(await stat(join(EXTERNAL, 'personal.txt')).catch(() => null)), '改备注后用户文件仍在');
  check(Boolean(await stat(EXTERNAL).catch(() => null)), '改备注后外部目录仍在');

  const del = await fetch(`http://127.0.0.1:${PORT}/api/files?id=${encodeURIComponent('my-videos')}`, {
    method: 'DELETE',
  });
  const body = await del.json().catch(() => ({}));
  check(del.ok && body.ok, '删除接口成功', JSON.stringify(body));
  check(Boolean(await stat(join(EXTERNAL, 'personal.txt')).catch(() => null)), '用户文件未被删除');
  check(!(await stat(join(EXTERNAL, 'output.ts')).catch(() => null)), '任务成品已删除');
  check(!(await stat(join(EXTERNAL, 'segments')).catch(() => null)), '任务分片已删除');
  check(Boolean(await stat(EXTERNAL).catch(() => null)), '外部目录本身保留');

  gui.kill('SIGKILL');
  await new Promise((r) => gui.once('exit', r));
  gui = null;
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
