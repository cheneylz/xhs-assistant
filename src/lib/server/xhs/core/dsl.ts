/**
 * ds 接口（sec sdk 时间戳锚点）拉取器（对应原版 xhs_core/dsl.py）
 *
 * _dsl 来源：https://as.xiaohongshu.com/api/sec/v1/ds?appId=<appId> 返回的 JS 中
 * `function getdss() { return '<13位时间戳>'; }`。5 分钟内存缓存，失败降级复用旧值。
 */
import { BrowserHttpClient } from "./http";

const GETDSS_RE = /function\s+getdss\s*\(\s*\)\s*\{\s*return\s+'(\d+)'/;
const TTL = 300;

export class DsFetcher {
  private appId: string;
  private referer: string;
  private ttl: number;
  private value: string | null = null;
  private program: string | null = null;
  private fetchedAt = 0;
  private fetching: Promise<[string, string]> | null = null;

  constructor(appId: string, options: { referer: string; ttl?: number } = { referer: "" }) {
    this.appId = String(appId);
    this.referer = options.referer;
    this.ttl = options.ttl ?? TTL;
  }

  get url(): string {
    return `https://as.xiaohongshu.com/api/sec/v1/ds?appId=${this.appId}`;
  }

  /** 取 getdss() 值（=_dsl）。缓存命中直接返回，否则 fetch；失败降级复用旧值 */
  async get(options: { force?: boolean; httpClient?: BrowserHttpClient } = {}): Promise<string> {
    const { force = false, httpClient } = options;
    const now = Date.now() / 1000;
    if (!force && this.value && now - this.fetchedAt < this.ttl) {
      return this.value;
    }
    // 并发去重（多请求同时过期时只发一次）
    if (this.fetching) {
      const [value] = await this.fetching;
      return value;
    }
    this.fetching = this.fetchWithFallback(httpClient);
    try {
      const [value] = await this.fetching;
      this.value = value;
      this.fetchedAt = now;
      return value;
    } finally {
      this.fetching = null;
    }
  }

  /** 取 getdss() 值及其 DS 程序（对应 get_bundle；value 与 program 双缓存） */
  async getBundle(options: { force?: boolean; httpClient?: BrowserHttpClient } = {}): Promise<[string, string]> {
    const { force = false, httpClient } = options;
    const now = Date.now() / 1000;
    if (!force && this.value && this.program && now - this.fetchedAt < this.ttl) {
      return [this.value, this.program];
    }
    try {
      const [value, program] = await this.fetch(httpClient);
      this.value = value;
      this.program = program;
      this.fetchedAt = now;
      return [value, program];
    } catch (error) {
      if (this.value && this.program) {
        // 失败降级：返回旧值
        return [this.value, this.program];
      }
      throw new Error(`ds 接口首次 fetch 失败（appId=${this.appId}）：${(error as Error).message}`);
    }
  }

  private async fetchWithFallback(httpClient?: BrowserHttpClient): Promise<[string, string]> {
    try {
      const result = await this.fetch(httpClient);
      this.program = result[1];
      return result;
    } catch (error) {
      if (this.value && this.program) {
        // 失败降级：返回旧值
        return [this.value, this.program];
      }
      throw new Error(`ds 接口首次 fetch 失败（appId=${this.appId}）：${(error as Error).message}`);
    }
  }

  private async fetch(httpClient?: BrowserHttpClient): Promise<[string, string]> {
    const headers = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
      Referer: this.referer || "https://www.xiaohongshu.com/",
      Accept: "*/*",
    };
    const client = httpClient ?? new BrowserHttpClient();
    const owned = !httpClient;
    try {
      const response = await client.get(this.url, { headers, timeout: 8000 });
      response.raiseForStatus();
      const match = GETDSS_RE.exec(response.text);
      if (!match) throw new Error("ds 响应未匹配 getdss() 模式");
      const program = response.text;
      if (!program.includes("_dsf") && !program.includes("__$c")) {
        throw new Error("ds response does not contain the DS runtime program");
      }
      return [match[1], program];
    } finally {
      if (owned) client.close();
    }
  }

  peek(): string | null {
    return this.value;
  }
}

/** 通用默认实例（对应 xhs_pc/dsl.py 的模块级单例语义，按 appId 缓存） */
const defaultFetchers = new Map<string, DsFetcher>();

export function getDsl(appId: string, referer = "https://www.xiaohongshu.com/"): DsFetcher {
  let fetcher = defaultFetchers.get(appId);
  if (!fetcher) {
    fetcher = new DsFetcher(appId, { referer });
    defaultFetchers.set(appId, fetcher);
  }
  return fetcher;
}

/** _dsn 是静态字符串（VMP 直接写入 "a3"），无需拉接口 */
export const DSN_STATIC = "a3";
