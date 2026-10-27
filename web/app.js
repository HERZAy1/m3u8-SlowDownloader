const $ = (id) => document.getElementById(id);

const logEl = $('log');
const emptyEl = $('empty');
const fillEl = $('fill');
const MAX_LINES = 4000;
const SETTINGS_KEY = 'm3u8dl.settings';
const FORM_INPUTS = ['url', 'speed', 'jitter', 'retries', 'limit', 'out', 'remux'];

let paused = false;
let total = 0;

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

/* ---------------- 输出区 ---------------- */

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

/** 里程碑行：加粗标题 + 灰色附注 */
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

/** 普通附注行 */
function note(text) {
  const el = document.createElement('div');
  el.className = 'banner';
  el.textContent = text;
  push(el);
}

/** 表格化的一行 */
function row(cells, cls) {
  const el = document.createElement('div');
  el.className = `ln${cls ? ` ${cls}` : ''}`;
  for (const [name, text] of cells) {
    const span = document.createElement('span');
    span.className = name;
    span.textContent = text;
    el.appendChild(span);
  }
  push(el);
}

function segmentRow(event) {
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
  );
}

function retryRow(event) {
  row(
    [
      ['t', clock()],
      ['g', '↻'],
      ['msg', `#${event.index} ${event.message} — 第 ${event.attempt} 次重试`],
    ],
    'warn',
  );
}

/* ---------------- 状态与进度 ---------------- */

function setState(text, cls) {
  $('termstate').textContent = text;
  $('dot').className = `dot ${cls}`;
}

function setRunning(running) {
  $('start').disabled = running;
  $('cancel').disabled = !running;
  $('pause').disabled = !running;
  $('pause').textContent = '暂停';
  paused = false;

  for (const id of FORM_INPUTS) $(id).disabled = running;
  for (const chip of document.querySelectorAll('#speedchips button')) chip.disabled = running;
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
}

function showResult(path, bytes) {
  const parts = String(path).split(/[\\/]/);
  const name = parts.pop() || 'output.ts';
  const taskName = parts.pop() || '';
  $('resultname').textContent = name;
  $('resultsize').textContent = bytes ? `${fmtSize(bytes)} · ${path}` : path;
  $('download').href = taskName ? `/api/download?task=${encodeURIComponent(taskName)}` : '/api/download';
  $('result').hidden = false;
}

/* ---------------- 设置持久化 ---------------- */

function saveSettings() {
  const data = {
    url: $('url').value,
    speed: $('speed').value,
    jitter: $('jitter').value,
    retries: $('retries').value,
    out: $('out').value,
    remux: $('remux').checked,
  };
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(data));
  } catch {
    /* 隐私模式下 localStorage 可能不可用，忽略 */
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

async function start() {
  const url = $('url').value.trim();
  if (!url) {
    note('请先填写播放列表地址');
    $('url').focus();
    return;
  }

  const body = {
    url,
    speed: Number($('speed').value),
    jitter: Number($('jitter').value),
    retries: Number($('retries').value),
    remux: $('remux').checked,
  };
  const out = $('out').value.trim();
  if (out) body.outDir = out;
  const limit = $('limit').value.trim();
  if (limit) body.limit = Number(limit);

  const res = await fetch('/api/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    note(`启动失败：${err.error || res.status}`);
    return;
  }

  saveSettings();
  clearLog();
  total = 0;
  fillEl.style.width = '0%';
  $('result').hidden = true;
  setRunning(true);
  setState('启动中', 'run');
  banner('任务启动', `${body.speed}x`, url);
}

async function control(action) {
  await fetch('/api/control', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
  });
}

$('start').addEventListener('click', start);

$('pause').addEventListener('click', async () => {
  paused = !paused;
  await control(paused ? 'pause' : 'resume');
  $('pause').textContent = paused ? '继续' : '暂停';
  setState(paused ? '已暂停' : '下载中', paused ? 'idle' : 'run');
  banner(paused ? '已暂停' : '已继续');
});

$('cancel').addEventListener('click', async () => {
  await control('cancel');
  banner('已请求取消');
});

$('cleanup').addEventListener('click', async () => {
  const task = new URL($('download').href, location.origin).searchParams.get('task');
  if (!task) {
    note('无法确定任务名');
    return;
  }
  if (!confirm(`删除 ${task} 的分片目录？\n\n成品文件不受影响，但删除后无法再续传。`)) return;

  const res = await fetch('/api/cleanup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task }),
  });

  if (res.ok) {
    const data = await res.json();
    banner('分片已清理', `释放 ${(data.freedBytes / 1024 / 1024 / 1024).toFixed(2)} GB`);
  } else {
    const err = await res.json().catch(() => ({}));
    note(`清理失败：${err.error || res.status}`);
  }
});

$('speedchips').addEventListener('click', (event) => {
  const chip = event.target.closest('button[data-speed]');
  if (!chip) return;
  $('speed').value = chip.dataset.speed;
  syncChips();
  saveSettings();
});

$('speed').addEventListener('input', syncChips);

for (const id of ['jitter', 'retries', 'out', 'url']) {
  $(id).addEventListener('change', saveSettings);
}

$('remux').addEventListener('change', saveSettings);

document.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !$('start').disabled) {
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT') {
      event.preventDefault();
      start();
    }
  } else if (event.key === 'Escape' && !$('cancel').disabled) {
    event.preventDefault();
    $('cancel').click();
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

  switch (event.type) {
    case 'playlist':
      total = event.total;
      banner(
        '清单解析完成',
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
      segmentRow(event);
      break;

    case 'error':
      retryRow(event);
      break;

    case 'log':
      note(event.message);
      break;

    case 'done':
      fillEl.style.width = '100%';
      if (event.failed.length > 0) {
        banner('任务结束', `失败 ${event.failed.length} 片`, '未拼接');
        setState('有失败', 'err');
      } else if (event.outputPath) {
        showResult(event.outputPath, event.bytes);
        banner('任务完成', fmtDuration(event.elapsedMs), fmtSize(event.bytes), event.outputPath);
        setState('已完成', 'done');
      } else {
        banner('任务完成', fmtDuration(event.elapsedMs));
        setState('已完成', 'done');
      }
      setRunning(false);
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
      } else if (event.phase === 'done') setState('已完成', 'done');
      else if (event.phase === 'failed') {
        setState('失败', 'err');
        setRunning(false);
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
if (saved.url) $('url').value = saved.url;
if (saved.speed !== undefined) $('speed').value = saved.speed;
if (saved.jitter !== undefined) $('jitter').value = saved.jitter;
if (saved.retries !== undefined) $('retries').value = saved.retries;
if (saved.out !== undefined) $('out').value = saved.out;
if (saved.remux !== undefined) $('remux').checked = Boolean(saved.remux);
syncChips();

fetch('/api/state')
  .then((r) => r.json())
  .then((state) => {
    if (state.running) {
      setRunning(true);
      setState('运行中', 'run');
      note('检测到已有任务在运行，正在同步进度…');
    }
    if (state.output) {
      showResult(state.output.path, state.output.size);
      note('发现已完成的产物，可直接下载');
    }
  })
  .catch(() => {});
