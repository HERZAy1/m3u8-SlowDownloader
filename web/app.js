const $ = (id) => document.getElementById(id);

const logEl = $('log');
const emptyEl = $('empty');
const fillEl = $('fill');
const listEl = $('queuelist');
const emptyRow = $('queueempty');

const MAX_LINES = 4000;
const SETTINGS_KEY = 'm3u8dl.settings';

const STATUS_ICON = { pending: '○', running: '●', done: '✓', failed: '✗', cancelled: '⊘' };
const STATUS_TEXT = {
  pending: '待处理',
  running: '下载中',
  done: '完成',
  failed: '有缺失分片',
  cancelled: '已取消',
};

let queue = [];
let runningId = null;
let queuePaused = false;
let jobOrder = new Map();
let total = 0;
let maxQueue = 20;

/* ---------------- 格式化 ---------------- */

const pad = (n) => String(n).padStart(2, '0');

function clock() {
  const d = new Date();
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function fmtDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

function fmtSize(bytes) {
  if (!bytes) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

/** [747,748,749,800] -> "747-749, 800" */
function fmtRanges(nums) {
  if (!nums || nums.length === 0) return '';
  const sorted = [...nums].sort((a, b) => a - b);
  const parts = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (let i = 1; i <= sorted.length; i += 1) {
    const n = sorted[i];
    if (n === prev + 1) {
      prev = n;
      continue;
    }
    parts.push(start === prev ? `${start}` : `${start}-${prev}`);
    start = n;
    prev = n;
  }
  return parts.join(', ');
}

/* ---------------- 终端输出 ---------------- */

function nearBottom() {
  return logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 48;
}

function push(node) {
  if (emptyEl) emptyEl.classList.add('hide');
  const stick = nearBottom();
  logEl.appendChild(node);
  while (logEl.childElementCount > MAX_LINES + 1) logEl.removeChild(logEl.firstChild);
  if (stick) logEl.scrollTop = logEl.scrollHeight;
}

function clearLog() {
  logEl.innerHTML = '';
  if (emptyEl) {
    emptyEl.classList.remove('hide');
    logEl.appendChild(emptyEl);
  }
}

function banner(title, ...meta) {
  const el = document.createElement('div');
  el.className = 'banner';
  const strong = document.createElement('b');
  strong.textContent = title;
  el.appendChild(strong);
  for (const item of meta) {
    const span = document.createElement('span');
    span.className = 'dim';
    span.textContent = `  ${item}`;
    el.appendChild(span);
  }
  push(el);
}

function note(text) {
  const el = document.createElement('div');
  el.className = 'banner';
  el.textContent = text;
  push(el);
}

function row(cells, cls, jobId) {
  const el = document.createElement('div');
  el.className = `ln${cls ? ` ${cls}` : ''}`;

  if (jobId && queue.length > 1) {
    const j = document.createElement('span');
    j.className = 'j';
    j.textContent = `[${jobOrder.get(jobId) ?? '?'}]`;
    el.appendChild(j);
  }

  for (const [name, text] of cells) {
    const span = document.createElement('span');
    span.className = name;
    span.textContent = text;
    el.appendChild(span);
  }
  push(el);
}

function segmentRow(event, jobId) {
  const pct = total > 0 ? (event.index / total) * 100 : 0;
  row(
    [
      ['t', clock()],
      ['g', event.ok ? '✓' : '✗'],
      ['i', `${event.index}/${total || '?'}`],
      ['p', `${pct.toFixed(1)}%`],
      ['b', fmtSize(event.bytes)],
      ['d', `${((event.finishedAt - event.startedAt) / 1000).toFixed(2)}s`],
    ],
    event.ok ? 'ok' : 'err',
    jobId,
  );
}

function retryRow(event, jobId) {
  row(
    [
      ['t', clock()],
      ['g', '↻'],
      ['msg', `#${event.index} ${event.message} — 第 ${event.attempt} 次重试`],
    ],
    'warn',
    jobId,
  );
}

/* ---------------- 状态 ---------------- */

function setState(text, cls) {
  $('termstate').textContent = text;
  $('dot').className = `dot ${cls}`;
}

function renderProgress(snap) {
  const pct = snap.total > 0 ? (snap.completed / snap.total) * 100 : 0;
  fillEl.style.width = `${pct.toFixed(1)}%`;
  $('pct').textContent = `${pct.toFixed(1)}%`;
  $('count').textContent = `${snap.completed}/${snap.total}`;
  $('elapsed').textContent = fmtDuration(snap.elapsedMs);
  $('eta').textContent = snap.speed > 0 ? fmtDuration(snap.etaMs) : '—';
  $('size').textContent = fmtSize(snap.bytes);
  $('termcount').textContent = `${snap.completed}/${snap.total}`;
  $('termspeed').textContent = snap.speed > 0 ? `${snap.speed}x` : '不限速';

  const live = listEl.querySelector('.queue-row.running .q-meta');
  if (live) live.textContent = `${snap.completed}/${snap.total}`;
}

/* ---------------- 队列渲染 ---------------- */

function metaText(item) {
  if (item.status === 'pending') return '待处理';
  if (item.status === 'running') return `${item.downloaded}/${item.total || '?'}`;
  if (item.status === 'cancelled') return '已取消';
  if (item.status === 'failed') return `${item.downloaded}/${item.total} · 缺 ${item.failed.length} 片`;
  return `${item.downloaded}/${item.total} · ${fmtSize(item.bytes)} · ${fmtDuration(item.elapsedMs)}`;
}

function queueRow(item, index) {
  const el = document.createElement('div');
  el.className = `queue-row ${item.status}`;

  const idx = document.createElement('span');
  idx.className = 'q-idx';
  idx.textContent = `#${index}`;

  const status = document.createElement('span');
  status.className = 'q-status';
  status.textContent = STATUS_ICON[item.status] ?? '?';
  status.title = STATUS_TEXT[item.status] ?? '';

  const url = document.createElement('span');
  url.className = 'q-url';
  url.textContent = item.url;
  url.title = item.url;

  const meta = document.createElement('span');
  meta.className = 'q-meta';
  meta.textContent = metaText(item);

  const actions = document.createElement('span');
  actions.className = 'q-actions';

  if ((item.status === 'done' || item.status === 'failed') && item.outputPath) {
    const link = document.createElement('a');
    link.href = `/api/download?job=${encodeURIComponent(item.id)}`;
    link.textContent = '下载';
    link.setAttribute('download', '');
    actions.appendChild(link);

    const clean = document.createElement('button');
    clean.textContent = '清理';
    clean.addEventListener('click', () => cleanup(item));
    actions.appendChild(clean);
  }

  if (item.status !== 'running') {
    const remove = document.createElement('button');
    remove.textContent = '移除';
    remove.addEventListener('click', () => removeItem(item.id));
    actions.appendChild(remove);
  }

  el.append(idx, status, url, meta, actions);
  return el;
}

function renderQueue() {
  const finished = queue.filter((i) => i.status === 'done' || i.status === 'failed' || i.status === 'cancelled').length;
  $('queuecount').textContent = `${queue.length} / ${maxQueue}`;
  $('queuesummary').textContent = finished > 0 ? `${finished} 已完成` : '';

  listEl.innerHTML = '';
  if (queue.length === 0) {
    listEl.appendChild(emptyRow);
    return;
  }
  queue.forEach((item, i) => listEl.appendChild(queueRow(item, i + 1)));
}

function resultRow(item) {
  const complete = item.status === 'done';
  const el = document.createElement('div');
  el.className = `result-row ${complete ? 'ok' : item.status === 'cancelled' ? 'warn' : 'bad'}`;

  const icon = document.createElement('span');
  icon.className = 'r-icon';
  icon.textContent = complete ? '✓' : item.status === 'cancelled' ? '⊘' : '✗';

  const body = document.createElement('span');
  body.className = 'r-body';

  const name = document.createElement('span');
  name.className = 'r-name';
  name.textContent = item.url;
  name.title = item.url;
  body.appendChild(name);

  if (complete) {
    const noteEl = document.createElement('span');
    noteEl.className = 'r-note';
    noteEl.textContent = `完整 · ${item.total} 片 · ${fmtSize(item.bytes)} · ${fmtDuration(item.elapsedMs)}`;
    body.appendChild(noteEl);
  } else if (item.status === 'failed') {
    const miss = document.createElement('span');
    miss.className = 'r-missing';
    miss.textContent =
      item.failed.length > 0
        ? `缺 ${item.failed.length} 片：${fmtRanges(item.failed)}`
        : `失败：${item.error ?? '未知原因'}`;
    body.appendChild(miss);
  } else {
    const noteEl = document.createElement('span');
    noteEl.className = 'r-note';
    noteEl.textContent = '已取消';
    body.appendChild(noteEl);
  }

  const meta = document.createElement('span');
  meta.className = 'r-meta';
  meta.textContent = item.status === 'cancelled' ? '—' : `${item.downloaded}/${item.total}`;

  const actions = document.createElement('span');
  actions.className = 'r-actions';

  if (item.status === 'failed' || item.status === 'cancelled') {
    const retry = document.createElement('button');
    retry.className = 'primary small';
    retry.textContent = '补齐缺失';
    retry.addEventListener('click', () => retryItem(item));
    actions.appendChild(retry);
  }

  if (item.outputPath) {
    const link = document.createElement('a');
    link.href = `/api/download?job=${encodeURIComponent(item.id)}`;
    link.textContent = '下载';
    link.setAttribute('download', '');
    actions.appendChild(link);
  }

  const remove = document.createElement('button');
  remove.textContent = '移除';
  remove.title = '从列表中移除（不影响已下载的文件）';
  remove.addEventListener('click', () => removeItem(item.id));
  actions.appendChild(remove);

  el.append(icon, body, meta, actions);
  return el;
}

function renderResults() {
  const finished = queue.filter(
    (i) => i.status === 'done' || i.status === 'failed' || i.status === 'cancelled',
  );
  const box = $('results');

  if (finished.length === 0) {
    box.hidden = true;
    return;
  }

  const okCount = finished.filter((i) => i.status === 'done').length;
  const badCount = finished.filter((i) => i.status === 'failed').length;
  const missing = finished.reduce((sum, i) => sum + i.failed.length, 0);

  $('resultsummary').textContent =
    `${finished.length} 项 · ${okCount} 完整` + (badCount ? ` · ${badCount} 待补齐（缺 ${missing} 片）` : '');

  $('retryall').hidden = !finished.some((i) => i.status === 'failed' || i.status === 'cancelled');

  const list = $('resultlist');
  list.innerHTML = '';
  finished.forEach((i) => list.appendChild(resultRow(i)));
  box.hidden = false;
}

function updateButtons() {
  const running = queue.some((i) => i.status === 'running');
  const hasFinished = queue.some(
    (i) => i.status === 'done' || i.status === 'failed' || i.status === 'cancelled',
  );

  $('start').disabled = running;
  $('pause').disabled = !running;
  $('stop').disabled = !running;
  $('clear').disabled = !hasFinished;
  $('pause').textContent = queuePaused ? '继续' : '暂停';

  for (const id of ['speed', 'jitter', 'retries', 'limit', 'out', 'remux']) $(id).disabled = running;
  for (const chip of document.querySelectorAll('#speedchips button')) chip.disabled = running;
}

function applyQueue(snap) {
  queue = snap.items;
  runningId = snap.runningId;
  queuePaused = snap.paused;
  jobOrder = new Map(queue.map((it, i) => [it.id, i + 1]));
  renderQueue();
  renderResults();
  updateButtons();
}

/* ---------------- 汇总报告 ---------------- */

function printSummary(summary) {
  if (!Array.isArray(summary) || summary.length === 0) return;

  const ok = summary.filter((i) => i.status === 'done').length;
  const bad = summary.filter((i) => i.status === 'failed').length;
  const cancelled = summary.filter((i) => i.status === 'cancelled').length;
  const pending = summary.filter((i) => i.status === 'pending').length;

  banner('队列结束', `${ok} 成功`, `${bad} 失败`, `${cancelled} 取消`, pending ? `${pending} 未执行` : '');

  for (const item of summary) {
    const mark = item.status === 'done' ? '✓' : item.status === 'failed' ? '✗' : '⊘';
    const cls = item.status === 'done' ? 'ok' : item.status === 'failed' ? 'err' : 'warn';
    const meta =
      item.status === 'pending'
        ? '未执行'
        : `${item.downloaded}/${item.total}  ${fmtSize(item.bytes)}  ${fmtDuration(item.elapsedMs)}`;

    row(
      [
        ['t', ''],
        ['g', mark],
        ['i', `#${item.index}`],
        ['msg', `${item.url}   ${meta}`],
      ],
      cls,
    );

    if (item.failed.length > 0) {
      row(
        [
          ['t', ''],
          ['g', ''],
          ['i', ''],
          ['msg', `      缺失 ${item.failed.length} 片：${fmtRanges(item.failed)}`],
        ],
        'err',
      );
    }

    if (item.error) {
      row(
        [
          ['t', ''],
          ['g', ''],
          ['i', ''],
          ['msg', `      错误：${item.error}`],
        ],
        'err',
      );
    }
  }

  setState(bad > 0 ? '队列结束（有失败）' : '队列结束', bad > 0 ? 'err' : 'done');
}

/* ---------------- 设置持久化 ---------------- */

function saveSettings() {
  try {
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        urls: $('urls').value,
        speed: $('speed').value,
        jitter: $('jitter').value,
        retries: $('retries').value,
        out: $('out').value,
        remux: $('remux').checked,
      }),
    );
  } catch {
    /* 隐私模式下不可用，忽略 */
  }
}

function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
  } catch {
    return {};
  }
}

function syncChips() {
  const value = Number($('speed').value);
  for (const chip of document.querySelectorAll('#speedchips button')) {
    chip.classList.toggle('on', Number(chip.dataset.speed) === value);
  }
}

/* ---------------- 操作 ---------------- */

async function enqueue(startNow) {
  const urls = $('urls')
    .value.split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (urls.length === 0) {
    note('请先填写至少一个地址');
    $('urls').focus();
    return;
  }

  const body = {
    urls,
    speed: Number($('speed').value),
    jitter: Number($('jitter').value),
    retries: Number($('retries').value),
    remux: $('remux').checked,
  };
  const out = $('out').value.trim();
  if (out) body.outDir = out;
  const limit = $('limit').value.trim();
  if (limit) body.limit = Number(limit);

  const res = await fetch('/api/queue', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    note(`加入队列失败：${data.error || res.status}`);
    return;
  }

  saveSettings();
  if (data.added > 0) {
    banner('已加入队列', `${data.added} 个`, `${body.speed}x`);
    $('urls').value = '';
  }
  if (data.duplicates) note(`跳过重复地址 ${data.duplicates} 个`);
  if (data.overflow) note(`队列已满（上限 ${maxQueue}），忽略 ${data.overflow} 个`);

  if (startNow) await fetch('/api/queue/start', { method: 'POST' });
}

async function control(action) {
  await fetch('/api/control', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
  });
}

async function removeItem(id) {
  const res = await fetch(`/api/queue?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    note(`移除失败：${data.error || res.status}`);
  }
}

async function cleanup(item) {
  if (!confirm(`删除 ${item.taskName} 的分片目录？\n\n成品保留，但删除后无法续传。`)) return;
  const res = await fetch('/api/cleanup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ job: item.id }),
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok) banner('分片已清理', `释放 ${(data.freedBytes / 1024 / 1024 / 1024).toFixed(2)} GB`);
  else note(`清理失败：${data.error || res.status}`);
}

$('enqueue').addEventListener('click', () => enqueue(false));

$('start').addEventListener('click', async () => {
  if ($('urls').value.trim()) await enqueue(true);
  else await fetch('/api/queue/start', { method: 'POST' });
});

$('pause').addEventListener('click', async () => {
  const next = !queuePaused;
  await control(next ? 'pause' : 'resume');
  setState(next ? '已暂停' : '下载中', next ? 'idle' : 'run');
});

$('stop').addEventListener('click', async () => {
  if (!confirm('停止队列？\n\n当前任务会被取消，尚未开始的任务保留在队列里。')) return;
  await fetch('/api/queue/stop', { method: 'POST' });
  banner('已请求停止队列');
});

async function retryItem(item) {
  const res = await fetch('/api/queue/retry', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: item.id }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    note(`补齐失败：${data.error || res.status}`);
    return;
  }
  banner('已加入补齐队列', item.url);
  await fetch('/api/queue/start', { method: 'POST' });
}

$('retryall').addEventListener('click', async () => {
  const res = await fetch('/api/queue/retry-all', { method: 'POST' });
  const data = await res.json().catch(() => ({}));
  if (data.retried) {
    banner('已加入补齐队列', `${data.retried} 个任务`);
    await fetch('/api/queue/start', { method: 'POST' });
  }
});

async function clearFinished() {
  const res = await fetch('/api/queue/clear', { method: 'POST' });
  const data = await res.json().catch(() => ({}));
  if (data.removed) note(`已清除 ${data.removed} 条已完成记录`);
}

$('clear').addEventListener('click', clearFinished);
$('clearresults').addEventListener('click', clearFinished);

$('speedchips').addEventListener('click', (event) => {
  const chip = event.target.closest('button[data-speed]');
  if (!chip) return;
  $('speed').value = chip.dataset.speed;
  syncChips();
  saveSettings();
});

$('speed').addEventListener('input', syncChips);
for (const id of ['jitter', 'retries', 'out', 'urls']) $(id).addEventListener('change', saveSettings);
$('remux').addEventListener('change', saveSettings);

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !$('stop').disabled) {
    event.preventDefault();
    $('stop').click();
  } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !$('start').disabled) {
    event.preventDefault();
    $('start').click();
  }
});

/* ---------------- 事件流 ---------------- */

const events = new EventSource('/api/events');

events.onmessage = (message) => {
  let event;
  try {
    event = JSON.parse(message.data);
  } catch {
    return;
  }

  if (event.type === 'queue') {
    applyQueue(event);
    return;
  }

  if (event.type === 'queue-done') {
    printSummary(event.summary);
    return;
  }

  const jobId = event.jobId;

  switch (event.type) {
    case 'playlist':
      total = event.total;
      banner(
        `清单解析完成${jobId && queue.length > 1 ? ` · #${jobOrder.get(jobId) ?? '?'}` : ''}`,
        `${event.total} 片`,
        fmtDuration(event.totalDuration * 1000),
        `${event.discontinuities} 个断点`,
        event.isVod ? '静态点播' : '非点播',
      );
      break;

    case 'progress':
      renderProgress(event.snapshot);
      break;

    case 'segment':
      segmentRow(event, jobId);
      break;

    case 'error':
      retryRow(event, jobId);
      break;

    case 'log':
      note(event.message);
      break;

    case 'done':
      if (event.failed.length > 0) {
        banner('任务结束', `失败 ${event.failed.length} 片`, '未拼接');
      } else if (event.outputPath) {
        banner('任务完成', fmtDuration(event.elapsedMs), fmtSize(event.bytes), event.outputPath);
      } else {
        banner('任务完成', fmtDuration(event.elapsedMs));
      }
      break;

    case 'phase':
      if (event.phase === 'parsing') setState('解析清单', 'run');
      else if (event.phase === 'downloading') setState('下载中', 'run');
      else if (event.phase === 'merging') {
        setState('拼接中', 'run');
        banner('正在拼接分片');
      } else if (event.phase === 'remuxing') {
        setState('转封装中', 'run');
        banner('正在用 ffmpeg 修复时间戳');
      }
      break;

    default:
      break;
  }
};

events.onerror = () => {
  // EventSource 自动重连
};

/* ---------------- 初始化 ---------------- */

const saved = loadSettings();
if (saved.urls) $('urls').value = saved.urls;
if (saved.speed !== undefined) $('speed').value = saved.speed;
if (saved.jitter !== undefined) $('jitter').value = saved.jitter;
if (saved.retries !== undefined) $('retries').value = saved.retries;
if (saved.out !== undefined) $('out').value = saved.out;
if (saved.remux !== undefined) $('remux').checked = Boolean(saved.remux);
syncChips();

fetch('/api/state')
  .then((r) => r.json())
  .then((state) => {
    maxQueue = state.maxQueue ?? 20;
    if (state.running) {
      setState('运行中', 'run');
      note('检测到队列正在运行，正在同步进度…');
    }
  })
  .catch(() => {});

fetch('/api/queue')
  .then((r) => r.json())
  .then((snap) => applyQueue(snap))
  .catch(() => {});
