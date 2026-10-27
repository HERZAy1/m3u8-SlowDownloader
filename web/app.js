const $ = (id) => document.getElementById(id);

const logEl = $('log');
const fillEl = $('fill');
let paused = false;

function fmtDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map((v) => String(v).padStart(2, '0')).join(':');
}

function fmtSize(bytes) {
  if (!bytes) return '0 MB';
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function log(message, cls) {
  const line = document.createElement('div');
  if (cls) line.className = cls;
  line.textContent = message;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

function setRunning(running) {
  $('start').disabled = running;
  $('cancel').disabled = !running;
  $('pause').disabled = !running;
  $('pause').textContent = '暂停';
  paused = false;
}

function showResult(path, bytes) {
  const name = path.split(/[\\/]/).pop() || 'output.ts';
  $('resultname').textContent = name;
  $('resultsize').textContent = `${fmtSize(bytes)} · ${path}`;
  $('result').hidden = false;
}

function renderProgress(snap) {
  const pct = snap.total > 0 ? (snap.completed / snap.total) * 100 : 0;
  fillEl.style.width = `${pct.toFixed(1)}%`;
  $('pct').textContent = `${pct.toFixed(1)}%`;
  $('count').textContent = `${snap.completed}/${snap.total}`;
  $('elapsed').textContent = fmtDuration(snap.elapsedMs);
  $('eta').textContent = snap.speed > 0 ? fmtDuration(snap.etaMs) : '—';
  $('size').textContent = fmtSize(snap.bytes);
}

async function start() {
  const url = $('url').value.trim();
  if (!url) {
    log('请填写播放列表地址', 'err');
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
    log(err.error || `启动失败（HTTP ${res.status}）`, 'err');
    return;
  }

  logEl.innerHTML = '';
  fillEl.style.width = '0%';
  $('result').hidden = true;
  setRunning(true);
  log('任务已启动');
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
  log(paused ? '已暂停' : '已继续', 'warn');
});

$('cancel').addEventListener('click', async () => {
  await control('cancel');
  log('已请求取消', 'warn');
});

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
      log(
        `分片 ${event.total} 个，总时长 ${fmtDuration(event.totalDuration * 1000)}，` +
          `断点 ${event.discontinuities} 个，${event.isVod ? '静态点播' : '非点播'}`,
        'ok',
      );
      break;

    case 'progress':
      renderProgress(event.snapshot);
      break;

    case 'segment':
      if (!event.ok) log(`分片 ${event.index} 失败`, 'err');
      else if (event.index % 100 === 0) log(`已下载 ${event.index} 片`, 'ok');
      break;

    case 'error':
      log(`分片 ${event.index} 第 ${event.attempt} 次失败：${event.message}`, 'err');
      break;

    case 'log':
      log(event.message, 'warn');
      break;

    case 'done':
      fillEl.style.width = '100%';
      if (event.failed.length > 0) {
        log(`失败分片 ${event.failed.length} 个，未拼接`, 'err');
      } else if (event.outputPath) {
        showResult(event.outputPath, event.bytes);
        log('完成，可在上方下载', 'ok');
      } else {
        log(`完成，用时 ${fmtDuration(event.elapsedMs)}`, 'ok');
      }
      setRunning(false);
      break;

    case 'phase':
      if (event.phase === 'merging') log('正在拼接…');
      if (event.phase === 'remuxing') log('正在用 ffmpeg 修复时间戳…');
      if (event.phase === 'failed') setRunning(false);
      break;

    default:
      break;
  }
};

events.onerror = () => {
  // EventSource 会自动重连，这里不打断用户
};

fetch('/api/state')
  .then((r) => r.json())
  .then((state) => {
    if (state.running) {
      setRunning(true);
      log('检测到已有任务在运行，正在同步进度…', 'warn');
    }
  })
  .catch(() => {});
