/**
 * 队列排序 / 优先 / 暂停让位 的端到端验证。
 *
 * 用法：node tests/queue-order.mjs
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const WORK = join(ROOT, 'tests', '.work-order');
const ENTRY = join(ROOT, 'src', 'server.ts');
const PORT = 7807;
const ORIGIN = 7808;
const TOTAL = 40;
const SEG_BYTES = 400;

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

const origin = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${ORIGIN}`);
  if (url.pathname === '/play.m3u8') {
    const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:1'];
    for (let i = 1; i <= TOTAL; i += 1) lines.push('#EXTINF:1.000,', `seg${String(i).padStart(4, '0')}.ts`);
    lines.push('#EXT-X-ENDLIST', '');
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    res.end(lines.join('\n'));
    return;
  }
  const matched = /^\/seg(\d{4})\.ts$/.exec(url.pathname);
  if (matched) {
    await sleep(20);
    const body = Buffer.alloc(SEG_BYTES, 65);
    res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Content-Length': String(body.length) });
    res.end(body);
    return;
  }
  res.writeHead(404).end('no');
});

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

function post(path, payload) {
  return api(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  });
}

async function waitFor(fn, { timeout = 20000, label = '条件' } = {}) {
  const until = Date.now() + timeout;
  for (;;) {
    const value = await fn().catch(() => null);
    if (value) return value;
    if (Date.now() > until) throw new Error(`等待超时：${label}`);
    await sleep(120);
  }
}

await rm(WORK, { recursive: true, force: true });
await mkdir(WORK, { recursive: true });
await new Promise((r) => origin.listen(ORIGIN, '127.0.0.1', r));

const gui = spawn(process.execPath, [ENTRY], {
  cwd: WORK,
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
gui.stdout.on('data', (d) => console.log(`  [gui] ${String(d).trim()}`));

const urlOf = (n) => `http://127.0.0.1:${ORIGIN}/play.m3u8?ep=${n}`;
const names = async () => {
  const snap = await api('/api/queue');
  return snap.body.items.map((i) => i.note);
};

try {
  await waitFor(async () => (await api('/api/state')).ok, { label: '服务启动' });

  console.log('\n1. 入队三条');
  for (const [i, name] of ['A', 'B', 'C'].entries()) {
    await post('/api/queue', { urls: [urlOf(i + 1)], speed: 2, jitter: 0, note: name });
  }
  check((await names()).join(',') === 'A,B,C', '初始顺序 A,B,C');

  console.log('\n2. 探测后的剩余时间');
  const probed = await waitFor(
    async () => {
      const snap = await api('/api/queue');
      const item = snap.body.items[0];
      return item.total > 0 && item.remainingMs > 0 ? item : null;
    },
    { label: '探测完成' },
  );
  check(probed.total === TOTAL, '待处理任务显示总片数', `total=${probed.total}`);
  check(
    Math.round(probed.remainingMs / 1000) === TOTAL / 2,
    '剩余时间按倍速折算（40 片 / 2x = 20s）',
    `${Math.round(probed.remainingMs / 1000)}s`,
  );

  console.log('\n3. 手动上移 / 下移');
  const snap1 = await api('/api/queue');
  const cItem = snap1.body.items.find((i) => i.note === 'C');
  await post('/api/queue/move', { id: cItem.id, delta: -1 });
  check((await names()).join(',') === 'A,C,B', 'C 上移一位');

  const snap2 = await api('/api/queue');
  const aItem = snap2.body.items.find((i) => i.note === 'A');
  const top = await post('/api/queue/move', { id: aItem.id, delta: -1 });
  check(!top.ok && String(top.body.error).includes('队首'), '队首再上移会被拒绝', String(top.body.error ?? ''));

  console.log('\n4. 优先下载');
  const snap3 = await api('/api/queue');
  const bItem = snap3.body.items.find((i) => i.note === 'B');
  const prio = await post('/api/queue/prioritize', { id: bItem.id });
  check(prio.ok && !prio.body.yielded, '空闲时「优先」不会触发让位');
  check((await names()).join(',') === 'B,A,C', 'B 被挪到队首');

  console.log('\n5. 暂停让位');
  await post('/api/queue/start', {});
  const runningB = await waitFor(
    async () => {
      const s = await api('/api/queue');
      const item = s.body.items.find((i) => i.note === 'B');
      return item.status === 'running' ? item : null;
    },
    { label: 'B 开始下载' },
  );
  check(Boolean(runningB), 'B 正在下载');

  // 等它真的下几片再让位，验证「让位后保留已下载片数」
  const partial = await waitFor(
    async () => {
      const s = await api('/api/queue');
      const item = s.body.items.find((i) => i.note === 'B');
      return item.downloaded >= 2 ? item : null;
    },
    { label: '下到 2 片' },
  );
  check(partial.downloaded >= 2, '运行中快照能看到实时已下载数', `${partial.downloaded}/${TOTAL}`);

  const yielded = await post('/api/queue/yield', {});
  check(yielded.ok, '让位接口返回成功');

  const afterYield = await waitFor(
    async () => {
      const s = await api('/api/queue');
      const b = s.body.items.find((i) => i.note === 'B');
      const running = s.body.items.find((i) => i.status === 'running');
      return b.status === 'interrupted' && running && running.note !== 'B' ? { b, running } : null;
    },
    { label: 'B 让位、下一条接手' },
  );
  check(afterYield.b.status === 'interrupted', '让位的任务变成「已中断」', afterYield.b.status);
  check(afterYield.b.downloaded > 0, '让位后保留已下载片数', `${afterYield.b.downloaded}/${TOTAL}`);
  check(String(afterYield.b.error ?? '').includes('暂停'), '中断原因标明是暂停', afterYield.b.error ?? '');
  check(afterYield.running.note === 'A', '队列自动开始下一条', afterYield.running.note);

  console.log('\n6. 运行中直接「优先」别的任务');
  const s6 = await api('/api/queue');
  const cNow = s6.body.items.find((i) => i.note === 'C');
  const prioRunning = await post('/api/queue/prioritize', { id: cNow.id });
  check(prioRunning.ok && prioRunning.body.yielded === true, '运行中点「优先」会让当前任务让位');

  const afterPrio = await waitFor(
    async () => {
      const s = await api('/api/queue');
      const running = s.body.items.find((i) => i.status === 'running');
      return running && running.note === 'C' ? running : null;
    },
    { label: 'C 开始下载' },
  );
  check(afterPrio.note === 'C', '被优先的任务立即开始下载');

  const finalSnap = await api('/api/queue');
  const aFinal = finalSnap.body.items.find((i) => i.note === 'A');
  check(aFinal.status === 'interrupted', 'A 也让位成「已中断」', aFinal.status);

  await post('/api/queue/stop', {});
} finally {
  gui.kill('SIGKILL');
  origin.close();
}

console.log(`\n${passed}/${passed + failed} 项通过`);
if (failed > 0) {
  console.log('有失败项 ❌');
  process.exit(1);
}
console.log('全部通过 ✅');

for (let i = 0; i < 10; i += 1) {
  try {
    await rm(WORK, { recursive: true, force: true });
    break;
  } catch {
    await sleep(400);
  }
}
process.exit(0);
