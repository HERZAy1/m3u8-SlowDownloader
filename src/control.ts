export class CancelledError extends Error {
  constructor() {
    super('任务已取消');
    this.name = 'CancelledError';
  }
}

/**
 * 暂停 / 取消 的单一控制点。
 *
 * 暂停的关键在于：暂停时长要计入时间轴，否则恢复后所有分片会集中补发。
 * 调度器通过 totalPausedMs 把暂停时间平移进 t0。
 */
export class TaskControl {
  private _paused = false;
  private _cancelled = false;
  private _pauseStartedAt = 0;
  private _accumulatedPauseMs = 0;
  private readonly _abort = new AbortController();

  get paused(): boolean {
    return this._paused;
  }

  get cancelled(): boolean {
    return this._cancelled;
  }

  /** 累计暂停毫秒数，包含当前正在进行中的暂停。 */
  get totalPausedMs(): number {
    const inflight = this._paused ? Date.now() - this._pauseStartedAt : 0;
    return this._accumulatedPauseMs + inflight;
  }

  get signal(): AbortSignal {
    return this._abort.signal;
  }

  pause(): void {
    if (this._paused || this._cancelled) return;
    this._paused = true;
    this._pauseStartedAt = Date.now();
  }

  resume(): void {
    if (!this._paused) return;
    this._accumulatedPauseMs += Date.now() - this._pauseStartedAt;
    this._paused = false;
  }

  cancel(): void {
    if (this._cancelled) return;
    this._cancelled = true;
    this._abort.abort(new CancelledError());
  }

  throwIfCancelled(): void {
    if (this._cancelled) throw new CancelledError();
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
