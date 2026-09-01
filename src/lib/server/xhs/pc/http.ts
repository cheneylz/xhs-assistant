/**
 * PC Web Chrome 指纹传输（对应原版 xhs_pc/http.py）
 */
import { BrowserHttpClient } from "../core/http";

export const PC_IMPERSONATE = "chrome146";
export const PC_ACCEPT_ENCODING = "gzip, deflate, br, zstd";
export const PC_HTTP_VERSION = "v2tls";

/** PC 生命周期复用的 Chrome 指纹 Session */
export class PcHttpClient extends BrowserHttpClient {
  constructor(options: { proxies?: Record<string, string> | null; impersonate?: string } = {}) {
    super({
      proxies: options.proxies ?? null,
      impersonate: options.impersonate ?? PC_IMPERSONATE,
      acceptEncoding: PC_ACCEPT_ENCODING,
      httpVersion: PC_HTTP_VERSION,
    });
  }
}
