/**
 * 爬取限流器（对应原版 backend/app/services/rate_limiter.py，内存滑动窗口）
 */
export class CrawlRateLimiter {
  private max: number;
  private windows = new Map<number, number[]>();
  private mutex: Promise<void> = Promise.resolve();

  constructor(maxPerMinute = 5) {
    this.max = maxPerMinute;
  }

  get maxPerMinute(): number {
    return this.max;
  }

  /** 是否允许该账号发起请求（滑动窗口 60s） */
  async allow(accountId: number): Promise<boolean> {
    let previous = this.mutex;
    let release!: () => void;
    this.mutex = new Promise<void>((resolve) => (release = resolve));
    await previous;
    try {
      const now = Date.now();
      const cutoff = now - 60_000;
      const window = (this.windows.get(accountId) ?? []).filter((t) => t > cutoff);
      if (window.length >= this.max) {
        this.windows.set(accountId, window);
        return false;
      }
      window.push(now);
      this.windows.set(accountId, window);
      return true;
    } finally {
      release();
    }
  }

  reset(accountId: number): void {
    this.windows.delete(accountId);
  }
}

let globalLimiter: CrawlRateLimiter | null = null;

/** 全局限流器（5 次/分/账号） */
export function getRateLimiter(): CrawlRateLimiter {
  if (!globalLimiter) {
    globalLimiter = new CrawlRateLimiter(5);
  }
  return globalLimiter;
}
