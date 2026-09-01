/**
 * Creator _dsl 锚点（appId=ugc，对应原版 xhs_creator/dsl.py）
 */
import { DsFetcher } from "../core/dsl";

export const DSN_READY = "a1";
export const DSN_BOOTSTRAP = "nop";

/** Creator 默认 ds 拉取器（含 value + program 双缓存） */
const defaultFetcher = new DsFetcher("ugc", { referer: "https://creator.xiaohongshu.com/" });

export function getDsl(options: { force?: boolean; httpClient?: import("../core/http").BrowserHttpClient } = {}): Promise<string> {
  return defaultFetcher.get(options);
}

export function getDsBundle(options: { force?: boolean; httpClient?: import("../core/http").BrowserHttpClient } = {}): Promise<[string, string]> {
  return defaultFetcher.getBundle(options);
}

export { DsFetcher };
