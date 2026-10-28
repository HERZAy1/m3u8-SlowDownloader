import { createReadStream } from 'node:fs';
import { readFile, readdir, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename, dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DownloadTask } from './task.ts';
import type { TaskEvent } from './types.ts';

const WEB_ROOT = fileURLToPath(new URL('../web/', import.meta.url));
const PORT = Number(process.env.PORT ?? 7788);
/** 默认只绑本机；服务器部署时用 HOST=0.0.0.0 开放局域网访问。 */
const HOST = process.env.HOST ?? '127.0.0.1';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

interface Session {
  task: DownloadTask | null;
  running: boolean;
  events: TaskEvent[];
  clients: Set<ServerResponse>;
  output: { path: string; name: string } | null;
}

const session: Session = { task: null, running: false, events: [], clients: new Set(), output: null };

function broadcast(event: TaskEvent): void {
  session.events.push(event);
  if (session.events.length > 3000) session.events.shift();
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of session.clients) client.write(payload);
}

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

function startTask(body: Record<string, unknown>): void {
  const url = typeof body.url === 'string' ? body.url.trim() : '';
  if (!url) throw new Error('缺少播放列表地址');

  const speed = Number(body.speed ?? 2);
  const outDir = typeof body.outDir === 'string' && body.outDir.trim() ? body.outDir.trim() : defaultOutDir(url);

  session.events = [];
  session.output = null;
  const taskName = outDir.split(/[\\/]/).pop() || 'output';
  const task = new DownloadTask({
    url,
    outDir,
    speed,
    jitterMs: Number(body.jitter ?? 300),
    retries: Number(body.retries ?? 3),
    limit: body.limit ? Number(body.limit) : undefined,
    remux: Boolean(body.remux),
    merge: body.merge !== false,
  });

  task.on(broadcast);
  session.task = task;
  session.running = true;

  task
    .run()
    .then((result) => {
      session.running = false;
      if (result.outputPath) {
        session.output = { path: result.outputPath, name: `${taskName}.ts` };
      }
      if (result.failed.length > 0) {
        broadcast({ type: 'log', message: `有 ${result.failed.length} 个分片失败，未拼接` });
      }
    })
    .catch((err: unknown) => {
      session.running = false;
      const message = err instanceof Error ? err.message : String(err);
      broadcast({ type: 'log', message: `任务终止：${message}` });
      broadcast({ type: 'phase', phase: 'failed' });
    });
}

function defaultOutDir(url: string): string {
  try {
    const parsed = new URL(url);
    const base = parsed.pathname.split('/').filter(Boolean).pop() ?? 'task';
    return `downloads/${base.replace(/\.m3u8?$/i, '') || 'task'}`;
  } catch {
    return 'downloads/task';
  }
}

const DOWNLOADS_DIR = resolve(process.cwd(), 'downloads');

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
 * 解析要下载的产物：
 *   1. ?task=<任务名> 指定
 *   2. 本次会话刚完成的任务
 *   3. downloads/ 下最新的 output.ts（服务重启后仍可取回旧产物）
 */
async function resolveOutput(requested: string | null): Promise<{ path: string; name: string } | null> {
  if (requested && /^[\w.-]+$/.test(requested)) {
    const candidate = resolve(DOWNLOADS_DIR, requested, 'output.ts');
    if (await stat(candidate).catch(() => null)) {
      return { path: candidate, name: `${requested}.ts` };
    }
  }

  if (session.output && (await stat(session.output.path).catch(() => null))) {
    return session.output;
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

      if (path === '/api/download' && req.method === 'GET') {
        const out = await resolveOutput(url.searchParams.get('task'));
        if (!out) {
          json(res, 404, { error: '没有可下载的文件' });
          return;
        }
        const info = await stat(out.path).catch(() => null);
        if (!info) {
          json(res, 404, { error: '文件已不存在' });
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(info.size),
          'Content-Disposition': `attachment; filename="${out.name}"`,
        });

        // 客户端中断时必须销毁读流，否则文件句柄会一直占着，导致文件无法删除
        const fileStream = createReadStream(out.path);
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
        const taskName = String(body.task ?? '');
        if (!/^[\w.-]+$/.test(taskName)) {
          json(res, 400, { error: '任务名不合法' });
          return;
        }

        // 本次会话的产物可能在自定义目录；重启后只能按 downloads/<任务名> 定位
        let taskDir: string | null = null;
        if (session.output && basename(dirname(session.output.path)) === taskName) {
          taskDir = dirname(session.output.path);
        } else {
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

      if (path === '/api/state') {
        const out = await resolveOutput(null);
        const info = out ? await stat(out.path).catch(() => null) : null;
        json(res, 200, {
          running: session.running,
          hasTask: session.task !== null,
          output: out && info ? { name: out.name, path: out.path, size: info.size } : null,
        });
        return;
      }

      if (path === '/api/start' && req.method === 'POST') {
        if (session.running) {
          json(res, 409, { error: '已有任务在运行' });
          return;
        }
        startTask(await readJson(req));
        json(res, 202, { ok: true });
        return;
      }

      if (path === '/api/control' && req.method === 'POST') {
        const body = await readJson(req);
        const action = String(body.action ?? '');
        const task = session.task;
        if (!task) {
          json(res, 409, { error: '没有任务' });
          return;
        }
        if (action === 'pause') task.pause();
        else if (action === 'resume') task.resume();
        else if (action === 'cancel') task.cancel();
        else {
          json(res, 400, { error: `未知动作 ${action}` });
          return;
        }
        json(res, 200, { ok: true });
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
  console.log(`m3u8 下载器 GUI: http://${HOST}:${PORT}`);
});
