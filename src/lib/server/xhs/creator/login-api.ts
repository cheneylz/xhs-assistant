/**
 * Creator 端登录 API（对应原版 apis/xhs_creator_login_apis.py，逐逻辑翻译）
 *
 * XHSCreatorLoginApi：与浏览器无关的国内 Creator 二维码/短信登录客户端。
 * 初始化顺序对齐 Creator 4.3.6 浏览器（CDP 抓包 + mns 包解码，build 1.19.3，2026-07-25）：
 *   1. 匿名 Cookie/设备状态；
 *   2. 拉取 honeypot 与 DS 程序（DS 请求为 MNS0201/nop）；
 *   3. 立即安装 DS 程序后运行 zones、自动 CAS 探测、redcaptcha 与 sbtsource
 *      —— 均为 MNS0101/a1 login_early（其中 406 为按请求概率、会话内重试）；
 *   4. 以 MNS0101/a1 完成 seccallback/webprofile（login_callback/login_ready）；
 *   5. CAS 二维码或手机号登录；
 *   6. Creator 用户信息验收。
 *
 * 请求签名与 profileData 均为纯计算；二维码确认、短信验证码、gid/sec_poison_id
 * 与最终登录 Cookie 由服务端签发。
 *
 * 与原 Python 的已知差异：
 * - loguru 日志 → console 系列（debug/info/warn/error/log）；
 * - input() → readLine()（node:readline/promises）；
 * - time.sleep(1) → sleep(1000)；
 * - Python 显式 allow_redirects=False，本 SDK 传输层未暴露重定向开关，此处未传；
 * - qrcode 终端/图片展示用 npm qrcode 包实现（参数为对应适配）。
 */
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

import type { HttpResponse } from "../core/http";
import { HostCookieStore, urlHost } from "../core/cookies";
import { generateCreatorProfileData, generateWebsectiga } from "../core/runtime";
import { generateA1, generateWebId } from "../core/util";
import { CREATOR_PLATFORM_CONFIG } from "../core/auth";
import { getDsBundle } from "../creator/dsl";
import { CreatorHttpClient } from "../creator/http";
import {
  CREATOR_SEC_CH_UA,
  buildCreatorLoginHeaders,
  buildCreatorNavigationHeaders,
  generateProfileRequestParams,
  getRequestHeadersTemplate,
  spliceStrCreator,
} from "../creator/params";
import { CreatorDeviceProfile, cookieHeader } from "../creator/state";
import * as QRCode from "qrcode";

export const CREATOR_WEB_BUILD = "1.18.0";
export const CREATOR_WEBPROFILE_SDK = "4.3.6";
export const CREATOR_LOGIN_ACCEPT_LANGUAGE = "zh-CN,zh;q=0.9";
export const CREATOR_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/150.0.0.0 Safari/537.36";

/** 对应原版 http_util.REQUEST_TIMEOUT = 15（秒），SDK timeout 单位为毫秒 */
const REQUEST_TIMEOUT_MS = 15_000;

const GETDSS_RE = /function\s+getdss\s*\(\s*\)\s*\{\s*return\s+'(\d+)'/;

const SECURITY_COOKIE_LENGTHS: Record<string, number> = {
  websectiga: 64,
  sec_poison_id: 36,
  gid: 72,
};

// 安全初始化完成后，浏览器把 `loadts` Cookie 重建到**末尾**，其余字段保持各自的
// 创建/响应到达顺序（CDP 抓包实证）。两份真实样本：
//   verify-code: ets, webBuild, xsecappid, a1, webId, acw_tc, websectiga, sec_poison_id, gid, loadts
//   qr-code    : ets, webBuild, xsecappid, a1, webId, acw_tc, gid, websectiga, sec_poison_id, loadts
// 中段 gid 与 websectiga/sec_poison_id 的相对次序随会话响应竞速而变（非固定协议）；
// 唯一稳定不变的是「匿名前缀 + loadts 置于末尾」。因此这里只做最小变换：保持传入
// 顺序、仅把 loadts 移到最后。我们本地的到达顺序（seccallback 先、webprofile 后）
// 与浏览器 verify-code 样本逐字节一致。
// 2026-07-25 补充证据：1.19.3 浏览器两次抓包的 Cookie 顺序本身不稳定
// （loadts 一次在第 4 位、一次在倒数第 2 位），说明服务端并不校验字段次序；
// 保留此变换仅因为它是 2026-07-25 01:27 端到端登录成功时的已验证形态。

/** 保持字段到达顺序，仅把 loadts 移到末尾，对齐浏览器 CAS 请求 Cookie。 */
function orderCreatorLoginCookies(cookies: Record<string, string>): Record<string, string> {
  const ordered: Record<string, string> = {};
  for (const [name, value] of Object.entries(cookies)) {
    if (name !== "loadts") ordered[name] = value;
  }
  if ("loadts" in cookies) ordered.loadts = cookies.loadts;
  return ordered;
}

export const QR_STATUS_ERROR = 0;
export const QR_STATUS_SUCCESS = 1;
export const QR_STATUS_WAIT_SCAN = 2;
export const QR_STATUS_WAIT_CONFIRM = 3;
export const QR_STATUS_EXPIRED = 4;
export const QR_STATUS_MESSAGES: Record<number, string> = {
  [QR_STATUS_ERROR]: "二维码状态异常",
  [QR_STATUS_SUCCESS]: "验证成功",
  [QR_STATUS_WAIT_SCAN]: "请扫描二维码",
  [QR_STATUS_WAIT_CONFIRM]: "请在手机上确认登录",
  [QR_STATUS_EXPIRED]: "二维码已过期",
};

// customer 域登录动作（qr-code / verify-code）的 HTTP 406 是按设备会话标记的
// 概率闸门（2026-07-25 实证）：被标记的会话重发全部 406，通过的会话持续稳定；
// 同请求重发无效，必须整包重建匿名设备会话。通过率随时间波动（实测 ~0%-50%），
// 16 次尝试在中等通过率（≥0.2）下累计成功率 >97%。
export const LOGIN_SESSION_MAX_ATTEMPTS = 16;

/** 二维码生成成功结果载荷 */
export interface CreatorQrCodeResult {
  cookies: Record<string, string>;
  qr_id: string;
  qr_url: string;
  support_channels: unknown[];
}

/** 二维码响应缺少必要字段时的失败载荷 */
export interface CreatorQrCodeErrorResult {
  cookies: Record<string, string>;
  res_json: Record<string, unknown>;
}

/** 二维码生成返回载荷（成功/缺字段两种形态） */
export type CreatorQrCodePayload = CreatorQrCodeResult | CreatorQrCodeErrorResult;

/** CAS 会话探测详情（service-ticket type=tgt） */
export interface CreatorSessionDetail {
  active: boolean;
  ticket: string;
  type: string;
  cookies: Record<string, string>;
  res_json: Record<string, unknown>;
}

/** 二维码状态查询详情 */
export interface CreatorQrStatusDetail {
  success: boolean;
  message: string;
  status: number | null;
  ticket: string;
  type: string;
  avatar: string;
  cookies: Record<string, string>;
  res_json: Record<string, unknown>;
}

/** _signed 的签名选项（对应原版 _signed 关键字参数） */
export interface CreatorSignedRequestOptions {
  origin?: string | null;
  referer?: string | null;
  secFetchSite?: string;
  includeTraceHeaders?: boolean;
  includeAuthorization?: boolean;
  includeOrigin?: boolean | null;
  tier?: string | null;
  mnsProfile?: string | null;
  b1Profile?: string | null;
  b1Value?: string | null;
  dslPairValue?: string | null;
}

/** 命令行输入（对应 Python input()） */
function readLine(promptText: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  return rl.question(promptText).finally(() => rl.close());
}

/** 延时（对应 time.sleep，参数为毫秒） */
function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class XHSCreatorLoginApi {
  readonly platformConfig = CREATOR_PLATFORM_CONFIG;
  readonly customerUrl = CREATOR_PLATFORM_CONFIG.origin("login");
  readonly creatorUrl = CREATOR_PLATFORM_CONFIG.origin("web");
  readonly asUrl = CREATOR_PLATFORM_CONFIG.origin("security");
  readonly edithUrl = CREATOR_PLATFORM_CONFIG.origin("captcha");
  profile: CreatorDeviceProfile;
  proxies: Record<string, string> | null;
  http: CreatorHttpClient;
  private _securityStarted = false;
  private _securityBootstrapped = false;
  private _securityCompleted = false;
  private _pendingDsl = "";
  private _pendingDsProgram = "";
  private _cookieStore = new HostCookieStore();

  constructor(options: {
    profile?: CreatorDeviceProfile | null;
    proxies?: Record<string, string> | null;
    httpClient?: CreatorHttpClient | null;
  } = {}) {
    this.profile = options.profile ?? new CreatorDeviceProfile({});
    this.proxies = options.proxies ?? null;
    this.http = options.httpClient ?? new CreatorHttpClient({ proxies: this.proxies });
  }

  close(): void {
    this.http.close();
  }

  /** 重建匿名设备会话（406 标记后：新 a1/webId + 新传输连接，保留存储覆盖项） */
  private _resetAnonymousSession(): void {
    this.profile = new CreatorDeviceProfile({
      cookies: "",
      localStorage: { ...this.profile.localStorage },
      sessionStorage: { ...this.profile.sessionStorage },
      source: `${this.profile.source}:retry`,
    });
    this._cookieStore = new HostCookieStore();
    this._securityStarted = false;
    this._securityBootstrapped = false;
    this._securityCompleted = false;
    this._pendingDsl = "";
    this._pendingDsProgram = "";
    this.http.close();
    this.http = new CreatorHttpClient({ proxies: this.proxies });
  }

  hostCookiesSnapshot(): Record<string, Record<string, string>> {
    return this._cookieStore.snapshot();
  }

  hostCookieState(): Record<string, unknown> {
    return this._cookieStore.exportState();
  }

  private _cookiesForUrl(url: string, cookies?: unknown): Record<string, string> {
    const ordered = this._cookieStore.cookiesForUrl(
      url,
      cookies !== undefined ? cookies : this.profile.cookieMap,
    );
    // 仅 customer 域、且安全 Cookie 已就绪的 CAS 请求需要浏览器字段顺序；
    // 匿名早期请求（无 gid/websectiga）保持原顺序以匹配浏览器早期状态。
    if (
      urlHost(url) === this.platformConfig.host("login") &&
      "gid" in ordered &&
      "websectiga" in ordered
    ) {
      return orderCreatorLoginCookies(ordered);
    }
    return ordered;
  }

  private _mergeResponseCookies(response: HttpResponse): Record<string, string> {
    const values = this.profile.cookieMap;
    this._cookieStore.mergeResponse(values, response);
    this.profile.updateCookies(values);
    return this.profile.cookieMap;
  }

  private async _signed(
    api: string,
    data: unknown = "",
    method = "POST",
    options: CreatorSignedRequestOptions = {},
  ): Promise<[Record<string, string>, Record<string, string>, string]> {
    // 独立调用（未经登录引导、直接用 Cookie 新建实例）时保证 DS 程序在位：
    // 0101 + 非 nop 的签名需要服务端 DS 程序的 _dsf；getDsBundle 有缓存，
    // 重复调用零成本。
    const [resolved, material] = this.profile.resolveMnsMaterial({
      tier: options.tier ?? null,
      mnsProfile: options.mnsProfile ?? null,
    });
    if (resolved === "0101" && material.deviceTag !== "nop" && !this.profile.dsProgram) {
      const [dsl, program] = await getDsBundle({ httpClient: this.http });
      this.profile.activateSecurity(dsl, program);
    }
    const [headers, cookies, body] = generateProfileRequestParams(
      this.profile,
      api,
      data,
      method,
      {
        origin: options.origin ?? this.creatorUrl,
        referer: options.referer ?? `${this.creatorUrl}/`,
        secFetchSite: options.secFetchSite,
        // 浏览器实证（2026-07-25 全量 XHR 抓包）：Chrome 只在导航请求里发
        // sec-ch-ua* 客户端提示头，任何 fetch/XHR 都不带。此前每条签名
        // 请求都带上了它们，是系统性的每请求指纹差异。
        includeClientHints: false,
        includeTraceHeaders: options.includeTraceHeaders,
        includeAuthorization: options.includeAuthorization,
        includeOrigin: options.includeOrigin ?? null,
        tier: options.tier ?? null,
        mnsProfile: options.mnsProfile ?? null,
        b1Profile: options.b1Profile ?? null,
        b1Value: options.b1Value ?? null,
        dslPairValue: options.dslPairValue ?? null,
      },
    );
    // Fresh Creator login contexts advertise the short zh-CN language
    // profile. Logged-in note-manager pages use a longer preference list.
    headers["accept-language"] = CREATOR_LOGIN_ACCEPT_LANGUAGE;
    return [headers, cookies, body];
  }

  private _addServiceRatelimitHeader(headers: Record<string, string>): void {
    headers["x-ratelimit-meta"] = `host=${this.platformConfig.host("web")}`;
  }

  /**
   * 诊断用：设置环境变量 XHS_CREATOR_DEBUG=1 时打印请求/响应实况。
   * 默认关闭，不影响正常流程。用于抓取失败的 CAS 请求（Cookie 头、签名头、
   * 服务端返回码与原始 body），以便逐字节对比浏览器抓包。
   */
  private _debugDump(
    label: string,
    options: {
      requestHeaders?: Record<string, string>;
      requestBody?: string;
      response?: HttpResponse;
    } = {},
  ): void {
    if (!process.env.XHS_CREATOR_DEBUG) return;
    const lines = [`==== DEBUG ${label} ====`];
    const { requestHeaders, requestBody, response } = options;
    if (requestHeaders) {
      for (const key of [
        "x-ratelimit-meta", "x-t", "x-s", "x-s-common",
        "origin", "referer", "cookie",
      ]) {
        if (key in requestHeaders) lines.push(`  req ${key}: ${requestHeaders[key]}`);
      }
    }
    if (requestBody !== undefined) lines.push(`  req body: ${requestBody}`);
    if (response) {
      lines.push(`  status: ${response.statusCode}`);
      let respCookies: Record<string, string> = {};
      try {
        respCookies = response.cookies;
      } catch {
        respCookies = {};
      }
      if (Object.keys(respCookies).length) {
        lines.push(`  set-cookie keys: ${Object.keys(respCookies).join(", ")}`);
      }
      const text = response.text || "";
      lines.push(`  resp body: ${text.slice(0, 800)}`);
    }
    console.debug(lines.join("\n"));
  }

  private _responseMessage(
    response: HttpResponse,
    result: Record<string, any>,
    defaultMessage: string,
  ): string {
    const message = result.msg || result.message;
    if (message) return String(message);
    const code = result.code;
    if (code !== null && code !== undefined) {
      return `${defaultMessage} (HTTP ${response.statusCode}, code=${code})`;
    }
    return `${defaultMessage} (HTTP ${response.statusCode})`;
  }

  async generateInitCookies(options: { completeSecurity?: boolean } = {}): Promise<Record<string, string>> {
    const completeSecurity = options.completeSecurity ?? true;
    // The browser loads the document before the login JS creates its
    // cross-subdomain Cookie fields. Host-only navigation Cookies such as
    // acw_tc must not be flattened into the shared Creator Cookie map.
    const navigationHeaders = buildCreatorNavigationHeaders({
      "upgrade-insecure-requests": "1",
      "user-agent": CREATOR_USER_AGENT,
      "sec-ch-ua": CREATOR_SEC_CH_UA,
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"',
      accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9," +
        "image/avif,image/webp,image/apng,*/*;q=0.8," +
        "application/signed-exchange;v=b3;q=0.7",
      "accept-language": CREATOR_LOGIN_ACCEPT_LANGUAGE,
      priority: "u=0, i",
      "sec-fetch-dest": "document",
      "sec-fetch-mode": "navigate",
      "sec-fetch-site": "none",
      "sec-fetch-user": "?1",
    });
    const response = await this.http.get(`${this.creatorUrl}/login`, {
      headers: navigationHeaders,
      timeout: REQUEST_TIMEOUT_MS,
    });
    this._mergeResponseCookies(response);
    const ts = Date.now();
    const a1 = generateA1();
    const webId = generateWebId(a1);
    const cookies = {
      ets: String(ts),
      webBuild: CREATOR_WEB_BUILD,
      xsecappid: "ugc",
      loadts: String(ts + 50 + Math.floor(Math.random() * 151)),
      a1,
      webId,
    };
    this.profile.updateCookies(cookies);
    await this._bootstrapSecurity();
    if (completeSecurity) await this._completeSecurity();
    return this.profile.cookieMap;
  }

  /**
   * 请求 launcher 的无签名、尽力而为的 honeypot 程序。
   * launcher 会评估返回的程序并忽略评估错误，但不消费评估结果。浏览器抓包、
   * 逐字节一致的签名器夹具与服务端验收均显示无下游签名依赖，因此纯客户端
   * 复现该请求而不执行不透明程序。
   */
  private async _fetchHoneypot(): Promise<void> {
    const headers = getRequestHeadersTemplate(null, {
      method: "POST",
      includeClientHints: false,
      includeTraceHeaders: false,
      includeAuthorization: false,
      includeOrigin: true,
    });
    headers["accept-language"] = CREATOR_LOGIN_ACCEPT_LANGUAGE;
    const ordered = buildCreatorLoginHeaders(
      headers,
      this._cookiesForUrl(this.asUrl),
      { kind: "honeypot" },
    );
    const response = await this.http.post(`${this.asUrl}/api/p/pj`, {
      headers: ordered,
      data: Buffer.from('{"callFrom":"ugc"}', "utf-8"),
      timeout: REQUEST_TIMEOUT_MS,
    });
    this._mergeResponseCookies(response);
  }

  /** 启动浏览器的 MNS0201/nop 引导并保留 DS 程序。 */
  private async _bootstrapSecurity(): Promise<void> {
    if (this._securityStarted) return;

    await this._fetchHoneypot();

    // The DS request is the only signed MNS0201/nop request in the fresh
    // page11 capture. Its X-S-Common precedes both b1 and DSL readiness.
    const dsBody = {
      callFrom: "creator-platform",
      callback: "",
      type: "ds",
      appId: "ugc",
    };
    const [headers, cookies, body] = await this._signed(
      "/api/sec/v1/scripting", dsBody, "POST",
      { tier: "0201", b1Value: "", dslPairValue: "null;undefined", includeTraceHeaders: false },
    );
    headers["content-type"] = "application/json";
    const ordered = buildCreatorLoginHeaders(
      headers,
      this._cookiesForUrl(this.asUrl, cookies),
      { kind: "security" },
    );
    const dsResponse = await this.http.post(`${this.asUrl}/api/sec/v1/scripting`, {
      headers: ordered,
      data: Buffer.from(body, "utf-8"),
      timeout: REQUEST_TIMEOUT_MS,
    });
    this._mergeResponseCookies(dsResponse);

    let dsl = "";
    let dsCode = "";
    try {
      const dsJson = dsResponse.json<Record<string, any>>();
      const dataObj = dsJson.data;
      // 非对象 data（如字符串）在 Python 中会抛 AttributeError 走兜底路径，这里等价处理
      if (dataObj !== null && dataObj !== undefined && typeof dataObj === "object") {
        dsCode = String((dataObj as Record<string, unknown>).data ?? "");
      }
      const match = GETDSS_RE.exec(dsCode);
      if (match) dsl = match[1];
    } catch {
      // 解析失败（对齐 Python ValueError/AttributeError 兜底）
    }
    if (!dsl || !dsCode) {
      const [fallbackDsl, fallbackProgram] = await getDsBundle({ httpClient: this.http });
      if (!dsl) dsl = fallbackDsl;
      if (!dsCode) dsCode = fallbackProgram;
    }
    this._pendingDsl = dsl;
    this._pendingDsProgram = dsCode;
    // 浏览器原生时序：DS 响应到达即安装，zones/tgt/redcaptcha/sbtsource
    // 用 0101/a1。但 2026-07-25 实测：脚本客户端 tgt@0101 通过率仅 ~20%
    // （概率闸门针对 0101 档），tgt@0201 稳定 100%——这四条刻意走
    // 0201/nop 冷路径保可靠性，DS 推迟到 seccallback 前安装。
    this._securityStarted = true;
  }

  /** 在进入 mns0101/a1 阶段前安装服务端 DS 程序（对齐浏览器时序）。 */
  private async _activateSecurity(): Promise<void> {
    if (this.profile.session.securityReady) return;
    if (!this._pendingDsl || !this._pendingDsProgram) {
      const [dsl, program] = await getDsBundle({ httpClient: this.http });
      this._pendingDsl = this._pendingDsl || dsl;
      this._pendingDsProgram = this._pendingDsProgram || program;
    }
    this.profile.activateSecurity(
      this._pendingDsl,
      this._pendingDsProgram,
      { timestampMs: Date.now() },
    );
  }

  /** 以浏览器原生 mns0101/a1 login_early 档位运行 redcaptcha/sbtsource。 */
  private async _finishSecurityBootstrap(): Promise<void> {
    if (this._securityBootstrapped) return;
    if (!this._securityStarted) await this._bootstrapSecurity();

    // 浏览器原生是 0101/a1，但脚本客户端实测 0101 档通过率 ~20%、
    // 0201/nop 冷路径 ~100%（2026-07-25 五连发对照），刻意走 0201。
    // Redcaptcha carries trace headers but no empty authorization header.
    const [headers, cookies, body] = await this._signed(
      "/api/redcaptcha/v2/getconfig", {}, "POST",
      {
        includeTraceHeaders: true,
        includeAuthorization: false,
        tier: "0201",
        b1Value: "",
        dslPairValue: "null;undefined",
      },
    );
    const ordered = buildCreatorLoginHeaders(
      headers,
      this._cookiesForUrl(this.edithUrl, cookies),
      { kind: "redcaptcha" },
    );
    const response = await this._sendWithGateRetry(
      () => this.http.post(`${this.edithUrl}/api/redcaptcha/v2/getconfig`, {
        headers: ordered,
        data: Buffer.from(body, "utf-8"),
        timeout: REQUEST_TIMEOUT_MS,
      }),
      { label: "redcaptcha" },
    );
    this._mergeResponseCookies(response);

    const sbtBody = { callFrom: "creator-platform", appId: "ugc" };
    const [sbtHeaders, sbtCookies, sbtBodyText] = await this._signed(
      "/api/sec/v1/sbtsource", sbtBody, "POST",
      { tier: "0201", b1Value: "", dslPairValue: "null;undefined", includeTraceHeaders: false },
    );
    const orderedSbt = buildCreatorLoginHeaders(
      sbtHeaders,
      this._cookiesForUrl(this.asUrl, sbtCookies),
      { kind: "security" },
    );
    const sbtResponse = await this._sendWithGateRetry(
      () => this.http.post(`${this.asUrl}/api/sec/v1/sbtsource`, {
        headers: orderedSbt,
        data: Buffer.from(sbtBodyText, "utf-8"),
        timeout: REQUEST_TIMEOUT_MS,
      }),
      { label: "sbtsource" },
    );
    this._mergeResponseCookies(sbtResponse);
    this._securityBootstrapped = true;
  }

  /** 只执行一次 DS 就绪的 seccallback 与 webprofile 阶段。 */
  private async _completeSecurity(): Promise<void> {
    if (this._securityCompleted) return;
    if (!this._securityStarted) await this._bootstrapSecurity();
    if (!this._securityBootstrapped) await this._finishSecurityBootstrap();
    // sbtsource 之后安装 DS 程序（浏览器原生是 DS 响应后立即安装；此处为
    // 端到端已验证的冷路径时序），随后 seccallback/webprofile 切到
    // mns0101/a1（login_callback/login_ready）。
    await this._activateSecurity();
    if (!this.profile.session.securityReady) {
      throw new Error("Creator DS program was not activated after bootstrap");
    }
    await this._fetchWebsectiga();
    this._requireSecurityCookies(["websectiga", "sec_poison_id"]);
    await this._fetchGid();
    this._requireSecurityCookies();
    this._securityCompleted = true;
  }

  /** 在任何 CAS 登录调用前拒绝不完整的安全引导。 */
  private _requireSecurityCookies(names?: readonly string[]): void {
    const values = this.profile.cookieMap;
    const required = names ?? Object.keys(SECURITY_COOKIE_LENGTHS);
    const invalid: string[] = [];
    for (const name of required) {
      const value = String(values[name] ?? "");
      const expected = SECURITY_COOKIE_LENGTHS[name];
      if (value.length !== expected) {
        invalid.push(`${name}(length=${value.length}, expected=${expected})`);
      }
    }
    if (invalid.length) {
      throw new Error(`Creator security bootstrap incomplete: ${invalid.join(", ")}`);
    }
  }

  private async _fetchWebsectiga(): Promise<string> {
    const api = "/api/sec/v1/scripting";
    const data = { callFrom: "creator-platform", callback: "seccallback" };
    const [headers, cookies, body] = await this._signed(
      api,
      data,
      "POST",
      { tier: "0101", mnsProfile: "login_callback", b1Value: "", includeTraceHeaders: false },
    );
    headers["content-type"] = "application/json";
    const ordered = buildCreatorLoginHeaders(
      headers,
      this._cookiesForUrl(this.asUrl, cookies),
      { kind: "security" },
    );
    const response = await this.http.post(`${this.asUrl}${api}`, {
      headers: ordered,
      data: Buffer.from(body, "utf-8"),
      timeout: REQUEST_TIMEOUT_MS,
    });
    this._mergeResponseCookies(response);
    let result: Record<string, any>;
    try {
      result = response.json<Record<string, any>>();
    } catch {
      throw new Error(`Creator scripting response is not JSON (HTTP ${response.statusCode})`);
    }
    const dataObj = (result.data ?? {}) as Record<string, any>;
    const secPoisonId = dataObj.secPoisonId ?? dataObj.sec_poison_id;
    if (!secPoisonId) {
      throw new Error("Creator scripting response missing sec_poison_id");
    }
    const code = String(dataObj.data ?? "");
    if (!code) {
      throw new Error("Creator scripting response missing JSVMP program");
    }
    let websectiga: string;
    try {
      websectiga = await generateWebsectiga(
        code,
        {
          userAgent: CREATOR_USER_AGENT,
          platform: "Win32",
          pageUrl: `${this.creatorUrl}/login`,
        },
      );
    } catch (error) {
      throw new Error(
        `Creator websectiga local execution failed: ${(error as Error).message}`,
      );
    }
    this.profile.updateCookies({
      websectiga,
      sec_poison_id: String(secPoisonId),
    });
    return websectiga;
  }

  private async _fetchGid(): Promise<string | null> {
    const api = "/api/sec/v1/shield/webprofile";
    const profileData = generateCreatorProfileData(
      this.profile.profileDataOptions({
        location: `${this.creatorUrl}/login`,
        referer: `${this.creatorUrl}/login`,
      }),
    );
    const data = {
      platform: "Windows",
      sdkVersion: CREATOR_WEBPROFILE_SDK,
      svn: "2",
      profileData,
    };
    const [headers, cookies, body] = await this._signed(
      api,
      data,
      "POST",
      { tier: "0101", mnsProfile: "login_ready", b1Profile: "login", includeTraceHeaders: false },
    );
    headers["content-type"] = "application/json";
    const ordered = buildCreatorLoginHeaders(
      headers,
      this._cookiesForUrl(this.asUrl, cookies),
      { kind: "security" },
    );
    const response = await this.http.post(`${this.asUrl}${api}`, {
      headers: ordered,
      data: Buffer.from(body, "utf-8"),
      timeout: REQUEST_TIMEOUT_MS,
    });
    const values = this._mergeResponseCookies(response);
    const gid = values.gid;
    if (gid) {
      this.profile.session.profileCount += 1;
    }
    return gid;
  }

  async generateQrcode(
    cookies?: unknown,
    oldQrId?: unknown,
  ): Promise<[boolean, string, CreatorQrCodePayload | null]> {
    if (cookies) this.profile.updateCookies(cookies);
    this._requireSecurityCookies();
    const api = "/api/cas/customer/web/qr-code";
    const data: Record<string, unknown> = { service: this.creatorUrl };
    if (oldQrId) data.old_qr_id = String(oldQrId);
    const [headers, cookieMap, body] = await this._signed(
      api,
      data,
      "POST",
      { tier: "0101", mnsProfile: "login_ready", b1Profile: "login", includeTraceHeaders: false },
    );
    headers["content-type"] = "application/json";
    const ordered = buildCreatorLoginHeaders(
      headers,
      this._cookiesForUrl(this.customerUrl, cookieMap),
      { kind: "cas-post-no-rate" },
    );
    const response = await this.http.post(`${this.customerUrl}${api}`, {
      headers: ordered,
      data: Buffer.from(body, "utf-8"),
      timeout: REQUEST_TIMEOUT_MS,
    });
    this._debugDump("qr-code (POST, 0101/a1)", {
      requestHeaders: ordered,
      requestBody: body,
      response,
    });
    const values = this._mergeResponseCookies(response);
    const result = response.json<Record<string, any>>();
    if (!result.success) {
      return [false, this._responseMessage(response, result, "获取二维码失败"), null];
    }
    const dataObj = (result.data ?? {}) as Record<string, any>;
    if (!("id" in dataObj) || !("url" in dataObj)) {
      return [
        false,
        String(result.msg ?? "二维码响应缺少必要字段"),
        { cookies: values, res_json: result },
      ];
    }
    return [
      true,
      "成功",
      {
        cookies: values,
        qr_id: String(dataObj.id),
        qr_url: String(dataObj.url),
        support_channels: dataObj.support_qr_code_channel_infos ?? [],
      },
    ];
  }

  private async _buildZoneRequest(
    cookies?: unknown,
  ): Promise<[string, Record<string, string>]> {
    if (cookies) this.profile.updateCookies(cookies);
    const api = spliceStrCreator("/api/cas/customer/web/zones", {
      service: this.creatorUrl,
    });
    // 浏览器原生是 0101/a1，但脚本客户端实测 0101 档通过率 ~20%、
    // 0201/nop 冷路径 ~100%（2026-07-25 五连发对照），刻意走 0201。
    const [headers, cookieMap] = await this._signed(
      api,
      "",
      "GET",
      {
        includeOrigin: true,
        tier: "0201",
        b1Value: "",
        dslPairValue: "null;undefined",
        includeTraceHeaders: false,
      },
    );
    this._addServiceRatelimitHeader(headers);
    const ordered = buildCreatorLoginHeaders(
      headers,
      this._cookiesForUrl(this.customerUrl, cookieMap),
      { kind: "cas-get" },
    );
    return [api, ordered];
  }

  /**
   * 406 概率闸门的请求级重试：同会话换新签名重发。
   * 2026-07-25 实证：customer 域对 0101 档的 406 是按请求概率的
   * （tgt@0101 同会话第 4 发即 200），不是会话级标记——因此同会话
   * 重发有效，无需重建设备。
   */
  private async _sendWithGateRetry(
    sendOnce: () => Promise<HttpResponse>,
    options: { attempts?: number; label?: string } = {},
  ): Promise<HttpResponse> {
    const attempts = options.attempts ?? 5;
    const label = options.label ?? "";
    let response: HttpResponse | undefined;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      response = await sendOnce();
      if (response.statusCode !== 406) return response;
      console.debug(`${label} 406 概率拒绝，同会话重发 (${attempt}/${attempts})`);
    }
    return response!;
  }

  private async _sendZoneRequest(
    prepared: [string, Record<string, string>],
  ): Promise<[boolean, unknown[], Record<string, string>]> {
    const [api, headers] = prepared;
    const response = await this._sendWithGateRetry(
      () => this.http.get(`${this.customerUrl}${api}`, {
        headers,
        timeout: REQUEST_TIMEOUT_MS,
      }),
      { label: "zones" },
    );
    this._debugDump("zones (GET, 0201/nop)", { requestHeaders: headers, response });
    const values = this._mergeResponseCookies(response);
    const result = response.json<Record<string, any>>();
    return [Boolean(result.success), (result.data || []) as unknown[], values];
  }

  /** 加载国内短信区号列表（与登录组件行为一致）。 */
  async getZoneList(
    cookies?: unknown,
  ): Promise<[boolean, unknown[], Record<string, string>]> {
    return this._sendZoneRequest(await this._buildZoneRequest(cookies));
  }

  private async _buildSessionRequest(
    cookies?: unknown,
  ): Promise<[string, Record<string, string>, string]> {
    if (cookies) this.profile.updateCookies(cookies);
    const api = "/api/cas/customer/web/service-ticket";
    const data = { service: this.creatorUrl, source: "", type: "tgt" };
    // 浏览器原生是 0101/a1，但脚本客户端实测 0101 档通过率 ~20%、
    // 0201/nop 冷路径 ~100%（2026-07-25 五连发对照），刻意走 0201。
    const [headers, cookieMap, body] = await this._signed(
      api,
      data,
      "POST",
      { tier: "0201", b1Value: "", dslPairValue: "null;undefined", includeTraceHeaders: false },
    );
    this._addServiceRatelimitHeader(headers);
    const ordered = buildCreatorLoginHeaders(
      headers,
      this._cookiesForUrl(this.customerUrl, cookieMap),
      { kind: "cas-post" },
    );
    return [api, ordered, body];
  }

  private async _sendSessionRequest(
    prepared: [string, Record<string, string>, string],
  ): Promise<CreatorSessionDetail> {
    const [api, headers, body] = prepared;
    const response = await this._sendWithGateRetry(
      () => this.http.post(`${this.customerUrl}${api}`, {
        headers,
        data: Buffer.from(body, "utf-8"),
        timeout: REQUEST_TIMEOUT_MS,
      }),
      { label: "service-ticket" },
    );
    this._debugDump(
      "service-ticket type=tgt (POST, 0201/nop)",
      { requestHeaders: headers, requestBody: body, response },
    );
    const values = this._mergeResponseCookies(response);
    const result = response.json<Record<string, any>>();
    const dataObj = (result.data ?? {}) as Record<string, any>;
    const ticket = String(dataObj.ticket ?? "");
    const loginType = String(dataObj.type ?? "");
    return {
      active: Boolean(ticket || loginType === "at"),
      ticket,
      type: loginType,
      cookies: values,
      res_json: result,
    };
  }

  /** 运行浏览器的自动 ``type=tgt`` 会话探测。 */
  async querySession(cookies?: unknown): Promise<CreatorSessionDetail> {
    return this._sendSessionRequest(await this._buildSessionRequest(cookies));
  }

  async checkSession(cookies?: unknown): Promise<[boolean, Record<string, string>]> {
    const detail = await this.querySession(cookies);
    return [detail.active, detail.cookies];
  }

  /**
   * 校验用户提供的 Creator Cookie 并用安全状态丰富它。
   * 将用户 Cookie 合并进当前设备 profile（其 a1 生效），探测 CAS 会话
   * （type=tgt），为该身份完成安全引导，并要求在返回丰富后的 Cookie
   * 映射前通过 Creator 用户信息验收。
   */
  async exchangeCreatorSessionFromUserCookies(
    userCookies: unknown,
  ): Promise<[boolean, string, Record<string, unknown> | null]> {
    this.profile.updateCookies(userCookies);
    const session = await this.querySession();
    if (!session.active) {
      return [false, "creator session exchange failed", {
        cookies: this.profile.cookieMap,
        res_json: session.res_json,
      }];
    }
    try {
      await this._completeSecurity();
    } catch (error) {
      return [false, `creator session security bootstrap failed: ${(error as Error).message}`, {
        cookies: this.profile.cookieMap,
      }];
    }
    const [success, userInfo, values] = await this.getUserInfo();
    if (!success) {
      return [false, "creator session user-info acceptance failed", {
        cookies: values,
        res_json: userInfo,
      }];
    }
    return [true, "成功", { cookies: values, user_info: userInfo }];
  }

  /** 返回完整的 CAS 二维码状态（不丢弃 ticket 元数据）。 */
  async queryQrcodeStatus(
    qrId: string,
    cookies?: unknown,
  ): Promise<CreatorQrStatusDetail> {
    if (cookies) this.profile.updateCookies(cookies);
    const api = "/api/cas/customer/web/qr-code";
    const signedApi = spliceStrCreator(api, {
      service: this.creatorUrl,
      qr_code_id: qrId,
      source: "",
    });
    const [headers, cookieMap] = await this._signed(
      signedApi,
      "",
      "GET",
      {
        includeOrigin: true,
        tier: "0101",
        mnsProfile: "login_ready",
        b1Profile: "login",
        includeTraceHeaders: false,
      },
    );
    const ordered = buildCreatorLoginHeaders(
      headers,
      this._cookiesForUrl(this.customerUrl, cookieMap),
      { kind: "cas-get-no-rate" },
    );
    const response = await this.http.get(`${this.customerUrl}${signedApi}`, {
      headers: ordered,
      timeout: REQUEST_TIMEOUT_MS,
    });
    const values = this._mergeResponseCookies(response);
    const result = response.json<Record<string, any>>();
    const dataObj = (result.data ?? {}) as Record<string, any>;
    const status = (dataObj.status as number | null | undefined) ?? null;
    let message = QR_STATUS_MESSAGES[status as number] ?? `未知状态: ${status}`;
    if (status === null) {
      message = this._responseMessage(
        response,
        result,
        "二维码状态响应缺少 status",
      );
    }
    return {
      success: Boolean(result.success && status === QR_STATUS_SUCCESS),
      message,
      status,
      ticket: String(dataObj.ticket ?? ""),
      type: String(dataObj.type ?? ""),
      avatar: String(dataObj.avatar ?? ""),
      cookies: values,
      res_json: result,
    };
  }

  async checkQrcodeStatus(
    qrId: string,
    cookies?: unknown,
  ): Promise<[boolean, string, Record<string, string>]> {
    const detail = await this.queryQrcodeStatus(qrId, cookies);
    return [detail.success, detail.message, detail.cookies];
  }

  async getUserInfo(
    cookies?: unknown,
  ): Promise<[boolean, Record<string, unknown>, Record<string, string>]> {
    if (cookies) this.profile.updateCookies(cookies);
    const api = "/api/galaxy/user/info";
    const [headers, cookieMap] = await this._signed(
      api,
      "",
      "GET",
      {
        referer: `${this.creatorUrl}/login`,
        secFetchSite: "same-origin",
        includeTraceHeaders: true,
        includeOrigin: false,
        tier: "0101",
        mnsProfile: "login_ready",
        b1Profile: "login",
      },
    );
    headers["content-type"] = "application/json;charset=UTF-8";
    const ordered = buildCreatorLoginHeaders(
      headers,
      this._cookiesForUrl(this.creatorUrl, cookieMap),
      { kind: "login-user-info" },
    );
    const response = await this.http.get(`${this.creatorUrl}${api}`, {
      headers: ordered,
      timeout: REQUEST_TIMEOUT_MS,
    });
    const values = this._mergeResponseCookies(response);
    const result = response.json<Record<string, any>>();
    return [
      Boolean(result.success),
      (result.data || {}) as Record<string, unknown>,
      values,
    ];
  }

  async sendPhoneCode(
    phone: string,
    cookies?: unknown,
    zone = "86",
  ): Promise<[boolean, string, Record<string, unknown>]> {
    if (cookies) this.profile.updateCookies(cookies);
    this._requireSecurityCookies();
    const api = "/api/cas/customer/web/verify-code";
    // BeerLogin serializes this object in insertion order. The compact body
    // is also the signer input, so retain the browser's service/phone/zone
    // order instead of treating JSON object order as cosmetic.
    const data = { service: this.creatorUrl, phone, zone };
    const [headers, cookieMap, body] = await this._signed(
      api,
      data,
      "POST",
      { tier: "0101", mnsProfile: "login_ready", b1Profile: "login", includeTraceHeaders: false },
    );
    headers["content-type"] = "application/json";
    this._addServiceRatelimitHeader(headers);
    const ordered = buildCreatorLoginHeaders(
      headers,
      this._cookiesForUrl(this.customerUrl, cookieMap),
      { kind: "cas-post" },
    );
    const response = await this.http.post(`${this.customerUrl}${api}`, {
      headers: ordered,
      data: Buffer.from(body, "utf-8"),
      timeout: REQUEST_TIMEOUT_MS,
    });
    this._debugDump("verify-code (POST, 0101/a1)", {
      requestHeaders: ordered,
      requestBody: body,
      response,
    });
    this._mergeResponseCookies(response);
    const result = response.json<Record<string, any>>();
    const success = Boolean(result.success);
    let message = result.msg || result.message;
    if (!message) {
      message = success ? "成功" : this._responseMessage(response, result, "发送验证码失败");
    }
    return [success, String(message), result];
  }

  async loginByPhone(
    phone: string,
    code: string,
    cookies?: unknown,
    zone = "86",
  ): Promise<[boolean, string, Record<string, unknown> | null]> {
    if (cookies) this.profile.updateCookies(cookies);
    this._requireSecurityCookies();
    const api = "/api/cas/customer/web/service-ticket";
    const data = {
      zone,
      phone,
      verify_code: code,
      service: this.creatorUrl,
      source: "",
      type: "phoneVerifyCode",
    };
    const [headers, cookieMap, body] = await this._signed(
      api,
      data,
      "POST",
      { tier: "0101", mnsProfile: "login_ready", b1Profile: "login", includeTraceHeaders: false },
    );
    headers["content-type"] = "application/json";
    this._addServiceRatelimitHeader(headers);
    const ordered = buildCreatorLoginHeaders(
      headers,
      this._cookiesForUrl(this.customerUrl, cookieMap),
      { kind: "cas-post" },
    );
    const response = await this.http.post(`${this.customerUrl}${api}`, {
      headers: ordered,
      data: Buffer.from(body, "utf-8"),
      timeout: REQUEST_TIMEOUT_MS,
    });
    const values = this._mergeResponseCookies(response);
    const result = response.json<Record<string, any>>();
    const success = Boolean(result.success);
    let message = result.msg || result.message;
    if (!message) {
      message = success ? "成功" : this._responseMessage(response, result, "手机号登录失败");
    }
    return [success, String(message), { cookies: values, res_json: result }];
  }

  static cookiesToStr(cookies: unknown): string {
    return cookieHeader(cookies);
  }

  /**
   * 按浏览器顺序初始化，并经过自动 CAS 探测。
   * 请求顺序（2026-07-25 隔离登录页 CDP 抓包 + mns 签名解码，build 1.19.3）：
   *     honeypot(无签名) -> DS(0201/nop seq=1, envConst=1299) -> 立即安装 DS
   *     -> zones(0101/a1 login_early seq=2)
   *     -> service-ticket type=tgt(seq=3) -> redcaptcha(seq=4)
   *     -> sbtsource(seq=5)
   * 之后 seccallback(seq=6, login_callback 1321) /
   * webprofile(seq=7, login_ready 1338) / qr-code 全部为 0101/a1。
   * 0101 档的 406 为按请求概率（同会话重发可过），由 gate retry 兜底。
   */
  private async _prepareLoginSession(): Promise<[Record<string, string>, CreatorSessionDetail]> {
    const cookies = await this.generateInitCookies({ completeSecurity: false });
    // DS 安装后做 zones + type=tgt（0101/a1 login_early，浏览器原生）。
    // 先并发构建两条请求再发送，复现浏览器并发启动，并避免 zones 的边缘
    // acw_tc 泄漏进紧随其后的 type=tgt。
    const zoneRequest = await this._buildZoneRequest(cookies);
    const sessionRequest = await this._buildSessionRequest(cookies);
    try {
      await this._sendZoneRequest(zoneRequest);
    } catch (error) {
      // The browser falls back to its built-in zone list.
      console.debug(`Creator 区号列表加载失败，继续使用默认区号: ${(error as Error).message}`);
    }
    const session = await this._sendSessionRequest(sessionRequest);
    // zones/tgt 之后才做 redcaptcha + sbtsource（同为 0101/a1 login_early）。
    await this._finishSecurityBootstrap();
    return [this.profile.cookieMap, session];
  }

  /** 要求与页面相同的 Creator 用户信息验收。 */
  private async _acceptSession(cookies?: unknown): Promise<string | null> {
    const [success, userInfo, values] = await this.getUserInfo(cookies);
    if (!success) {
      console.error("Creator 用户信息验收失败，不能判定为登录成功");
      return null;
    }
    const info = userInfo as Record<string, unknown>;
    console.info(
      `用户: ${String(info.userName ?? "未知")} ` +
      `(RedID: ${String(info.redId ?? "未知")})`,
    );
    console.log("Creator 登录成功，Cookie 已通过返回值交给调用方");
    return XHSCreatorLoginApi.cookiesToStr(this._cookiesForUrl(this.creatorUrl, values));
  }

  /** 终端 ASCII 二维码（对应 Python qrcode.print_ascii；此处用 npm qrcode 终端输出） */
  static async showQrcodeTerminal(url: string): Promise<void> {
    const text = await QRCode.toString(url, { type: "terminal", small: true });
    console.log(text);
  }

  /** 弹出二维码图片（对应 Python qrcode.make_image().show()：写 PNG 到临时文件并打开） */
  static async showQrcodeImage(url: string): Promise<void> {
    const tmpPath = join(tmpdir(), `creator_qrcode_${Date.now()}.png`);
    await QRCode.toFile(tmpPath, url, { width: 400, margin: 4 });
    const [cmd, args] =
      process.platform === "win32"
        ? ["cmd", ["/c", "start", "", tmpPath]]
        : process.platform === "darwin"
          ? ["open", [tmpPath]]
          : ["xdg-open", [tmpPath]];
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.unref();
  }

  async qrcodeLogin(options: { showInTerminal?: boolean } = {}): Promise<string | null> {
    const showInTerminal = options.showInTerminal ?? true;
    let qrData: CreatorQrCodeResult | null = null;
    let failMessage = "";
    for (let attempt = 1; attempt <= LOGIN_SESSION_MAX_ATTEMPTS; attempt++) {
      console.info("[1/5] 正在初始化 Creator 4.3.6 匿名设备...");
      let cookies: Record<string, string>;
      const [initCookies, session] = await this._prepareLoginSession();
      cookies = initCookies;
      console.debug(`初始 Cookie 字段: ${Object.keys(cookies).join(", ")}`);

      console.info("[2/5] 正在检查已有 Creator 会话...");
      if (session.active) {
        console.info("检测到可复用的 Creator 会话，跳过二维码");
        const accepted = await this._acceptSession(cookies);
        await this._completeSecurity();
        if (!accepted) return null;
        return XHSCreatorLoginApi.cookiesToStr(this._cookiesForUrl(this.creatorUrl));
      }

      await this._completeSecurity();
      cookies = this.profile.cookieMap;
      console.info("[3/5] 正在获取二维码...");
      const [success, message, payload] = await this.generateQrcode(cookies);
      if (success) {
        qrData = payload as CreatorQrCodeResult;
        break;
      }
      // 406 是按设备会话标记的概率闸门：同会话重发无效，整包重建后再试
      failMessage = message;
      console.warn(
        `当前设备会话被边缘拒绝（${message}），` +
        `重建匿名设备重试 (${attempt}/${LOGIN_SESSION_MAX_ATTEMPTS})`,
      );
      this._resetAnonymousSession();
    }
    if (!qrData) {
      console.error(`获取二维码失败: ${failMessage}`);
      return null;
    }
    console.info("请使用小红书APP扫描以下二维码:");
    if (showInTerminal) {
      await XHSCreatorLoginApi.showQrcodeTerminal(qrData.qr_url);
    } else {
      await XHSCreatorLoginApi.showQrcodeImage(qrData.qr_url);
    }

    console.info("[4/5] 等待扫码和手机确认...");
    let lastStatus: number | null | undefined;
    let detail: CreatorQrStatusDetail | null = null;
    while (true) {
      // Production BeerLogin schedules the first and subsequent polls
      // one second after the previous poll completes.
      await sleep(1000);
      detail = await this.queryQrcodeStatus(qrData.qr_id);
      const status = detail.status;
      if (status !== lastStatus) {
        console.info(detail.message);
        lastStatus = status;
      }
      if (detail.success) break;
      if (status === QR_STATUS_ERROR || status === QR_STATUS_EXPIRED || status === null) {
        console.error(detail.message);
        return null;
      }
      if (status !== QR_STATUS_WAIT_SCAN && status !== QR_STATUS_WAIT_CONFIRM) {
        console.error(detail.message);
        return null;
      }
    }

    console.info("[5/5] 验证正式 Creator 会话...");
    return this._acceptSession(detail?.cookies);
  }

  async phoneLogin(): Promise<string | null> {
    let phone = "";
    let failMessage = "";
    let sentOk = false;
    for (let attempt = 1; attempt <= LOGIN_SESSION_MAX_ATTEMPTS; attempt++) {
      console.info("[1/5] 正在初始化 Creator 4.3.6 匿名设备...");
      let cookies: Record<string, string>;
      const [initCookies, session] = await this._prepareLoginSession();
      cookies = initCookies;
      console.debug(`初始 Cookie 字段: ${Object.keys(cookies).join(", ")}`);

      console.info("[2/5] 正在检查已有 Creator 会话...");
      if (session.active) {
        console.info("检测到可复用的 Creator 会话，跳过短信验证");
        const accepted = await this._acceptSession(cookies);
        await this._completeSecurity();
        if (!accepted) return null;
        return XHSCreatorLoginApi.cookiesToStr(this._cookiesForUrl(this.creatorUrl));
      }

      await this._completeSecurity();
      cookies = this.profile.cookieMap;
      if (attempt === 1) {
        phone = await readLine("请输入手机号: ");
      }
      console.info("[3/5] 正在发送验证码...");
      const [success, message] = await this.sendPhoneCode(phone, cookies);
      if (success) {
        sentOk = true;
        break;
      }
      // 与 qr-code 相同的按会话概率闸门：整包重建后再发
      failMessage = message;
      console.warn(
        `当前设备会话被边缘拒绝（${message}），` +
        `重建匿名设备重试 (${attempt}/${LOGIN_SESSION_MAX_ATTEMPTS})`,
      );
      this._resetAnonymousSession();
    }
    if (!sentOk) {
      console.error(`发送失败: ${failMessage}`);
      return null;
    }
    console.info("验证码已发送");

    const code = await readLine("请输入验证码: ");
    console.info("[4/5] 正在验证...");
    const [success, message, result] = await this.loginByPhone(phone, code);
    if (!success) {
      console.error(`验证失败: ${message}`);
      return null;
    }

    console.info("[5/5] 验证正式 Creator 会话...");
    return this._acceptSession(result?.cookies);
  }
}
