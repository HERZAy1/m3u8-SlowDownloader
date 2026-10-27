import { HttpError } from './types.ts';
import type { HttpClient, HttpRequestOptions } from './types.ts';

/**
 * 基于 Node 内置 fetch（undici）的 HTTP 实现。
 *
 * 零依赖：Node 18+ 自带 fetch，keep-alive 由全局 dispatcher 维护。
 * 将来若要上 TLS 指纹伪装，新增一个实现同一接口的类即可，调度层不动。
 */
export class FetchHttpClient implements HttpClient {
  private readonly baseHeaders: Record<string, string>;
  private readonly defaultTimeoutMs: number;

  constructor(baseHeaders: Record<string, string> = {}, defaultTimeoutMs = 30_000) {
    this.baseHeaders = { ...baseHeaders };
    this.defaultTimeoutMs = defaultTimeoutMs;
  }

  async get(url: string, opts: HttpRequestOptions = {}): Promise<Buffer> {
    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;
    const timeoutController = new AbortController();
    const timer = setTimeout(() => {
      timeoutController.abort(new Error(`请求超时（${timeoutMs}ms）`));
    }, timeoutMs);

    const signals: AbortSignal[] = [timeoutController.signal];
    if (opts.signal) signals.push(opts.signal);
    const signal = signals.length > 1 ? AbortSignal.any(signals) : timeoutController.signal;

    try {
      const response = await fetch(url, {
        headers: { ...this.baseHeaders, ...(opts.headers ?? {}) },
        signal,
        redirect: 'follow',
      });

      if (!response.ok) {
        // 及时释放连接，避免 keep-alive 池被无体响应占住
        await response.body?.cancel().catch(() => {});
        throw new HttpError(response.status, url);
      }

      return Buffer.from(await response.arrayBuffer());
    } finally {
      clearTimeout(timer);
    }
  }
}
