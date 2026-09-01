/**
 * Creator Chrome 指纹传输（对应原版 xhs_creator/http.py）
 */
import { BrowserHttpClient } from "../core/http";

export const CREATOR_IMPERSONATE = "chrome146";
export const CREATOR_ACCEPT_ENCODING = "gzip, deflate, br, zstd";
export const CREATOR_HTTP_VERSION = "v2tls";

/** Creator 生命周期复用的 Chrome 指纹 Session */
export class CreatorHttpClient extends BrowserHttpClient {
  constructor(options: { proxies?: Record<string, string> | null; impersonate?: string } = {}) {
    super({
      proxies: options.proxies ?? null,
      impersonate: options.impersonate ?? CREATOR_IMPERSONATE,
      acceptEncoding: CREATOR_ACCEPT_ENCODING,
      httpVersion: CREATOR_HTTP_VERSION,
    });
  }
}
