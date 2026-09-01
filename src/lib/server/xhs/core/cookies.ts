/**
 * 按 host 隔离的有序 Cookie 存储（对应原版 xhs_core/cookies.py，纯逻辑平移）
 */
export const HOST_ONLY_COOKIE_NAMES = new Set(["acw_tc"]);

/** 解析 Cookie 头，保持键序 */
export function parseCookieKv(value: unknown): Record<string, string> {
  if (value === null || value === undefined) return {};
  if (typeof value === "object" && !Array.isArray(value)) {
    const result: Record<string, string> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (key !== null && item !== null && item !== undefined) {
        result[String(key)] = String(item);
      }
    }
    return result;
  }
  const result: Record<string, string> = {};
  for (const part of String(value).split(";")) {
    const item = part.trim();
    if (!item) continue;
    const index = item.indexOf("=");
    if (index > 0) {
      result[item.slice(0, index).trim()] = item.slice(index + 1);
    } else if (item) {
      result[item] = "";
    }
  }
  return result;
}

/** 序列化 Cookie 头 */
export function cookieHeader(value: unknown): string {
  return Object.entries(parseCookieKv(value))
    .map(([key, item]) => `${key}=${item}`)
    .join("; ");
}

/** 从 URL 提取 host */
export function urlHost(url: string): string {
  try {
    return (new URL(String(url)).hostname || "").toLowerCase();
  } catch {
    return "";
  }
}

const KEY_SEP = "::";

function orderKey(scope: string, host: string, name: string): string {
  return `${scope}${KEY_SEP}${host}${KEY_SEP}${name}`;
}

/**
 * 保持边缘 Cookie 按签发 host 隔离（对应 HostCookieStore）
 */
export class HostCookieStore {
  private values: Record<string, Record<string, string>> = {};
  private order: Map<string, number> = new Map();
  private nextOrder = 0;

  constructor(hostCookies?: Record<string, unknown> | null) {
    for (const [host, value] of Object.entries(hostCookies ?? {})) {
      const normalized = urlHost(String(host)) || String(host).toLowerCase().trim();
      if (normalized) {
        const parsed = parseCookieKv(value);
        this.values[normalized] = parsed;
        for (const name of Object.keys(parsed)) {
          this.remember("host", normalized, name);
        }
      }
    }
  }

  static fromState(state?: Record<string, unknown> | null): HostCookieStore {
    const data = { ...(state ?? {}) };
    const store = new HostCookieStore((data.values as Record<string, unknown>) ?? {});
    const order = (data.order as Array<[string, string, string]>) ?? [];
    if (order.length) {
      store.order = new Map();
      store.nextOrder = 0;
      for (const item of order) {
        if (!Array.isArray(item) || item.length < 3) continue;
        store.remember(String(item[0]), String(item[1]), String(item[2]));
      }
    }
    return store;
  }

  private remember(scope: string, host: string, name: string, move = false): void {
    const k = orderKey(scope, host, name);
    if (move) this.order.delete(k);
    if (!this.order.has(k)) {
      this.order.set(k, this.nextOrder++);
    }
  }

  snapshot(): Record<string, Record<string, string>> {
    const result: Record<string, Record<string, string>> = {};
    for (const [host, values] of Object.entries(this.values)) {
      result[host] = { ...values };
    }
    return result;
  }

  exportState(): Record<string, unknown> {
    const ordered = [...this.order.entries()].sort((a, b) => a[1] - b[1]).map(([k]) => k);
    return {
      values: this.snapshot(),
      order: ordered.map((k) => k.split(KEY_SEP)),
    };
  }

  update(hostOrUrl: string, cookies: unknown): void {
    const host = urlHost(hostOrUrl) || hostOrUrl.toLowerCase().trim();
    if (!host) throw new Error("host Cookie update requires a host or URL");
    const updates = parseCookieKv(cookies);
    const target = (this.values[host] ??= {});
    for (const [name, value] of Object.entries(updates)) {
      target[name] = value;
      this.remember("host", host, name);
    }
  }

  extractHostOnly(
    shared: Record<string, string>,
    sourceUrl: string,
    names: Iterable<string> = HOST_ONLY_COOKIE_NAMES,
  ): Record<string, string> {
    const host = urlHost(sourceUrl);
    const hostOnly = new Set(names);
    for (const name of [...Object.keys(shared)]) {
      if (hostOnly.has(name)) {
        const value = shared[name];
        delete shared[name];
        if (host) {
          (this.values[host] ??= {})[name] = value;
          this.remember("host", host, name);
        }
      } else {
        this.remember("shared", "", name);
      }
    }
    return shared;
  }

  cookiesForUrl(url: string, shared: unknown): Record<string, string> {
    const values = parseCookieKv(shared);
    for (const name of Object.keys(values)) {
      this.remember("shared", "", name);
    }
    const host = urlHost(url);
    const combined: Array<[number, string, string]> = [];
    for (const [name, value] of Object.entries(values)) {
      combined.push([this.order.get(orderKey("shared", "", name)) ?? 0, name, value]);
    }
    for (const [name, value] of Object.entries(this.values[host] ?? {})) {
      this.remember("host", host, name);
      combined.push([this.order.get(orderKey("host", host, name)) ?? 0, name, value]);
    }
    combined.sort((a, b) => a[0] - b[0]);
    const result: Record<string, string> = {};
    for (const [, name, value] of combined) result[name] = value;
    return result;
  }

  /** 合并响应 Set-Cookie（对应 merge_response） */
  mergeResponse(
    shared: Record<string, string>,
    response: { url?: string; cookies?: Record<string, string> },
    appendShared: Iterable<string> = [],
  ): Record<string, string> {
    const host = urlHost(String(response.url ?? ""));
    const appendNames = new Set(appendShared);
    for (const [name, value] of Object.entries(response.cookies ?? {})) {
      if (HOST_ONLY_COOKIE_NAMES.has(name)) {
        if (host) {
          (this.values[host] ??= {})[name] = String(value);
          this.remember("host", host, name);
        }
        continue;
      }
      if (appendNames.has(name) && name in shared) {
        delete shared[name];
        this.remember("shared", "", name, true);
      } else {
        this.remember("shared", "", name);
      }
      shared[name] = String(value);
    }
    return shared;
  }
}
