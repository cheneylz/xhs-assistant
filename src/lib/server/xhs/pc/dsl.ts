/**
 * PC ds 接口（sec sdk 时间戳锚点）拉取器（对应原版 xhs_pc/dsl.py）
 * 模块级单例：一次页面一份（与浏览器 window._dsl 语义一致）
 */
import { DsFetcher, DSN_STATIC } from "../core/dsl";

export { DSN_STATIC };

/** PC 默认 ds 拉取器（appId=xhs-pc-web） */
const defaultFetcher = new DsFetcher("xhs-pc-web", { referer: "https://www.xiaohongshu.com/" });

/** 获取 getdss() 值（=_dsl），5 分钟缓存，失败降级复用旧值 */
export function getDsl(options: { force?: boolean; httpClient?: import("../core/http").BrowserHttpClient } = {}): Promise<string> {
  return defaultFetcher.get(options);
}

/** 获取 _dsl 及 DS 程序（供 Creator mns0101 _dsf 使用） */
export function getDslBundle(options: { force?: boolean; httpClient?: import("../core/http").BrowserHttpClient } = {}): Promise<[string, string]> {
  return defaultFetcher.getBundle(options);
}

export { DsFetcher };
