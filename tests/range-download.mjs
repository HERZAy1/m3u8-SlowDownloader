/**
 * 按需下载（区间）端到端验证。
 *
 * 场景：探测总片数 → 非法区间被拒 → 只下第 11–20 片 → 成品只包含这 10 片 →
 *       state.json 记录区间 → 同区间重复导入不新建 → 同链接不同区间可并存 →
 *       kill -9 后只补区间内缺失分片。
 *
 * 用法：node tests/range-download.mjs
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const WORK = join(ROOT, 'tests', '.work-range');
const ENTRY = join(ROOT, 'src', 'server.ts');
const PORT = 7803;
const ORIGIN = 7804;
const TOTAL = 40;
const SEG_BYTES = 400;
const RANGE = { start: 11, end: 20 };
const RANGE2 = { start: 26, end: 35 };

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
    const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:1', '#EXT-X-MEDIA-SEQUENCE:0'];
    for (let i = 1; i <= TOTAL; i += 1) {
      lines.push('#EXTINF:1.000,', `seg${String(i).padStart(4, '0')}.ts`);
    }
    lines.push('#EXT-X-ENDLIST', '');
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    res.end(lines.join('\n'));
    return;
  }

  const matched = /^\/seg(\d{4})\.ts$/.exec(url.pathname);
  if (matched) {
    const index = Number(matched[1]);
    const body = Buffer.alloc(SEG_BYTES, 65 + (index % 26));
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
    body: JSON.stringify(payload),
  });
}

async function waitFor(fn, { timeout = 20000, label = '条件' } = {}) {
  const until = Date.now() + timeout;
  for (;;) {
    const value = await fn().catch(() => null);
    if (value) return value;
    if (Date.now() > until) throw new Error(`等待超时：${label}`);
    await sleep(150);
  }
}

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

const itemsOf = (res) => res.body?.items ?? res.body?.queue?.items ?? [];
const itemOf = (res, start) => itemsOf(res).find((i) => i.range?.start === start);

await rm(WORK, { recursive: true, force: true });
await mkdir(WORK, { recursive: true });
await new Promise((r) => origin.listen(ORIGIN, '127.0.0.1', r));

let gui = spawnGui();
const playlistUrl = `http://127.0.0.1:${ORIGIN}/play.m3u8`;

try {
  await waitFor(async () => (await api('/api/state')).ok, { label: '服务启动' });

  console.log('\n1. 探测播放列表');
  const probe = await post('/api/probe', { url: playlistUrl });
  check(probe.ok && probe.body.total === TOTAL, '探测返回总片数', `total=${probe.body.total}`);
  check(Math.round(probe.body.totalDuration) === TOTAL, '探测返回总时长', `${probe.body.totalDuration}s`);

  console.log('\n2. 非法输入');
  const badRange = await post('/api/queue', { urls: [playlistUrl], range: { start: 9, end: 3 } });
  check(!badRange.ok && badRange.status === 400, '起始大于结束被拒绝', String(badRange.body.error ?? ''));
  const badMulti = await post('/api/queue', {
    urls: [playlistUrl, `${playlistUrl}?ep=2`],
    range: { start: 1, end: 5 },
  });
  check(!badMulti.ok && badMulti.status === 400, '按需下载不接受多个链接', String(badMulti.body.error ?? ''));

  console.log('\n3. 入队区间任务');
  const added = await post('/api/queue', { urls: [playlistUrl], range: RANGE, speed: 4, jitter: 0 });
  check(added.ok && added.body.added === 1, '区间任务入队成功');
  const queued = itemOf(added, RANGE.start);
  check(
    queued?.range?.end === RANGE.end,
    '队列快照带上区间',
    JSON.stringify(queued?.range),
  );

  console.log('\n4. 等待任务完成');
  await post('/api/queue/start', {});
  await waitFor(
    async () => {
      const snap = await api('/api/queue');
      const item = itemOf(snap, RANGE.start);
      return item && item.status !== 'running' && item.status !== 'pending' ? item : null;
    },
    { timeout: 30000, label: '任务结束' },
  );

  const snap = await api('/api/queue');
  const item = itemOf(snap, RANGE.start);
  check(item.status === 'done', '任务状态为完成', item.status);
  check(item.total === RANGE.end - RANGE.start + 1, '总数等于区间长度', `total=${item.total}`);
  check(item.downloaded === item.total, '区间内分片全部下载', `${item.downloaded}/${item.total}`);
  check(item.playlistTotal === TOTAL, '记录原片总数', `playlistTotal=${item.playlistTotal}`);

  console.log('\n5. 磁盘产物');
  const taskDir = join(WORK, 'downloads', item.taskName);
  const files = (await readdir(join(taskDir, 'segments')).catch(() => [])).sort();
  check(files.length === RANGE.end - RANGE.start + 1, '磁盘上只有区间内的分片', `${files.length} 个`);
  check(
    files[0] === `${String(RANGE.start).padStart(4, '0')}.ts` &&
      files[files.length - 1] === `${String(RANGE.end).padStart(4, '0')}.ts`,
    '分片文件名保留原序号',
    `${files[0]} … ${files[files.length - 1]}`,
  );

  const output = await stat(join(taskDir, 'output.ts')).catch(() => null);
  check(
    output?.size === (RANGE.end - RANGE.start + 1) * SEG_BYTES,
    '成品大小等于区间分片字节之和',
    `${output?.size} B`,
  );

  const state = JSON.parse(await readFile(join(taskDir, 'state.json'), 'utf8'));
  check(
    state.range?.start === RANGE.start && state.range?.end === RANGE.end,
    'state.json 记录了区间（断电恢复要用）',
    JSON.stringify(state.range),
  );

  console.log('\n6. 重复与并存');
  const again = await post('/api/queue', { urls: [playlistUrl], range: RANGE, speed: 4 });
  check(
    again.ok && again.body.added === 0 && again.body.duplicates === 1,
    '同一链接同一区间不会重复入队',
    JSON.stringify({ added: again.body.added, duplicates: again.body.duplicates }),
  );

  const other = await post('/api/queue', { urls: [playlistUrl], range: { start: 21, end: 25 }, speed: 4 });
  check(other.ok && other.body.added === 1, '同一链接的不同区间可以并存', `added=${other.body.added}`);
  const otherItem = itemOf(other, 21);
  check(Boolean(otherItem) && otherItem.taskName !== item.taskName, '不同区间的目录名不冲突', otherItem?.taskName ?? '-');

  console.log('\n7. 断电续传：只补区间内的缺失分片');
  const p2 = await post('/api/queue', { urls: [playlistUrl], range: RANGE2, speed: 2, jitter: 0 });
  check(p2.ok && p2.body.added === 1, '第二个区间任务入队');
  const p2Item = itemOf(p2, RANGE2.start);
  await post('/api/queue/start', {});

  // 队列里的 downloaded 只在任务结束时才更新，所以直接看磁盘上落了几片
  const liveSegDir = join(WORK, 'downloads', p2Item.taskName, 'segments');
  const countLive = async () =>
    (await readdir(liveSegDir).catch(() => [])).filter((n) => n.endsWith('.ts')).length;

  await waitFor(async () => (await countLive()) >= 3, { timeout: 30000, label: '下到 3 片' });
  const beforeKill = await countLive();
  check(beforeKill < 10, '断电前只下了一部分', `${beforeKill}/10`);

  gui.kill('SIGKILL');
  await sleep(600);
  gui = spawnGui();

  const recovered = await waitFor(
    async () => {
      const s = await api('/api/queue');
      const it = itemOf(s, RANGE2.start);
      return it && it.status === 'interrupted' ? it : null;
    },
    { timeout: 20000, label: '恢复为中断' },
  );
  check(recovered.total === 10, '恢复后总数仍是区间长度', `total=${recovered.total}`);
  check(
    recovered.downloaded >= 2 && recovered.downloaded < 10,
    '磁盘上已下载的分片被认领',
    `${recovered.downloaded}/10`,
  );
  check(
    recovered.range?.start === RANGE2.start && recovered.range?.end === RANGE2.end,
    '恢复后区间还在',
    JSON.stringify(recovered.range),
  );
  check(
    recovered.failed.every((n) => n >= RANGE2.start && n <= RANGE2.end),
    '缺失列表只含区间内序号',
    recovered.failed.join(','),
  );

  await post('/api/queue/retry', { id: recovered.id });
  await post('/api/queue/start', {});
  const resumed = await waitFor(
    async () => {
      const s = await api('/api/queue');
      const it = itemOf(s, RANGE2.start);
      return it && it.status === 'done' ? it : null;
    },
    { timeout: 30000, label: '续传完成' },
  );
  check(resumed.downloaded === 10, '续传后区间内分片补满', `${resumed.downloaded}/10`);

  const out2 = await stat(join(WORK, 'downloads', resumed.taskName, 'output.ts')).catch(() => null);
  check(out2?.size === 10 * SEG_BYTES, '续传后成品大小正确', `${out2?.size} B`);
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
