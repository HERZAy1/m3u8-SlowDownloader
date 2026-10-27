import { CancelledError } from './control.ts';
import { formatDuration } from './playlist.ts';
import { DownloadTask } from './task.ts';
import type { TaskEvent } from './types.ts';

interface CliOptions {
  url: string | null;
  out: string | null;
  speed: number;
  jitter: number;
  retries: number;
  resume: 'fast' | 'pace';
  limit: number | null;
  merge: boolean;
  remux: boolean;
  dryRun: boolean;
  quiet: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    url: null,
    out: null,
    speed: 2,
    jitter: 300,
    retries: 3,
    resume: 'fast',
    limit: null,
    merge: true,
    remux: false,
    dryRun: false,
    quiet: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`参数 ${arg} 缺少取值`);
      i += 1;
      return value;
    };

    switch (arg) {
      case '--out':
        opts.out = next();
        break;
      case '--speed':
        opts.speed = Number.parseFloat(next());
        break;
      case '--jitter':
        opts.jitter = Number.parseInt(next(), 10);
        break;
      case '--retries':
        opts.retries = Number.parseInt(next(), 10);
        break;
      case '--resume': {
        const mode = next();
        if (mode !== 'fast' && mode !== 'pace') throw new Error('--resume 只接受 fast 或 pace');
        opts.resume = mode;
        break;
      }
      case '--limit':
        opts.limit = Number.parseInt(next(), 10);
        break;
      case '--no-merge':
        opts.merge = false;
        break;
      case '--remux':
        opts.remux = true;
        break;
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '--quiet':
        opts.quiet = true;
        break;
      case '-h':
      case '--help':
        opts.help = true;
        break;
      default:
        if (arg.startsWith('-')) throw new Error(`未知参数：${arg}`);
        if (opts.url) throw new Error('只能指定一个 m3u8 地址');
        opts.url = arg;
    }
  }

  return opts;
}

function printHelp(): void {
  console.log(`m3u8 下载器 — 按 EXTINF 节奏缓速下载，输出原始 TS

用法：
  node src/cli.ts <m3u8-url> [选项]

选项：
  --out <dir>        输出目录（默认 downloads/<任务名>）
  --speed <n>        倍速，默认 2；0 表示关闭节拍全速下载
  --jitter <ms>      计划时刻的随机抖动，默认 300
  --retries <n>      单分片重试次数，默认 3
  --resume <mode>    fast（跳过已下载，默认）| pace（保持节奏）
  --limit <n>        只下载前 n 片，调试用
  --no-merge         下载完不拼接
  --remux            拼接后用 ffmpeg 重建时间戳
  --dry-run          只解析并打印统计，不下载
  --quiet            不打印进度行
  -h, --help         显示帮助

示例：
  node src/cli.ts "https://example.com/play.m3u8" --speed 2
  node src/cli.ts "https://example.com/play.m3u8" --dry-run
  node src/cli.ts "https://example.com/play.m3u8" --limit 5 --speed 20 --out ./tmp
`);
}

function defaultTaskId(url: string): string {
  try {
    const parsed = new URL(url);
    const base = parsed.pathname.split('/').filter(Boolean).pop() ?? 'task';
    return base.replace(/\.m3u8?$/i, '') || 'task';
  } catch {
    return 'task';
  }
}

function renderProgress(completed: number, total: number, elapsedMs: number, etaMs: number, speed: number): string {
  const percent = total > 0 ? (completed / total) * 100 : 0;
  const speedLabel = speed > 0 ? `${speed.toFixed(1)}x` : '不限速';
  const barWidth = 20;
  const filled = Math.round((percent / 100) * barWidth);
  const bar = `${'#'.repeat(filled)}${'-'.repeat(barWidth - filled)}`;
  const remaining = speed > 0 ? `剩余 ${formatDuration(etaMs / 1000)}` : '剩余 --:--:--';
  return `[${bar}] ${String(completed).padStart(4)}/${total} ${percent.toFixed(1).padStart(5)}%  ${speedLabel}  已用 ${formatDuration(elapsedMs / 1000)}  ${remaining}`;
}

async function main(): Promise<number> {
  let opts: CliOptions;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`参数错误：${(err as Error).message}\n`);
    printHelp();
    return 1;
  }

  if (opts.help) {
    printHelp();
    return 0;
  }

  if (!opts.url) {
    printHelp();
    return 1;
  }

  const outDir = opts.out ?? `downloads/${defaultTaskId(opts.url)}`;

  const task = new DownloadTask({
    url: opts.url,
    outDir,
    speed: opts.speed,
    jitterMs: opts.jitter,
    retries: opts.retries,
    resume: opts.resume,
    limit: opts.limit ?? undefined,
    merge: opts.merge,
    remux: opts.remux,
    dryRun: opts.dryRun,
  });

  let lastLineLength = 0;

  task.on((event: TaskEvent) => {
    switch (event.type) {
      case 'playlist':
        console.log(
          `分片 ${event.total} 个，总时长 ${formatDuration(event.totalDuration)}（${event.totalDuration.toFixed(2)}s），` +
            `断点 ${event.discontinuities} 个，${event.isVod ? '静态点播' : '非点播'}`,
        );
        if (opts.speed > 0 && !opts.dryRun) {
          console.log(`预计耗时 ${formatDuration(event.totalDuration / opts.speed)}（${opts.speed}x）\n`);
        }
        break;
      case 'progress': {
        if (opts.quiet || opts.dryRun) break;
        const { completed, total, elapsedMs, etaMs, speed } = event.snapshot;
        const line = renderProgress(completed, total, elapsedMs, etaMs, speed);
        process.stdout.write(`\r${line}${' '.repeat(Math.max(0, lastLineLength - line.length))}`);
        lastLineLength = line.length;
        break;
      }
      case 'error':
        if (!opts.quiet) process.stdout.write('\n');
        lastLineLength = 0;
        console.error(`  分片 ${event.index} 第 ${event.attempt} 次失败：${event.message}`);
        break;
      case 'done': {
        if (!opts.quiet) process.stdout.write('\n');
        console.log(`\n完成：下载 ${event.bytes > 0 ? (event.bytes / 1024 / 1024).toFixed(1) : 0} MB，用时 ${formatDuration(event.elapsedMs / 1000)}`);
        if (event.failed.length > 0) {
          console.log(`失败 ${event.failed.length} 个分片：${event.failed.slice(0, 20).join(', ')}${event.failed.length > 20 ? ' ...' : ''}`);
        }
        if (event.outputPath) console.log(`输出：${event.outputPath}`);
        break;
      }
      default:
        break;
    }
  });

  process.on('SIGINT', () => {
    process.stdout.write('\n收到中断，正在保存进度…\n');
    task.cancel();
  });

  try {
    const result = await task.run();
    return result.failed.length > 0 ? 2 : 0;
  } catch (err) {
    if (err instanceof CancelledError) {
      console.log('已取消。已下载的分片保留在输出目录，重新运行可续传。');
      return 130;
    }
    console.error(`\n失败：${(err as Error).message}`);
    return 1;
  }
}

const code = await main();
process.exitCode = code;
