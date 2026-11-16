const $ = (id) => document.getElementById(id);

const logEl = $('log');
const emptyEl = $('empty');
const fillEl = $('fill');
const listEl = $('queuelist');
const emptyRow = $('queueempty');
const consoleEl = $('console');

const MAX_LINES = 4000;
const SETTINGS_KEY = 'm3u8dl.settings';
const SPARK_MAX = 90;

const STATUS_ICON = {
  pending: '○',
  running: '●',
  done: '✓',
  failed: '✗',
  cancelled: '⊘',
  interrupted: '⏸',
};
const STATUS_TEXT = {
  pending: '待处理',
  running: '下载中',
  done: '完成',
  failed: '有缺失分片',
  cancelled: '已取消',
  interrupted: '中断（磁盘上有分片，可继续）',
};
const STATUS_LABEL = {
  pending: '待处理',
  running: '下载中',
  done: '完成',
  failed: '缺片',
  cancelled: '已取消',
  interrupted: '已中断',
};

let queue = [];
let runningId = null;
let queuePaused = false;
let jobOrder = new Map();
let total = 0;
let maxQueue = 20;
/** 记录每片最近一次失败原因，供最终失败行使用 */
const lastError = new Map();
/** 磁盘上的任务文件 */
let files = [];
/** 当前任务的实时进度，用于计算队列整体百分比 */
let liveProgress = null;
/** 中断任务的提示只弹一次，避免每次队列推送都刷 */
let recoveredAnnounced = false;

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
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(2)} GB`;
}

function fmtRate(bps) {
  if (!bps || bps < 1) return '—';
  if (bps < 1048576) return `${(bps / 1024).toFixed(0)} KB/s`;
  return `${(bps / 1048576).toFixed(2)} MB/s`;
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

function fmtDate(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/* ---------------- Toast ---------------- */

/** SSE 连接建立后，服务端会先回放历史事件；回放期间不弹 toast，避免刷新后一片提示 */
let replaying = true;

function toast(text, kind = 'info', ttl = 4200) {
  if (replaying) return;
  const box = $('toasts');
  if (!box) return;
  const el = document.createElement('div');
  el.className = `toast ${kind}`;

  const ico = document.createElement('span');
  ico.className = 'ti';
  ico.textContent = kind === 'ok' ? '✓' : kind === 'err' ? '✗' : kind === 'warn' ? '!' : 'i';

  const body = document.createElement('span');
  body.textContent = text;

  el.append(ico, body);
  box.appendChild(el);
  while (box.childElementCount > 4) box.firstElementChild.remove();

  const kill = () => {
    if (!el.isConnected || el.classList.contains('leaving')) return;
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 220);
  };
  el.addEventListener('click', kill);
  setTimeout(kill, ttl);
}

/* ---------------- 对话框 ---------------- */

/**
 * 统一的确认 / 输入弹窗，替代原生 confirm()、prompt()。
 * 有 fields 时 resolve 为字符串数组，否则为 true / null（取消）。
 */
function askDialog(opts) {
  const {
    title,
    message = '',
    fields = [],
    confirmText = '确定',
    cancelText = '取消',
    danger = false,
  } = opts;

  const dlg = $('dlg');
  dlg.textContent = '';

  const inner = document.createElement('div');
  inner.className = 'dlg-inner';

  const h = document.createElement('h3');
  h.className = 'dlg-title';
  h.textContent = title;
  inner.appendChild(h);

  if (message) {
    const p = document.createElement('p');
    p.className = 'dlg-msg';
    p.textContent = message;
    inner.appendChild(p);
  }

  const inputs = [];
  for (const field of fields) {
    const label = document.createElement('label');
    label.className = 'field';

    const cap = document.createElement('span');
    cap.className = 'label';
    cap.textContent = field.label ?? '';

    const input = document.createElement('input');
    input.type = 'text';
    input.value = field.value ?? '';
    if (field.placeholder) input.placeholder = field.placeholder;
    input.autocomplete = 'off';
    input.spellcheck = false;

    label.append(cap, input);
    inner.appendChild(label);
    inputs.push(input);
  }

  const foot = document.createElement('div');
  foot.className = 'dlg-foot';

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn ghost';
  cancel.textContent = cancelText;

  const ok = document.createElement('button');
  ok.type = 'button';
  ok.className = `btn ${danger ? 'danger' : 'primary'}`;
  ok.textContent = confirmText;

  foot.append(cancel, ok);
  inner.appendChild(foot);
  dlg.appendChild(inner);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
      dlg.close();
    };

    ok.addEventListener('click', () => {
      finish(fields.length ? inputs.map((i) => i.value.trim()) : true);
    });
    cancel.addEventListener('click', () => finish(null));
    dlg.oncancel = (event) => {
      event.preventDefault();
      finish(null);
    };
    dlg.onclick = (event) => {
      if (event.target === dlg) finish(null);
    };
    inner.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && event.target.tagName === 'INPUT') {
        event.preventDefault();
        ok.click();
      }
    });

    dlg.showModal();
    const first = inputs[0];
    if (first) {
      first.focus();
      first.select();
    } else {
      ok.focus();
    }
  });
}

/* ---------------- 速率火花线 ---------------- */

const sparkEl = $('spark');
const sparkCtx = sparkEl ? sparkEl.getContext('2d') : null;
let sparkData = [];
let sparkAnchor = { t: 0, bytes: 0 };
let sparkRaf = 0;

function resetSpark() {
  sparkData = [];
  sparkAnchor = { t: 0, bytes: 0 };
  if ($('rate')) $('rate').textContent = '—';
  drawSpark();
}

function sampleSpark(bytes) {
  const now = performance.now();
  if (!sparkAnchor.t) {
    sparkAnchor = { t: now, bytes };
    return;
  }
  const dt = now - sparkAnchor.t;
  if (dt < 220) return;

  const rate = Math.max(0, (bytes - sparkAnchor.bytes) / (dt / 1000));
  sparkAnchor = { t: now, bytes };

  sparkData.push(rate);
  if (sparkData.length > SPARK_MAX) sparkData.shift();
  if ($('rate')) $('rate').textContent = fmtRate(rate);
  drawSpark();
}

function drawSpark() {
  if (sparkRaf) return;
  sparkRaf = requestAnimationFrame(() => {
    sparkRaf = 0;
    paintSpark();
  });
}

function paintSpark() {
  if (!sparkCtx) return;
  const w = sparkEl.clientWidth;
  const h = sparkEl.clientHeight;
  if (!w || !h) return;

  const dpr = window.devicePixelRatio || 1;
  if (sparkEl.width !== Math.round(w * dpr) || sparkEl.height !== Math.round(h * dpr)) {
    sparkEl.width = Math.round(w * dpr);
    sparkEl.height = Math.round(h * dpr);
  }

  const ctx = sparkCtx;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (sparkData.length < 2) return;

  const max = Math.max(...sparkData, 1);
  const stepX = w / (SPARK_MAX - 1);
  const x0 = w - (sparkData.length - 1) * stepX;
  const pts = sparkData.map((value, i) => [
    x0 + i * stepX,
    h - 4 - (value / max) * (h - 12),
  ]);

  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, 'rgba(107, 140, 255, 0.45)');
  grad.addColorStop(1, 'rgba(107, 140, 255, 0)');

  ctx.beginPath();
  ctx.moveTo(pts[0][0], h);
  for (const [x, y] of pts) ctx.lineTo(x, y);
  ctx.lineTo(pts[pts.length - 1][0], h);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i += 1) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.strokeStyle = '#8ea8ff';
  ctx.lineWidth = 1.6;
  ctx.lineJoin = 'round';
  ctx.stroke();
}

window.addEventListener('resize', drawSpark);

/* ---------------- 队列总耗时 ---------------- */

function queueStats() {
  let totalMs = 0;
  let doneMs = 0;

  for (const item of queue) {
    const est = item.estimateMs ?? 0;
    totalMs += est;
    if (item.status === 'done') {
      doneMs += est;
    } else if (item.status === 'running') {
      const live = liveProgress && runningId === item.id ? liveProgress : null;
      const frac = live && live.total > 0 ? live.completed / live.total : 0;
      doneMs += est * frac;
    }
  }

  return { totalMs, doneMs, percent: totalMs > 0 ? (doneMs / totalMs) * 100 : 0 };
}

function updateQueueStats() {
  const stats = queueStats();
  if (stats.totalMs <= 0) {
    $('queuetotal').textContent = '';
    return;
  }
  $('queuetotal').textContent = `总计 ${fmtDuration(stats.totalMs)} · 完成 ${stats.percent.toFixed(0)}%`;
}

/* ---------------- 文件管理 ---------------- */

function fileRow(file) {
  const el = document.createElement('div');
  el.className = 'row file-row';

  const name = document.createElement('span');
  name.className = 'f-name';

  const head = document.createElement('span');
  head.className = 'f-head';

  const title = document.createElement('b');
  title.className = 'f-title';
  title.textContent = file.name;
  title.title = file.path;

  const tag = document.createElement('span');
  tag.className = `f-tag${file.hasOutput ? ' on' : ''}`;
  tag.textContent = file.hasOutput ? `成品 ${fmtSize(file.outputBytes)}` : '无成品';

  head.append(title, tag);

  const parts = document.createElement('span');
  parts.className = 'f-parts';
  parts.textContent = `分片 ${file.segments} 个 · ${fmtSize(file.segmentBytes)}`;

  name.append(head, parts);

  const time = document.createElement('span');
  time.className = 'f-time';
  time.textContent = `${fmtDate(file.startedAt)} 起 · 用时 ${fmtDuration(file.durationMs ?? 0)}`;

  const actions = document.createElement('span');
  actions.className = 'q-actions';

  if (file.hasOutput) {
    const dl = document.createElement('a');
    dl.className = 'btn sm dl';
    dl.href = `/api/download?path=${encodeURIComponent(file.path)}`;
    dl.textContent = '下载';
    dl.setAttribute('download', '');
    dl.title = '下载拼接好的成品';
    actions.appendChild(dl);
  }

  const del = document.createElement('button');
  del.className = 'btn sm danger';
  del.textContent = '删除';
  del.title = '删除该任务的目录（分片 + 成品）';
  del.addEventListener('click', () => deleteTaskFiles(file));
  actions.appendChild(del);

  el.append(name, time, actions);
  return el;
}

function emptyState(title, sub) {
  const box = document.createElement('div');
  box.className = 'list-empty';

  const ico = document.createElement('span');
  ico.className = 'le-ico';
  ico.setAttribute('aria-hidden', 'true');
  ico.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 7.5h6l1.8 2H20a.5.5 0 0 1 .5.5v8a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1V8a.5.5 0 0 1 .5-.5Z"/></svg>';

  const b = document.createElement('b');
  b.textContent = title;

  const span = document.createElement('span');
  span.textContent = sub;

  box.append(ico, b, span);
  return box;
}

function renderFiles() {
  const list = $('filelist');
  list.innerHTML = '';

  if (files.length === 0) {
    list.appendChild(emptyState('暂无文件', '下载完成后成品会出现在这里'));
    $('filessummary').textContent = '';
    return;
  }

  const totalBytes = files.reduce((sum, f) => sum + f.totalBytes, 0);
  $('filessummary').textContent = `${files.length} 个任务 · ${fmtSize(totalBytes)}`;
  for (const file of files) list.appendChild(fileRow(file));
}

async function loadFiles() {
  try {
    const res = await fetch('/api/files');
    if (!res.ok) return;
    const data = await res.json();
    files = Array.isArray(data.tasks) ? data.tasks : [];
    renderFiles();
  } catch {
    /* 网络抖动忽略，下次轮询再试 */
  }
}

async function deleteTaskFiles(file) {
  const ok = await askDialog({
    title: '删除任务文件',
    message:
      `${file.name}\n\n` +
      `分片：${file.segments} 个（${fmtSize(file.segmentBytes)}）\n` +
      `成品：${file.hasOutput ? fmtSize(file.outputBytes) : '无'}\n` +
      `合计：${fmtSize(file.totalBytes)}\n\n删除后不可恢复。`,
    confirmText: '删除全部',
    danger: true,
  });
  if (!ok) return;

  const res = await fetch(`/api/files?id=${encodeURIComponent(file.id)}`, { method: 'DELETE' });
  const data = await res.json().catch(() => ({}));
  if (res.ok) {
    banner('已删除任务文件', file.name, `释放 ${fmtSize(data.freedBytes)}`);
    toast(`已删除 ${file.name}`, 'ok');
    await loadFiles();
  } else {
    note(`删除失败：${data.error || res.status}`);
  }
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
    if (!item) continue;
    const span = document.createElement('span');
    span.className = 'dim';
    span.textContent = `  ${item}`;
    el.appendChild(span);
  }
  push(el);
}

/** 轻量提示统一走右下角 toast，不再污染日志 */
function note(text) {
  if (!text) return;
  const kind = /失败|错误|无法|异常|不再/.test(text)
    ? 'err'
    : /跳过|忽略|已满|重复/.test(text)
      ? 'warn'
      : 'info';
  toast(text, kind);
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

/** 只输出失败分片；成功的分片由进度条体现，不再逐行刷屏 */
function failureRow(event, reason, jobId) {
  const why = reason ? (reason.length > 80 ? `${reason.slice(0, 80)}…` : reason) : '下载失败';
  row(
    [
      ['t', clock()],
      ['g', '✗'],
      ['msg', `#${event.index} ${why}${event.attempts > 1 ? `（共 ${event.attempts} 次尝试）` : ''}`],
    ],
    'err',
    jobId,
  );
}

/* ---------------- 状态 ---------------- */

function setState(text, cls) {
  $('termstate').textContent = text;
  $('dot').className = `dot ${cls}`;
  consoleEl.dataset.state = cls || 'idle';
}

function resetProgress() {
  fillEl.style.width = '0%';
  $('pct').textContent = '0.0%';
  $('count').textContent = '—';
  $('elapsed').textContent = '—';
  $('eta').textContent = '—';
  $('size').textContent = '—';
  $('termspeed').textContent = '—';
  $('retrynote').textContent = '';
  resetSpark();
  $('topline').style.width = '0%';
  $('topline').classList.remove('on');
}

function renderProgress(snap) {
  liveProgress = snap;
  const pct = snap.total > 0 ? (snap.completed / snap.total) * 100 : 0;
  fillEl.style.width = `${pct.toFixed(1)}%`;
  $('pct').textContent = `${pct.toFixed(1)}%`;
  $('count').textContent = `${snap.completed}/${snap.total}`;
  $('elapsed').textContent = fmtDuration(snap.elapsedMs);
  $('eta').textContent = snap.speed > 0 ? fmtDuration(snap.etaMs) : '不限速';
  $('size').textContent = fmtSize(snap.bytes);
  $('termspeed').textContent = snap.speed > 0 ? `${snap.speed}x` : '不限速';
  sampleSpark(snap.bytes);

  const line = $('topline');
  if (line) {
    line.style.width = `${pct.toFixed(1)}%`;
    line.classList.toggle('on', pct > 0 && pct < 100);
  }

  const live = listEl.querySelector('.q-row.st-running .q-meta');
  if (live) live.textContent = `${snap.completed}/${snap.total}`;
  updateQueueStats();
}

/* ---------------- 队列渲染 ---------------- */

function metaText(item) {
  if (item.status === 'pending') return '—';
  if (item.status === 'running') return `${item.downloaded}/${item.total || '?'}`;
  if (item.status === 'cancelled') return '已取消';
  if (item.status === 'interrupted') {
    const totalN = item.total || '?';
    const gap = item.failed.length > 0 ? `缺 ${item.failed.length} 片` : '待续传';
    return `${item.downloaded}/${totalN} · ${gap}`;
  }
  if (item.status === 'failed') return `${item.downloaded}/${item.total} · 缺 ${item.failed.length} 片`;
  return `${item.downloaded}/${item.total} · ${fmtSize(item.bytes)} · ${fmtDuration(item.elapsedMs)}`;
}

function queueRow(item, index) {
  const el = document.createElement('div');
  el.className = `row q-row st-${item.status}`;

  const idx = document.createElement('span');
  idx.className = 'q-idx';
  idx.textContent = `#${index}`;

  const status = document.createElement('span');
  status.className = 'q-state';
  status.title = STATUS_TEXT[item.status] ?? '';
  const statusDot = document.createElement('i');
  const statusText = document.createElement('span');
  statusText.textContent = STATUS_LABEL[item.status] ?? '?';
  status.append(statusDot, statusText);

  const main = document.createElement('span');
  main.className = 'q-main';
  if (item.note) {
    const name = document.createElement('span');
    name.className = 'q-name';
    name.textContent = item.note;
    name.title = `${item.note}\n${item.url}`;
    const url = document.createElement('span');
    url.className = 'q-url';
    url.textContent = item.url || '（无地址 · 待绑定）';
    main.append(name, url);
  } else {
    const url = document.createElement('span');
    url.className = 'q-url';
    url.textContent = item.url || '（无地址 · 待绑定）';
    url.title = item.url ?? '';
    main.appendChild(url);
  }

  const meta = document.createElement('span');
  meta.className = 'q-meta';
  meta.textContent = metaText(item);

  const actions = document.createElement('span');
  actions.className = 'q-actions';

  const noteBtn = document.createElement('button');
  noteBtn.className = 'btn sm';
  noteBtn.textContent = '备注';
  noteBtn.title = '给这个任务起个名字（会用作目录名和下载文件名）';
  noteBtn.addEventListener('click', () => editNote(item));
  actions.appendChild(noteBtn);

  if ((item.status === 'done' || item.status === 'failed' || item.status === 'interrupted') && item.outputPath) {
    const link = document.createElement('a');
    link.className = 'btn sm dl';
    link.href = `/api/download?job=${encodeURIComponent(item.id)}`;
    link.textContent = '下载';
    link.setAttribute('download', '');
    actions.appendChild(link);

    const clean = document.createElement('button');
    clean.className = 'btn sm';
    clean.textContent = '清理';
    clean.title = '删除分片目录，保留成品';
    clean.addEventListener('click', () => cleanup(item));
    actions.appendChild(clean);
  }

  // 中断 / 失败 / 取消：一键继续，只补缺失分片
  if (item.status === 'interrupted' || item.status === 'failed' || item.status === 'cancelled') {
    if (!item.url) {
      const bind = document.createElement('button');
      bind.className = 'btn sm primary';
      bind.textContent = '绑定链接';
      bind.title = '磁盘恢复的任务没有记录原始地址，填入后才能续传';
      bind.addEventListener('click', () => bindUrl(item));
      actions.appendChild(bind);
    } else {
      const resume = document.createElement('button');
      resume.className = 'btn sm primary';
      resume.textContent = '继续';
      resume.title = '只补缺失的分片，已下载的不会重下';
      resume.addEventListener('click', () => retryItem(item));
      actions.appendChild(resume);
    }
  }

  if (item.status !== 'running') {
    const remove = document.createElement('button');
    remove.className = 'btn sm ghost';
    remove.textContent = '移除';
    remove.title = '仅从队列移除，不影响已下载的文件';
    remove.addEventListener('click', () => removeItem(item.id));
    actions.appendChild(remove);
  }

  el.append(idx, status, main, meta, actions);
  return el;
}

function renderQueue() {
  const done = queue.filter((i) => i.status === 'done').length;
  const broken = queue.filter((i) => i.status === 'interrupted' || i.status === 'failed').length;
  $('queuecount').textContent = `${queue.length} / ${maxQueue}`;
  $('queuesummary').textContent =
    (done > 0 ? `${done} 完成` : '') + (broken > 0 ? `${done > 0 ? ' · ' : ''}${broken} 待续传` : '');

  listEl.innerHTML = '';
  if (queue.length === 0) {
    listEl.appendChild(emptyRow);
    return;
  }
  queue.forEach((item, i) => listEl.appendChild(queueRow(item, i + 1)));
}

function resultRow(item) {
  const complete = item.status === 'done';
  const interrupted = item.status === 'interrupted';
  const el = document.createElement('div');
  el.className = `row result-row ${complete ? 'ok' : item.status === 'failed' ? 'bad' : 'warn'}`;

  const icon = document.createElement('span');
  icon.className = 'r-icon';
  icon.textContent = complete ? '✓' : item.status === 'cancelled' ? '⊘' : interrupted ? '⏸' : '✗';

  const body = document.createElement('span');
  body.className = 'r-body';

  const name = document.createElement('span');
  name.className = 'r-name';
  name.textContent = item.note ?? item.url;
  name.title = item.note ? `${item.note}\n${item.url}` : item.url;
  body.appendChild(name);

  if (complete) {
    const noteEl = document.createElement('span');
    noteEl.className = 'r-note';
    noteEl.textContent = `完整 · ${item.total} 片 · ${fmtSize(item.bytes)} · ${fmtDuration(item.elapsedMs)}`;
    body.appendChild(noteEl);
  } else if (item.status === 'failed' || interrupted) {
    const miss = document.createElement('span');
    miss.className = 'r-missing';
    if (item.failed.length > 0) {
      miss.textContent = `${interrupted ? '中断' : '失败'} · 缺 ${item.failed.length} 片：${fmtRanges(item.failed)}`;
    } else {
      miss.textContent = interrupted ? `中断 · ${item.error ?? '待续传'}` : `失败：${item.error ?? '未知原因'}`;
    }
    body.appendChild(miss);
  } else {
    const noteEl = document.createElement('span');
    noteEl.className = 'r-note';
    noteEl.textContent = '已取消';
    body.appendChild(noteEl);
  }

  const meta = document.createElement('span');
  meta.className = 'r-meta';
  meta.textContent = item.status === 'cancelled' ? '—' : `${item.downloaded}/${item.total || '?'}`;

  const actions = document.createElement('span');
  actions.className = 'r-actions';

  if (item.status === 'failed' || item.status === 'cancelled' || interrupted) {
    if (!item.url) {
      const bind = document.createElement('button');
      bind.className = 'btn sm primary';
      bind.textContent = '绑定链接';
      bind.addEventListener('click', () => bindUrl(item));
      actions.appendChild(bind);
    } else {
      const retry = document.createElement('button');
      retry.className = 'btn sm primary';
      retry.textContent = interrupted ? '继续下载' : '补齐缺失';
      retry.addEventListener('click', () => retryItem(item));
      actions.appendChild(retry);
    }
  }

  if (item.outputPath) {
    const link = document.createElement('a');
    link.className = 'btn sm dl';
    link.href = `/api/download?job=${encodeURIComponent(item.id)}`;
    link.textContent = '下载';
    link.setAttribute('download', '');
    actions.appendChild(link);
  }

  const remove = document.createElement('button');
  remove.className = 'btn sm ghost';
  remove.textContent = '移除';
  remove.title = '从列表中移除（不影响已下载的文件）';
  remove.addEventListener('click', () => removeItem(item.id));
  actions.appendChild(remove);

  el.append(icon, body, meta, actions);
  return el;
}

function renderResults() {
  const finished = queue.filter(
    (i) =>
      i.status === 'done' || i.status === 'failed' || i.status === 'cancelled' || i.status === 'interrupted',
  );
  const box = $('results');

  if (finished.length === 0) {
    box.hidden = true;
    return;
  }

  const okCount = finished.filter((i) => i.status === 'done').length;
  const badCount = finished.filter((i) => i.status === 'failed').length;
  const interCount = finished.filter((i) => i.status === 'interrupted').length;
  const missing = finished.reduce((sum, i) => sum + i.failed.length, 0);

  $('resultsummary').textContent =
    `${finished.length} 项 · ${okCount} 完整` +
    (interCount ? ` · ${interCount} 中断` : '') +
    (badCount ? ` · ${badCount} 待补齐（缺 ${missing} 片）` : '');

  $('retryall').hidden = !finished.some(
    (i) => (i.status === 'failed' || i.status === 'cancelled' || i.status === 'interrupted') && i.url,
  );

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
  const jobIdx = runningId ? jobOrder.get(runningId) : null;
  $('termjob').textContent = jobIdx && queue.length > 1 ? `#${jobIdx}/${queue.length}` : '';

  if (!recoveredAnnounced) {
    const interrupted = queue.filter((i) => i.status === 'interrupted');
    if (interrupted.length > 0) {
      recoveredAnnounced = true;
      banner('发现中断的任务', `${interrupted.length} 个`, '磁盘上的分片还在，点「继续」只补缺失部分');
      toast(`发现 ${interrupted.length} 个中断任务，可继续下载`, 'warn', 6000);
    }
  }

  renderQueue();
  renderResults();
  updateButtons();
  updateQueueStats();
}

/* ---------------- 汇总报告 ---------------- */

function printSummary(summary) {
  if (!Array.isArray(summary) || summary.length === 0) return;

  const ok = summary.filter((i) => i.status === 'done').length;
  const bad = summary.filter((i) => i.status === 'failed').length;
  const cancelled = summary.filter((i) => i.status === 'cancelled').length;
  const interrupted = summary.filter((i) => i.status === 'interrupted').length;
  const pending = summary.filter((i) => i.status === 'pending').length;

  banner(
    '队列结束',
    `${ok} 成功`,
    `${bad} 失败`,
    cancelled ? `${cancelled} 取消` : '',
    interrupted ? `${interrupted} 中断（可继续）` : '',
    pending ? `${pending} 未执行` : '',
  );

  for (const item of summary) {
    const mark =
      item.status === 'done'
        ? '✓'
        : item.status === 'failed'
          ? '✗'
          : item.status === 'interrupted'
            ? '⏸'
            : '⊘';
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
  const label = $('note').value.trim();
  if (label) body.note = label;
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
    banner('已加入队列', `${data.added} 个`, `${body.speed}x`, label ? `备注 ${label}` : '');
    toast(`已加入 ${data.added} 个任务`, 'ok');
    $('urls').value = '';
    $('note').value = '';
  }
  if (data.duplicates) note(`跳过重复地址 ${data.duplicates} 个`);
  if (data.reused) note(`复用磁盘上已有的目录 ${data.reused} 个（只补缺失分片，不会重下）`);
  if (data.completed) note(`其中 ${data.completed} 个已经是完整成品，可直接下载`);
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

/** 给队列里的任务改名（备注名同时作为目录名与下载文件名） */
async function editNote(item) {
  const values = await askDialog({
    title: '重命名任务',
    message: '备注名会用作目录名和下载的文件名，中文与符号都支持。',
    fields: [{ label: '备注', value: item.note ?? '', placeholder: '例：第 3 讲 网络协议' }],
    confirmText: '保存',
  });
  if (!values) return;
  const label = values[0];
  if (!label) return;

  const res = await fetch('/api/queue/note', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: item.id, note: label }),
  });
  const data = await res.json().catch(() => ({}));

  if (!res.ok || data.ok === false) {
    note(`改名失败：${data.error || res.status}`);
    return;
  }

  const hint =
    item.status === 'running'
      ? '任务结束后重命名目录'
      : item.status === 'pending'
        ? '目录名已更新'
        : '目录已重命名';
  banner('备注已更新', data.note ?? label, hint);
  toast(`备注已更新为「${data.note ?? label}」`, 'ok');
  void loadFiles();
}

async function cleanup(item) {
  const ok = await askDialog({
    title: '清理分片目录',
    message: `将删除 ${item.taskName} 的分片目录。\n\n成品会保留，但删除后无法再续传。`,
    confirmText: '清理',
    danger: true,
  });
  if (!ok) return;

  const res = await fetch('/api/cleanup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ job: item.id }),
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok) {
    banner('分片已清理', `释放 ${(data.freedBytes / 1024 / 1024 / 1024).toFixed(2)} GB`);
    toast(`分片已清理，${fmtSize(data.freedBytes)} 已释放`, 'ok');
    void loadFiles();
  } else {
    note(`清理失败：${data.error || res.status}`);
  }
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
  const ok = await askDialog({
    title: '停止队列',
    message: '当前任务会被取消，尚未开始的任务会保留在队列里。',
    confirmText: '停止',
    danger: true,
  });
  if (!ok) return;
  await fetch('/api/queue/stop', { method: 'POST' });
  banner('已请求停止队列');
  toast('已请求停止队列', 'warn');
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
  banner('已加入补齐队列', item.note ?? item.url);
  toast('已加入补齐队列', 'ok');
  await fetch('/api/queue/start', { method: 'POST' });
}

/** 给磁盘恢复出来、但没有原始链接的老任务补地址 */
async function bindUrl(item) {
  const values = await askDialog({
    title: '绑定播放列表地址',
    message: `「${item.note ?? item.taskName}」是从磁盘恢复的，没有记录原始播放列表地址。\n绑定后才能续传缺失分片。`,
    fields: [
      {
        label: 'm3u8 地址',
        value: item.url || '',
        placeholder: 'https://…/index.m3u8',
      },
    ],
    confirmText: '绑定',
  });
  if (!values) return;
  const value = values[0];
  if (!value) return;

  const res = await fetch('/api/queue/attach', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: item.id, url: value }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    note(`绑定失败：${data.error || res.status}`);
    return;
  }
  banner('链接已绑定', item.note ?? item.taskName);
  toast('链接已绑定，可以点「继续」了', 'ok');
  if (data.queue) applyQueue(data.queue);
}

/** 重新扫一遍磁盘，把断电前留下的任务目录认领回队列 */
async function rescanDisk() {
  const res = await fetch('/api/queue/recover', { method: 'POST' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    note(`扫描失败：${data.error || res.status}`);
    return;
  }
  if (data.queue) applyQueue(data.queue);
  if (data.adopted > 0) {
    banner('已从磁盘恢复', `${data.adopted} 个任务`, data.refreshed ? `${data.refreshed} 个已刷新` : '');
    toast(`已从磁盘恢复 ${data.adopted} 个任务`, 'ok');
  } else if (data.refreshed > 0) {
    note(`已刷新 ${data.refreshed} 个任务的磁盘状态`);
  } else {
    note('磁盘上没有新的任务目录');
  }
  void loadFiles();
}

$('retryall').addEventListener('click', async () => {
  const res = await fetch('/api/queue/retry-all', { method: 'POST' });
  const data = await res.json().catch(() => ({}));
  if (data.retried) {
    banner('已加入补齐队列', `${data.retried} 个任务`);
    toast(`${data.retried} 个任务已加入补齐队列`, 'ok');
    await fetch('/api/queue/start', { method: 'POST' });
  }
});

async function clearFinished() {
  const res = await fetch('/api/queue/clear', { method: 'POST' });
  const data = await res.json().catch(() => ({}));
  if (data.removed) {
    note(`已清除 ${data.removed} 条已完成记录`);
  }
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
  if ($('dlg')?.open) return;
  if (event.key === 'Escape' && !$('stop').disabled) {
    event.preventDefault();
    $('stop').click();
  } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !$('start').disabled) {
    event.preventDefault();
    $('start').click();
  }
});

/* ---------------- 事件流 ---------------- */

function setConn(state, text) {
  const el = $('conn');
  if (!el) return;
  el.dataset.state = state;
  const label = el.querySelector('b');
  if (label) label.textContent = text;
}

const events = new EventSource('/api/events');

events.onopen = () => setConn('live', '已连接');

events.onmessage = (message) => {
  let event;
  try {
    event = JSON.parse(message.data);
  } catch {
    return;
  }

  if (event.type === 'ready') {
    replaying = false;
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
      resetProgress();
      $('count').textContent = `0/${event.total}`;
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
      if (event.ok) {
        lastError.delete(event.index);
        $('retrynote').textContent = '';
      } else {
        failureRow(event, lastError.get(event.index), jobId);
        lastError.delete(event.index);
        $('retrynote').textContent = '';
      }
      break;

    case 'error':
      // 重试不刷屏，只在进度条下方提示当前正在重试哪一片
      lastError.set(event.index, event.message);
      $('retrynote').textContent = `#${event.index} 第 ${event.attempt} 次重试`;
      break;

    case 'log':
      banner(event.message);
      break;

    case 'done':
      if (event.failed.length > 0) {
        banner('任务结束', `失败 ${event.failed.length} 片`, '未拼接');
        toast(`任务结束，失败 ${event.failed.length} 片`, 'err', 6000);
      } else if (event.outputPath) {
        banner('任务完成', fmtDuration(event.elapsedMs), fmtSize(event.bytes), event.outputPath);
        toast(`任务完成 · ${fmtSize(event.bytes)}`, 'ok', 5000);
      } else {
        banner('任务完成', fmtDuration(event.elapsedMs));
        toast('任务完成', 'ok');
      }
      void loadFiles();
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
  setConn('down', '重连中');
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
drawSpark();

fetch('/api/state')
  .then((r) => r.json())
  .then((state) => {
    maxQueue = state.maxQueue ?? 20;
    if (state.running) {
      setState('运行中', 'run');
      banner('检测到队列正在运行，正在同步进度…');
    }
  })
  .catch(() => {});

fetch('/api/queue')
  .then((r) => r.json())
  .then((snap) => applyQueue(snap))
  .catch(() => {});

$('refreshfiles').addEventListener('click', loadFiles);
$('recoverfiles').addEventListener('click', rescanDisk);
void loadFiles();
setInterval(loadFiles, 5000);
