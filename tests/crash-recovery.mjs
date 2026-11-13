/**
 * 断电续传端到端验证。
 *
 * 场景：起一个本地片源 → 队列下载到一半 → 直接 kill（模拟断电，
 * 不走任何优雅退出）→ 重启服务 → 断言队列被恢复、状态是「中断」→
 * 继续下载 → 断言没有重新下载任何已存在的分片。
 *
 * 用法：node tests/crash-recovery.mjs
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const WORK = join(ROOT, 'tests', '.work');
const ENTRY = join(ROOT, 'src', 'server.ts');
const PORT = 7799;
const ORIGIN = 7801;
const TOTAL = 40;
const SEG_BYTES = 400;

const counts = new Map();
let phase = 'idle';

const origin = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${ORIGIN}`);
  counts.set(url.pathname, (counts.get(url.pathname) ?? 0) + 1);

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

const segHits = () => [...counts.entries()].filter(([p]) => p.endsWith('.ts')).reduce((s, [, n]) => s + n, 0);

function log(...args) {
  console.log(`${new Date().toISOString().slice(11, 23)}  ${args.join(' ')}`);
}

function spawnGui() {
  const child = spawn(process.execPath, [ENTRY], {
    cwd: WORK,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => log(`[gui] ${String(d).trim()}`));
  child.stderr.on('data', (d) => log(`[gui!] ${String(d).trim()}`));
  return child;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeout = 8000, label = '条件' } = {}) {
  const until = Date.now() + timeout;
  for (;;) {
    const value = await fn().catch(() => null);
    if (value) return value;
    if (Date.now() > until) throw new Error(`等待超时：${label}`);
    await sleep(120);
  }
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

async function waitHealthy() {
  await waitFor(async () => (await api('/api/state')).ok, { label: '服务启动', timeout: 15000 });
}

const assertions = [];
function check(name, pass, detail = '') {
  assertions.push({ name, pass, detail });
  log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}

async function main() {
  // Windows 上被刚杀掉的进程可能还挂着目录句柄，删不掉就等一下重试
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await rm(WORK, { recursive: true, force: true });
      break;
    } catch (err) {
      if (attempt === 9) throw err;
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  await mkdir(WORK, { recursive: true });
  await new Promise((r) => origin.listen(ORIGIN, '127.0.0.1', r));
  log(`片源已启动 http://127.0.0.1:${ORIGIN}/play.m3u8  ${TOTAL} 片`);

  let gui = spawnGui();
  await waitHealthy();

  // ---- 阶段 1：入队并跑到一半 ----
  phase = 'run';
  const added = await api('/api/queue', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      urls: [`http://127.0.0.1:${ORIGIN}/play.m3u8`],
      speed: 5,
      jitter: 0,
      note: '断电测试',
    }),
  });
  check('入队成功', added.ok && added.body.added === 1, JSON.stringify(added.body?.added));

  await api('/api/queue/start', { method: 'POST' });
  const segDir = join(WORK, 'downloads', '断电测试', 'segments');
  const diskSegs = async () => (await readdir(segDir).catch(() => [])).filter((n) => n.endsWith('.ts')).length;

  await waitFor(async () => ((await diskSegs()) >= 8 ? true : null), {
    label: '磁盘上有 8 片',
    timeout: 20000,
  });

  const midwayCount = await diskSegs();
  const midway = (await api('/api/queue')).body.items[0];
  log(`断电前：磁盘上 ${midwayCount} 片，队列状态 ${midway.status}`);

  // ---- 阶段 2：kill -9，模拟直接断电 ----
  phase = 'kill';
  const killed = new Promise((r) => gui.once('exit', r));
  gui.kill('SIGKILL');
  await killed;
  log('已强制杀掉服务进程（无优雅退出）');

  const hitsAtCrash = segHits();
  await sleep(300);

  // ---- 阶段 3：重启，检查是否恢复 ----
  gui = spawnGui();
  await waitHealthy();

  const after = (await api('/api/queue')).body;
  check('重启后队列不是空的', after.items.length === 1, `items=${after.items.length}`);

  const item = after.items[0] ?? {};
  check('状态为「中断」', item.status === 'interrupted', `status=${item.status}`);
  check('恢复了原始链接', item.url === `http://127.0.0.1:${ORIGIN}/play.m3u8`, item.url);
  check('恢复了备注名', item.note === '断电测试', String(item.note));
  check('总分片数正确', item.total === TOTAL, `total=${item.total}`);
  check(
    '已下载分片数从磁盘还原',
    item.downloaded >= midwayCount - 1 && item.downloaded <= midwayCount + 1,
    `重启后=${item.downloaded}，断电前=${midwayCount}`,
  );

  // state.json 应该已经被写成 interrupted
  const state = JSON.parse(await readFile(join(WORK, 'downloads', '断电测试', 'state.json'), 'utf8'));
  check('state.json 记录了链接', state.url === item.url, state.url);
  check('state.json 标记 interrupted', state.status === 'interrupted', String(state.status));

  // ---- 阶段 4：继续下载，断言不重下 ----
  const retried = await api('/api/queue/retry', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: item.id }),
  });
  check('可以继续（retry 成功）', retried.ok, JSON.stringify(retried.body));

  const before = segHits();
  await api('/api/queue/start', { method: 'POST' });
  await waitFor(
    async () => {
      const snap = (await api('/api/queue')).body;
      const it = snap.items[0];
      return it && (it.status === 'done' || it.status === 'failed') ? it : null;
    },
    { label: '续传完成', timeout: 30000 },
  );

  const final = (await api('/api/queue')).body.items[0];
  const fetched = segHits() - before;
  check('续传后完成', final.status === 'done', `status=${final.status} failed=${final.failed.length}`);
  check(
    '只补了缺失分片（没有重下）',
    fetched <= TOTAL - midwayCount + 2,
    `续传期间请求 ${fetched} 次，断电前已下载 ${midwayCount} 片`,
  );
  check('没有重复请求幂等性被破坏', segHits() <= TOTAL + 4, `总共请求分片 ${segHits()} 次（${TOTAL} 片）`);

  // 成品大小 = 分片字节数之和
  const out = join(WORK, 'downloads', '断电测试', 'output.ts');
  const outInfo = await stat(out).catch(() => null);
  check('成品存在且大小正确', outInfo?.size === TOTAL * SEG_BYTES, `size=${outInfo?.size}`);

  // ---- 阶段 5：再杀一次，删掉队列存档，模拟存档也丢了 ----
  phase = 'wipe';
  const killed2 = new Promise((r) => gui.once('exit', r));
  gui.kill('SIGKILL');
  await killed2;
  await rm(join(WORK, 'state', 'queue.json'), { force: true });
  log('已删除队列存档，只留磁盘上的任务目录');

  gui = spawnGui();
  await waitHealthy();

  const recovered = (await api('/api/queue')).body.items;
  const rec = recovered.find((i) => i.note === '断电测试') ?? recovered[0] ?? {};
  check('存档丢失也能靠磁盘认领回来', recovered.length === 1, `items=${recovered.length}`);
  check('认领后是完成态', rec.status === 'done', `status=${rec.status}`);
  check('认领后有成品可下载', Boolean(rec.outputPath), String(rec.outputPath));

  // ---- 阶段 6：重新导入同一个链接，必须复用而不是新建目录 ----
  const again = await api('/api/queue', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ urls: [`http://127.0.0.1:${ORIGIN}/play.m3u8`], speed: 5, jitter: 0 }),
  });
  check('重复导入不会新建任务', again.body.duplicates === 1 || again.body.completed === 1, JSON.stringify(again.body));
  const dirs = (await api('/api/files')).body.tasks.map((t) => t.name);
  check('磁盘上没有出现 -2 之类的新目录', dirs.length === 1, dirs.join(','));

  const dl = await fetch(`http://127.0.0.1:${PORT}/api/download?path=${encodeURIComponent(join(WORK, 'downloads', '断电测试'))}`);
  const bytes = (await dl.arrayBuffer()).byteLength;
  check('可以直接下载成品', dl.ok && bytes === TOTAL * SEG_BYTES, `${dl.status} ${bytes}B`);

  // ---- 阶段 7：模拟老版本留下的目录（state.json 里没有 url）----
  phase = 'legacy';
  const killed3 = new Promise((r) => gui.once('exit', r));
  gui.kill('SIGKILL');
  await killed3;

  const legacy = join(WORK, 'downloads', 'play');
  await mkdir(join(legacy, 'segments'), { recursive: true });
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:1', '#EXT-X-MEDIA-SEQUENCE:0'];
  for (let i = 1; i <= TOTAL; i += 1) lines.push('#EXTINF:1.000,', `seg${String(i).padStart(4, '0')}.ts`);
  lines.push('#EXT-X-ENDLIST', '');
  await writeFile(join(legacy, 'playlist.m3u8'), lines.join('\n'), 'utf8');
  await writeFile(
    join(legacy, 'state.json'),
    JSON.stringify({ version: 1, createdAt: new Date().toISOString(), t0: Date.now(), speed: 20, total: TOTAL, failed: [], elapsedMs: 5000 }, null, 2),
    'utf8',
  );
  for (let i = 1; i <= 4; i += 1) {
    await writeFile(join(legacy, 'segments', `${String(i).padStart(4, '0')}.ts`), Buffer.alloc(SEG_BYTES, 65));
  }
  log(`已伪造一个老版本任务目录 downloads/play（state.json 里没有 url，只有 4/${TOTAL} 片）`);

  gui = spawnGui();
  await waitHealthy();

  const items2 = (await api('/api/queue')).body.items;
  const old = items2.find((i) => i.note === 'play') ?? {};
  check('老目录被认领', Boolean(old.id), `items=${items2.length}`);
  check('老目录没有链接时提示绑定', old.status === 'interrupted' && old.url === '', `status=${old.status} url=${old.url ?? '?'}`);
  check(`老目录算出缺 ${TOTAL - 4} 片`, old.failed?.length === TOTAL - 4, `failed=${old.failed?.length}`);

  const attached = await api('/api/queue/attach', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: old.id, url: `http://127.0.0.1:${ORIGIN}/play.m3u8` }),
  });
  check('绑定链接成功', attached.ok, JSON.stringify(attached.body?.error ?? ''));

  const beforeLegacy = segHits();
  await api('/api/queue/retry', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: old.id }),
  });
  await api('/api/queue/start', { method: 'POST' });
  await waitFor(
    async () => {
      const snap = (await api('/api/queue')).body;
      const it = snap.items.find((i) => i.note === 'play');
      return it && (it.status === 'done' || it.status === 'failed') ? it : null;
    },
    { label: '老目录续传完成', timeout: 30000 },
  );
  const legacyFetched = segHits() - beforeLegacy;
  check(`老目录只补了缺失的 ${TOTAL - 4} 片`, legacyFetched === TOTAL - 4, `请求 ${legacyFetched} 次`);
  const legacyOut = await stat(join(legacy, 'output.ts')).catch(() => null);
  check('老目录成品大小正确', legacyOut?.size === TOTAL * SEG_BYTES, `size=${legacyOut?.size}`);

  gui.kill('SIGKILL');
  origin.close();

  const failed = assertions.filter((a) => !a.pass);
  console.log(`\n${assertions.length - failed.length}/${assertions.length} 项通过`);
  if (failed.length > 0) {
    console.log('失败项：');
    for (const f of failed) console.log(` - ${f.name} ${f.detail}`);
    process.exit(1);
  }
  console.log('全部通过 ✅');
  process.exit(0);
}

try {
  await main();
} catch (err) {
  console.error(`\n测试异常中断（阶段 ${phase}）：${err?.stack ?? err}`);
  origin.close();
  process.exit(1);
}
