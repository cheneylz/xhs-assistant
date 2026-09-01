/**
 * 共享浏览器指纹 HTTP 传输（对应原版 xhs_core/http.py）
 * 传输后端：curl-impersonate（可用时）→ fetch（降级）
 */
import { impersonateRequest, type ImpersonateResponse } from "../../transport/curl-impersonate";
import { parseCookieKv } from "./cookies";

export const DEFAULT_IMPERSONATE = "chrome146";
export const DEFAULT_ACCEPT_ENCODING = "gzip, deflate, br, zstd";
export const DEFAULT_HTTP_VERSION = "v2tls";

export class HttpError extends Error {
  readonly status: number;
  readonly response: HttpResponse;

  constructor(status: number, response: HttpResponse) {
    super(`HTTP ${status} error`);
    this.name = "HttpError";
    this.status = status;
    this.response = response;
  }
}

/** 响应对象（对齐 requests 语义：text / json() / headers / status_code / url / cookies） */
export class HttpResponse {
  statusCode: number;
  url: string;
  headersList: [string, string][];
  body: Buffer;
  backend: string;

  constructor(raw: ImpersonateResponse) {
    this.statusCode = raw.status;
    this.url = raw.url;
    this.headersList = raw.headers;
    this.body = raw.body;
    this.backend = raw.backend;
  }

  get text(): string {
    return this.body.toString("utf-8");
  }

  get headers(): { get: (name: string) => string | null } {
    const map = new Map(this.headersList.map(([k, v]) => [k.toLowerCase(), v]));
    return { get: (name: string) => map.get(name.toLowerCase()) ?? null };
  }

  json<T = unknown>(): T {
    return JSON.parse(this.text) as T;
  }

  raiseForStatus(): void {
    if (this.statusCode >= 400) {
      throw new HttpError(this.statusCode, this);
    }
  }

  /** 解析 Set-Cookie 为键值对（对应 requests cookies 的迭代语义） */
  get cookies(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [name, value] of this.headersList) {
      if (name === "set-cookie") {
        const parts = value.split(";");
        const first = parts[0]?.trim();
        if (!first) continue;
        const index = first.indexOf("=");
        if (index > 0) result[first.slice(0, index)] = first.slice(index + 1);
      }
    }
    return result;
  }
}

/** Cookie 头序列化 */
function cookieHeaderValue(cookies: unknown): string {
  if (!cookies) return "";
  if (typeof cookies === "string") return cookies;
  if (typeof cookies === "object") {
    return Object.entries(cookies as Record<string, unknown>)
      .map(([key, value]) => `${key}=${value}`)
      .join("; ");
  }
  return "";
}

/**
 * 强制 header 顺序契约（对应 ordered_wire_headers）
 * HTTP/2 伪头与 content-length 由传输层负责
 */
export function orderedWireHeaders(
  headers: Record<string, unknown> | null | undefined,
  options: {
    order: string[];
    cookies?: unknown;
    acceptEncoding?: string;
    strict?: boolean;
    optional?: string[];
  },
): Record<string, string> {
  const { order, cookies, acceptEncoding = DEFAULT_ACCEPT_ENCODING, strict = true, optional = [] } = options;
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    const name = key.toLowerCase();
    if (name === "authority") continue;
    if (value !== null && value !== undefined) values[name] = String(value);
  }
  if (!values["accept-encoding"]) values["accept-encoding"] = acceptEncoding;
  const cookie = cookieHeaderValue(cookies);
  if (cookie) {
    values.cookie = cookie;
  } else {
    delete values.cookie;
  }
  const normalizedOrder = order.map((k) => k.toLowerCase());
  const optionalNames = new Set(optional.map((k) => k.toLowerCase()));
  const missing = normalizedOrder.filter((key) => !(key in values) && !optionalNames.has(key));
  const unexpected = Object.keys(values)
    .filter((key) => !normalizedOrder.includes(key))
    .sort();
  if (missing.length || (strict && unexpected.length)) {
    throw new Error(`wire header contract drifted: missing=[${missing.join(",")}], unexpected=[${unexpected.join(",")}]`);
  }
  const result: Record<string, string> = {};
  for (const key of normalizedOrder) {
    if (key in values) result[key] = values[key];
  }
  return result;
}

export interface HttpClientRequestOptions {
  headers?: Record<string, unknown>;
  cookies?: unknown;
  proxies?: Record<string, string> | null;
  data?: Buffer | string | null;
  json?: unknown;
  timeout?: number;
  /** 跳过 curl-impersonate，强制 fetch */
  forceFetch?: boolean;
}

/** 可复用的浏览器指纹 Session（对应 BrowserHttpClient） */
export class BrowserHttpClient {
  proxies: Record<string, string> | null;
  impersonate: string;
  acceptEncoding: string;
  httpVersion: string;

  constructor(options: {
    proxies?: Record<string, string> | null;
    impersonate?: string;
    acceptEncoding?: string;
    httpVersion?: string;
  } = {}) {
    this.proxies = options.proxies ?? null;
    this.impersonate = options.impersonate ?? DEFAULT_IMPERSONATE;
    this.acceptEncoding = options.acceptEncoding ?? DEFAULT_ACCEPT_ENCODING;
    this.httpVersion = options.httpVersion ?? DEFAULT_HTTP_VERSION;
  }

  async request(method: string, url: string, options: HttpClientRequestOptions = {}): Promise<HttpResponse> {
    const wireHeaders: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(options.headers ?? {})) {
      const name = String(key);
      if (name.toLowerCase() === "authority") continue;
      wireHeaders[name] = value === null ? null : String(value);
    }
    const lowered = new Set(Object.keys(wireHeaders).map((k) => k.toLowerCase()));
    const cookie = cookieHeaderValue(options.cookies);
    if (cookie && !lowered.has("cookie")) {
      wireHeaders.cookie = cookie;
      lowered.add("cookie");
    }
    if (!lowered.has("accept-encoding")) {
      wireHeaders["accept-encoding"] = this.acceptEncoding;
    }

    const upperMethod = String(method).toUpperCase();
    let body: Buffer | string | null = null;
    if (options.json !== undefined) {
      body = JSON.stringify(options.json);
      if (!lowered.has("content-type")) {
        wireHeaders["content-type"] = "application/json;charset=UTF-8";
      }
    } else if (options.data !== undefined && options.data !== null) {
      body = options.data;
    }
    if (upperMethod === "POST" && options.json === undefined && options.data === undefined && !lowered.has("content-type")) {
      // 空 POST 契约：Content-Length: 0 且无 Content-Type（对应原版 None header 抑制逻辑）
      // curl-impersonate 通过 -H "content-type:" 空值抑制
      wireHeaders["content-type"] = "";
    }
    if (options.json === undefined && options.data === undefined && upperMethod === "POST") {
      body = "";
    }

    const finalHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(wireHeaders)) {
      if (value === null || value === "") {
        finalHeaders[key] = ""; // 空值头：curl 发送 "key:" 抑制默认值
      } else {
        finalHeaders[key] = String(value);
      }
    }

    const raw = await impersonateRequest({
      url,
      method: upperMethod,
      headers: finalHeaders,
      body,
      impersonate: this.impersonate,
      httpVersion: this.httpVersion,
      timeoutMs: options.timeout ?? 30000,
      allowFallback: !options.forceFetch,
    });
    return new HttpResponse(raw);
  }

  get(url: string, options: HttpClientRequestOptions = {}): Promise<HttpResponse> {
    return this.request("GET", url, options);
  }

  post(url: string, options: HttpClientRequestOptions = {}): Promise<HttpResponse> {
    return this.request("POST", url, options);
  }

  put(url: string, options: HttpClientRequestOptions = {}): Promise<HttpResponse> {
    return this.request("PUT", url, options);
  }

  close(): void {
    // curl-impersonate 每次调用独立进程，无会话需关闭
  }

  stateSnapshot(): Record<string, string> {
    return {
      backend: "curl-impersonate",
      impersonate: this.impersonate,
      httpVersion: this.httpVersion,
      defaultHeaders: "false",
      cookieJarPersistence: "false",
    };
  }
}

export { parseCookieKv };
