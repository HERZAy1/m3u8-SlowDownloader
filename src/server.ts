import { createReadStream } from 'node:fs';
import { readFile, readdir, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DownloadQueue } from './queue.ts';
import type { ServerEvent } from './types.ts';

const WEB_ROOT = fileURLToPath(new URL('../web/', import.meta.url));
const PORT = Number(process.env.PORT ?? 7788);
/** 默认只绑本机；服务器部署时用 HOST=0.0.0.0 开放局域网访问。 */
const HOST = process.env.HOST ?? '127.0.0.1';
const DOWNLOADS_DIR = resolve(process.cwd(), 'downloads');
const MAX_QUEUE = Number(process.env.MAX_QUEUE ?? 20);

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

interface Session {
  events: ServerEvent[];
  clients: Set<ServerResponse>;
}

const session: Session = { events: [], clients: new Set() };

function broadcast(event: ServerEvent): void {
  session.events.push(event);
  if (session.events.length > 4000) session.events.shift();
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of session.clients) client.write(payload);
}

const queue = new DownloadQueue(broadcast, MAX_QUEUE);

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(payload);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

async function serveStatic(res: ServerResponse, urlPath: string): Promise<void> {
  const relative = urlPath === '/' ? 'index.html' : urlPath.slice(1);
  const resolved = normalize(join(WEB_ROOT, relative));
  if (!resolved.startsWith(normalize(WEB_ROOT + sep))) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const data = await readFile(resolved);
    res.writeHead(200, { 'Content-Type': MIME[extname(resolved)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404).end('not found');
  }
}

function urlsFrom(body: Record<string, unknown>): string[] {
  if (Array.isArray(body.urls)) return body.urls.filter((u): u is string => typeof u === 'string');
  if (typeof body.urls === 'string') return body.urls.split(/\r?\n/);
  if (typeof body.url === 'string') return [body.url];
  return [];
}

function paramsFrom(body: Record<string, unknown>) {
  return {
    speed: Number(body.speed ?? 2),
    jitterMs: Number(body.jitter ?? 300),
    retries: Number(body.retries ?? 3),
    limit: body.limit ? Number(body.limit) : undefined,
    outDir:
      typeof body.outDir === 'string' && body.outDir.trim() ? body.outDir.trim() : undefined,
    remux: Boolean(body.remux),
    merge: body.merge !== false,
  };
}

async function dirSize(dir: string): Promise<number> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  let total = 0;
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) total += await dirSize(full);
    else total += (await stat(full).catch(() => ({ size: 0 }))).size;
  }
  return total;
}

/**
 * 按任务名解析产物：?task=<名> 指定，否则取 downloads/ 下最新的 output.ts。
 * （队列任务的产物走 ?job=<id>，直接取队列里记录的绝对路径。）
 */
async function resolveOutput(requested: string | null): Promise<{ path: string; name: string } | null> {
  if (requested && /^[\w.-]+$/.test(requested)) {
    const candidate = resolve(DOWNLOADS_DIR, requested, 'output.ts');
    if (await stat(candidate).catch(() => null)) {
      return { path: candidate, name: `${requested}.ts` };
    }
  }

  const entries = await readdir(DOWNLOADS_DIR, { withFileTypes: true }).catch(() => []);
  let newest: { path: string; name: string; mtime: number } | null = null;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = resolve(DOWNLOADS_DIR, entry.name, 'output.ts');
    const info = await stat(candidate).catch(() => null);
    if (info && (!newest || info.mtimeMs > newest.mtime)) {
      newest = { path: candidate, name: `${entry.name}.ts`, mtime: info.mtimeMs };
    }
  }
  return newest ? { path: newest.path, name: newest.name } : null;
}

const server = createServer((req, res) => {
  void (async (): Promise<void> => {
    const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);
    const path = url.pathname;

    try {
      /* ---------- 事件流 ---------- */

      if (path === '/api/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        res.write(': connected\n\n');
        for (const event of session.events) res.write(`data: ${JSON.stringify(event)}\n\n`);
        session.clients.add(res);
        req.on('close', () => session.clients.delete(res));
        return;
      }

      /* ---------- 队列 ---------- */

      if (path === '/api/queue' && req.method === 'GET') {
        json(res, 200, queue.snapshot());
        return;
      }

      if (path === '/api/queue' && req.method === 'POST') {
        const body = await readJson(req);
        const urls = urlsFrom(body);
        if (urls.length === 0) {
          json(res, 400, { error: '缺少播放列表地址' });
          return;
        }
        const result = queue.add(urls, paramsFrom(body));
        json(res, 200, { ...result, queue: queue.snapshot() });
        return;
      }

      if (path === '/api/queue' && req.method === 'DELETE') {
        const id = url.searchParams.get('id') ?? '';
        const result = queue.remove(id);
        json(res, result.ok ? 200 : 409, result.ok ? { ok: true, queue: queue.snapshot() } : { error: result.reason });
        return;
      }

      if (path === '/api/queue/start' && req.method === 'POST') {
        void queue.start().catch((err: unknown) => {
          broadcast({ type: 'log', message: `队列异常：${err instanceof Error ? err.message : String(err)}` });
        });
        json(res, 202, { ok: true });
        return;
      }

      if (path === '/api/queue/stop' && req.method === 'POST') {
        queue.stop();
        json(res, 200, { ok: true });
        return;
      }

      if (path === '/api/queue/clear' && req.method === 'POST') {
        const removed = queue.clearFinished();
        json(res, 200, { ok: true, removed });
        return;
      }

      if (path === '/api/queue/retry' && req.method === 'POST') {
        const body = await readJson(req);
        const id = String(body.id ?? '');
        const ok = queue.retry(id);
        json(res, ok ? 200 : 409, ok ? { ok: true } : { error: '无法重试（不存在或正在运行）' });
        return;
      }

      if (path === '/api/queue/retry-all' && req.method === 'POST') {
        const retried = queue.retryAll();
        json(res, 200, { ok: true, retried });
        return;
      }

      /* ---------- 任务控制 ---------- */

      if (path === '/api/control' && req.method === 'POST') {
        const body = await readJson(req);
        const action = String(body.action ?? '');
        if (action === 'pause') queue.pause();
        else if (action === 'resume') queue.resume();
        else if (action === 'cancel') queue.stop();
        else {
          json(res, 400, { error: `未知动作 ${action}` });
          return;
        }
        json(res, 200, { ok: true });
        return;
      }

      // 兼容旧接口：入队并立即开始
      if (path === '/api/start' && req.method === 'POST') {
        const body = await readJson(req);
        const urls = urlsFrom(body);
        if (urls.length === 0) {
          json(res, 400, { error: '缺少播放列表地址' });
          return;
        }
        queue.add(urls, paramsFrom(body));
        void queue.start().catch(() => {});
        json(res, 202, { ok: true });
        return;
      }

      /* ---------- 下载与清理 ---------- */

      if (path === '/api/download' && req.method === 'GET') {
        const jobId = url.searchParams.get('job');
        let target: { path: string; name: string } | null = null;

        if (jobId) {
          const outPath = queue.outputPathOf(jobId);
          const name = queue.taskNameOf(jobId) ?? 'output';
          if (outPath && (await stat(outPath).catch(() => null))) {
            target = { path: outPath, name: `${name}.ts` };
          }
        }
        if (!target) target = await resolveOutput(url.searchParams.get('task'));

        if (!target) {
          json(res, 404, { error: '没有可下载的文件' });
          return;
        }
        const info = await stat(target.path).catch(() => null);
        if (!info) {
          json(res, 404, { error: '文件已不存在' });
          return;
        }

        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(info.size),
          'Content-Disposition': `attachment; filename="${target.name}"`,
        });

        // 客户端中断时必须销毁读流，否则文件句柄会一直占着，导致文件无法删除
        const fileStream = createReadStream(target.path);
        fileStream.on('error', () => {
          if (!res.headersSent) res.writeHead(500);
          res.destroy();
        });
        res.on('close', () => fileStream.destroy());
        fileStream.pipe(res);
        return;
      }

      if (path === '/api/cleanup' && req.method === 'POST') {
        const body = await readJson(req);

        let taskDir: string | null = null;
        const jobId = String(body.job ?? '');
        if (jobId) {
          const dir = queue.outDirOf(jobId);
          if (dir) taskDir = resolve(dir);
        }

        if (!taskDir) {
          const taskName = String(body.task ?? '');
          if (!/^[\w.-]+$/.test(taskName)) {
            json(res, 400, { error: '任务名不合法' });
            return;
          }
          const candidate = resolve(DOWNLOADS_DIR, taskName);
          if (await stat(candidate).catch(() => null)) taskDir = candidate;
        }

        if (!taskDir) {
          json(res, 404, { error: '找不到该任务的目录' });
          return;
        }

        const segmentsDir = join(taskDir, 'segments');
        if (!(await stat(segmentsDir).catch(() => null))) {
          json(res, 404, { error: '该任务没有分片目录（可能已清理）' });
          return;
        }

        const before = await dirSize(segmentsDir);
        await rm(segmentsDir, { recursive: true, force: true });
        json(res, 200, { ok: true, freedBytes: before, dir: taskDir });
        return;
      }

      /* ---------- 状态 ---------- */

      if (path === '/api/state') {
        const out = await resolveOutput(null);
        const info = out ? await stat(out.path).catch(() => null) : null;
        json(res, 200, {
          running: queue.isRunning,
          paused: queue.isPaused,
          runningId: queue.runningId,
          hasTask: queue.size > 0,
          queueSize: queue.size,
          maxQueue: MAX_QUEUE,
          output: out && info ? { name: out.name, path: out.path, size: info.size } : null,
        });
        return;
      }

      if (req.method === 'GET') {
        await serveStatic(res, path);
        return;
      }

      res.writeHead(405).end('method not allowed');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) json(res, 500, { error: message });
      else res.end();
    }
  })();
});

server.listen(PORT, HOST, () => {
  console.log(`m3u8 下载器 GUI: http://${HOST}:${PORT}  (队列上限 ${MAX_QUEUE})`);
});
