/**
 * XHS PC 端登录 API 客户端（纯 HTTP 实现，对应原版
 * H:\project\XHS_ALL_IN_ONE\apis\xhs_pc_login_apis.py 的 XHSLoginApi 类，逐逻辑平移）
 *
 * 与 Python 版的关键差异（均为受 SDK 形态约束的适配，签名/请求流程完全一致）：
 * - get_dsl / generate_websectiga 在 SDK 中为异步（websectiga 为子进程执行），
 *   调用处均改为 await 并保持原流程顺序；因此涉及签名的整条调用链均为 async。
 * - allow_redirects=False：TS 传输层（curl-impersonate 后端不带 -L）默认即不跟随
 *   重定向，语义与 Python 一致，无需显式传参。
 * - loguru 日志改用极简 console 日志器（success 级别映射到 info）。
 * - input() 改用 node:readline/promises 的 createInterface 异步读取。
 * - show_qrcode_terminal / show_qrcode_image 改用 npm `qrcode` 包：
 *   terminal 模式等价打印 ASCII 二维码；原版 img.show() 打开系统图片查看器，
 *   Node 服务端无图形界面，改为输出 data URL 供调用方展示。
 *
 * SDK 补充清单（见对应文件头注释）：
 * - pc/state.ts：补充导出 REFERENCE_PROFILE（对应原版 state.py __all__）。
 */
import { createInterface } from "node:readline/promises";
import QRCode from "qrcode";
import { PC_PLATFORM_CONFIG } from "../core/auth";
import { HostCookieStore } from "../core/cookies";
import type { HttpResponse } from "../core/http";
import { generatePcProfileData, generateWebsectiga } from "../core/runtime";
import { generateA1, generateWebId } from "../core/util";
import { getDsl } from "./dsl";
import { PcHttpClient } from "./http";
import {
  PC_LOGIN_ACCEPT_LANGUAGE,
  PC_SEC_CH_UA,
  buildPcLoginHeaders,
  buildPcNavigationHeaders,
  generateRequestParams,
  getCommonHeaders,
  spliceStr,
} from "./params";
import {
  REFERENCE_PROFILE,
  PcDeviceProfile,
  initialPcCookies,
  cookieHeader,
  type B1RuntimeState,
} from "./state";

/** 请求超时（毫秒，对应原版 REQUEST_TIMEOUT = 15s） */
export const REQUEST_TIMEOUT_MS = 15 * 1000;

/** 匹配 DS 脚本中的 getdss() 返回数值（对应原版 _GETDSS_RE） */
const GETDSS_RE = /function\s+getdss\s*\(\s*\)\s*\{\s*return\s+'(\d+)'/;

/** 极简日志器（对应原版 loguru；TS 无 success 级别，映射到 info） */
const logger = {
  info: (message: string) => console.log(`[xhs-login] ${message}`),
  debug: (message: string) => console.debug(`[xhs-login] ${message}`),
  error: (message: string) => console.error(`[xhs-login] ${message}`),
  success: (message: string) => console.log(`[xhs-login] ${message}`),
};

/** 等待指定秒数（对应 time.sleep） */
function sleep(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

/** 从标准输入读取一行（对应 input()） */
async function promptInput(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

/** 二维码创建成功结果（对应原版返回 dict） */
export interface QrCreateResult {
  cookies: Record<string, string>;
  qr_id: string;
  code: string;
  qr_url: string;
}

/** 二维码创建部分失败结果（响应缺少必要字段时返回） */
export interface QrCreatePartialResult {
  cookies: Record<string, string>;
  res_json: Record<string, unknown>;
}

/** 短信登录结果（对应原版返回 dict） */
export interface PhoneLoginResult {
  cookies: Record<string, string>;
  res_json?: Record<string, unknown>;
}

/** XHSLoginApi 构造选项（对应原版关键字参数） */
export interface XHSLoginApiOptions {
  b1?: string;
  dsl?: string;
  localStorage?: Record<string, unknown> | null;
  sessionStorage?: Record<string, unknown> | null;
  b1State?: B1RuntimeState | null;
  webBuild?: string;
  mnsEnv?: Record<string, { envConst: number; envFpTailHex?: string; envFpTail?: unknown; evidence?: string }> | null;
  rapFingerprintHex?: string;
  webProfileFields?: Record<string, unknown> | null;
  webProfileI12Seed?: number | null;
  webProfileFi?: number | null;
  httpClient?: PcHttpClient | null;
}

/**
 * 纯 HTTP PC 登录客户端（对应原版 XHSLoginApi）。
 *
 * 本地生成请求签名并纯计算 profileData，不启动/附加浏览器，
 * 不执行原始指纹 SDK。登录仍需用户扫描返回的二维码或输入短信验证码。
 */
export class XHSLoginApi {
  private readonly platformConfig = PC_PLATFORM_CONFIG;
  private readonly baseUrl = PC_PLATFORM_CONFIG.origin("api");
  private readonly asUrl = PC_PLATFORM_CONFIG.origin("security");
  private readonly webUrl = PC_PLATFORM_CONFIG.origin("web");
  private readonly semUrl = PC_PLATFORM_CONFIG.origin("sem");
  private readonly homeUrl = PC_PLATFORM_CONFIG.origin("web") + "/explore";
  profile: PcDeviceProfile | null = null;
  proxies: Record<string, string> | null;
  http: PcHttpClient;
  fixedB1: string;
  dsl: string;
  localStorage: Record<string, unknown>;
  sessionStorage: Record<string, unknown>;
  b1State: B1RuntimeState | null;
  webBuild: string;
  mnsEnv: Record<string, { envConst: number; envFpTailHex?: string; envFpTail?: unknown; evidence?: string }>;
  rapFingerprintHex: string;
  profileData = "";
  webProfileFields: Record<string, unknown>;
  webProfileI12Seed: number | null;
  webProfileFi: number | null;
  private _webprofileReported = false;
  private _loginB1 = "";
  private readonly _cookieStore = new HostCookieStore();

  constructor(
    proxies: Record<string, string> | null = null,
    options: XHSLoginApiOptions = {},
  ) {
    this.proxies = proxies;
    this.http = options.httpClient ?? new PcHttpClient({ proxies: proxies ?? null });
    this.fixedB1 = String(options.b1 ?? "");
    this.dsl = String(options.dsl ?? "");
    this.localStorage = { ...(options.localStorage ?? {}) };
    this.sessionStorage = { ...(options.sessionStorage ?? {}) };
    this.b1State = options.b1State ?? null;
    this.webBuild = String(options.webBuild ?? "");
    this.mnsEnv = { ...(options.mnsEnv ?? {}) };
    this.rapFingerprintHex = String(options.rapFingerprintHex ?? "");
    this.webProfileFields = { ...(options.webProfileFields ?? {}) };
    this.webProfileI12Seed = options.webProfileI12Seed ?? null;
    this.webProfileFi = options.webProfileFi ?? null;
  }

  close(): void {
    this.http.close();
  }

  /** 构建 PcDeviceProfile（注入 mns_env 覆盖，对应 _new_profile） */
  private _newProfile(cookies: Record<string, string>): PcDeviceProfile {
    const profile = new PcDeviceProfile({
      cookies,
      localStorage: this.localStorage,
      sessionStorage: this.sessionStorage,
      fixedB1: this.fixedB1,
      webBuild: this.webBuild,
      b1State: this.b1State,
      rapFingerprintHex: this.rapFingerprintHex,
      webProfileFields: this.webProfileFields,
      webProfileI12Seed: this.webProfileI12Seed,
      webProfileFi: this.webProfileFi,
      source: "pc-login",
    });
    for (const [tier, material] of Object.entries(this.mnsEnv)) {
      profile.setMnsStage(tier, {
        envConst: Number(material.envConst),
        envFpTail: material.envFpTailHex ?? material.envFpTail,
        evidence: String(material.evidence ?? "XHSLoginApi override"),
      });
    }
    return profile;
  }

  /** 安全域基础请求头（对应 _get_sec_headers） */
  private static _getSecHeaders(
    signContext: Record<string, unknown> | null = null,
    method = "POST",
  ): Record<string, string> {
    const context = signContext ?? {};
    const headers: Record<string, string> = {
      "sec-ch-ua-platform": '"Windows"',
      referer: "https://www.xiaohongshu.com/",
      "sec-ch-ua": String(context.secChUa ?? PC_SEC_CH_UA),
      "sec-ch-ua-mobile": "?0",
      "user-agent": String(context.userAgent ?? REFERENCE_PROFILE.release.userAgent),
      accept: "application/json, text/plain, */*",
      "accept-language": PC_LOGIN_ACCEPT_LANGUAGE,
      origin: "https://www.xiaohongshu.com",
      priority: "u=1, i",
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-site",
    };
    if (String(method).toUpperCase() !== "GET") {
      headers["content-type"] = "application/json;charset=UTF-8";
    }
    return headers;
  }

  /** 按 host 隔离的 Cookie 快照（对应 host_cookies_snapshot） */
  hostCookiesSnapshot(): Record<string, Record<string, string>> {
    return this._cookieStore.snapshot();
  }

  /** Cookie 存储完整状态（对应 host_cookie_state） */
  hostCookieState(): Record<string, unknown> {
    return this._cookieStore.exportState();
  }

  private _cookiesForUrl(url: string, cookies: Record<string, string> | null = null): Record<string, string> {
    return this._cookieStore.cookiesForUrl(url, cookies ?? this.profile!.cookieMap);
  }

  private _ensureProfile(cookies: Record<string, string>): PcDeviceProfile {
    if (this.profile === null) {
      this.profile = this._newProfile(cookies);
    } else {
      this.profile.updateCookies(cookies);
    }
    return this.profile;
  }

  /**
   * 用同一 PcDeviceProfile 为登录全链生成 MNS/X-S-Common（对应 _signed_request_params）。
   *
   * 当前浏览器在 webprofile collector 启动前仍发送 X-S-Common，但 x8 是空字符串；
   * webprofile 请求首次生成并缓存登录页 b1，后续验证码/二维码请求复用该值。
   */
  private async _signedRequestParams(
    cookies: Record<string, string>,
    api: string,
    data: unknown = "",
    method = "POST",
    options: {
      secDomain?: boolean;
      tier?: string | null;
      includeTraceHeaders?: boolean;
      includeB1?: boolean | null;
    } = {},
  ): Promise<[Record<string, string>, unknown]> {
    const { secDomain = false, tier = null, includeTraceHeaders = true, includeB1 = null } = options;
    const profile = this._ensureProfile(cookies);
    const signContext = profile.nextSignContext(api, { tier: tier ?? null });
    let resolvedIncludeB1 = includeB1;
    if (resolvedIncludeB1 === null) {
      resolvedIncludeB1 = Boolean(this._loginB1 || this._webprofileReported);
    }
    if (resolvedIncludeB1 && !this._loginB1) {
      this._loginB1 = profile.currentB1(signContext.now as number, "login");
    }
    const b1 = resolvedIncludeB1 ? this._loginB1 : "";
    if (!this.dsl) {
      this.dsl = await getDsl({ httpClient: this.http });
    }
    let dslPair: string;
    if (profile.session.lastTigaUpdateTime) {
      dslPair = profile.dslPair(this.dsl, { timestampMs: signContext.now as number });
    } else {
      // 浏览器冷链：_dsl 可用而 dsllt 在 seccallback 安装当前 tiga 程序前保持 null
      dslPair = `null;${this.dsl}`;
    }
    const [headers, , body] = generateRequestParams(cookieHeader(cookies), api, data, method, {
      b1,
      dslPair,
      docCookie: profile.documentCookie,
      tier: signContext.tier as string,
      signContext,
    });
    headers["accept-language"] = PC_LOGIN_ACCEPT_LANGUAGE;
    if (secDomain) {
      const names = ["x-s", "x-t", "x-s-common"];
      if (includeTraceHeaders) {
        names.push("x-b3-traceid", "x-xray-traceid");
      }
      const signedHeaders: Record<string, string> = {};
      for (const name of names) {
        signedHeaders[name] = headers[name];
      }
      const secHeaders = XHSLoginApi._getSecHeaders(signContext, method);
      Object.assign(secHeaders, signedHeaders);
      return [secHeaders, body];
    }
    return [headers, body];
  }

  private _mergeResponseCookies(
    cookies: Record<string, string>,
    response: HttpResponse,
    appendShared: Iterable<string> = [],
  ): void {
    this._cookieStore.mergeResponse(cookies, response, appendShared);
    this._ensureProfile(cookies);
  }

  /** 执行 sec scripting（对应 _post_scripting） */
  private async _postScripting(
    cookies: Record<string, string>,
    payload: Record<string, unknown>,
    tier: string,
  ): Promise<Record<string, any>> {
    const api = "/api/sec/v1/scripting";
    const [headers, dataStr] = await this._signedRequestParams(cookies, api, payload, "POST", {
      secDomain: true,
      tier,
      includeTraceHeaders: false,
    });
    const wireCookies = this._cookiesForUrl(this.asUrl, cookies);
    const wireHeaders = buildPcLoginHeaders(headers, wireCookies, { kind: "security" });
    const resp = await this.http.post(this.asUrl + api, {
      headers: wireHeaders,
      data: Buffer.from(String(dataStr), "utf-8"),
      proxies: this.proxies,
      timeout: REQUEST_TIMEOUT_MS,
    });
    this._mergeResponseCookies(cookies, resp);
    const res = resp.json<Record<string, any>>();
    const ok = resp.statusCode < 400;
    if (!ok || !res.success) {
      throw new Error(res.msg ?? `scripting HTTP ${resp.statusCode}`);
    }
    return res;
  }

  /** 蜜罐请求（对应 _fetch_honeypot） */
  private async _fetchHoneypot(cookies: Record<string, string>): Promise<void> {
    const api = "/api/p/pj";
    const headers: Record<string, string> = {
      "sec-ch-ua-platform": '"Windows"',
      referer: this.webUrl + "/",
      "user-agent": REFERENCE_PROFILE.release.userAgent,
      accept: "application/json, text/plain, */*",
      "sec-ch-ua": REFERENCE_PROFILE.release.secChUa,
      "content-type": "application/json;charset=UTF-8",
      "sec-ch-ua-mobile": "?0",
      "accept-language": PC_LOGIN_ACCEPT_LANGUAGE,
      origin: this.webUrl,
      priority: "u=1, i",
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-site",
    };
    const wireHeaders = buildPcLoginHeaders(headers, this._cookiesForUrl(this.asUrl, cookies), { kind: "honeypot" });
    const response = await this.http.post(this.asUrl + api, {
      headers: wireHeaders,
      data: Buffer.from('{"callFrom":"xhs-pc-web"}', "utf-8"),
      proxies: this.proxies,
      timeout: REQUEST_TIMEOUT_MS,
    });
    this._mergeResponseCookies(cookies, response);
  }

  /** 红验证码配置请求（对应 _fetch_redcaptcha） */
  private async _fetchRedcaptcha(cookies: Record<string, string>): Promise<void> {
    const api = "/api/redcaptcha/v2/getconfig";
    const [headers, body] = await this._signedRequestParams(cookies, api, {}, "POST", {
      secDomain: true,
      tier: "0201",
      includeTraceHeaders: true,
    });
    const wireHeaders = buildPcLoginHeaders(headers, this._cookiesForUrl(this.baseUrl, cookies), { kind: "post" });
    const response = await this.http.post(this.baseUrl + api, {
      headers: wireHeaders,
      data: Buffer.from(String(body), "utf-8"),
      proxies: this.proxies,
      timeout: REQUEST_TIMEOUT_MS,
    });
    this._mergeResponseCookies(cookies, response);
  }

  /** sem_sdk 请求（对应 _fetch_sem_sdk） */
  private async _fetchSemSdk(cookies: Record<string, string>): Promise<void> {
    const api = "/data/sem_sdk";
    const [headers] = await this._signedRequestParams(cookies, api, "", "GET", {
      secDomain: true,
      tier: "0201",
      includeTraceHeaders: false,
    });
    const wireHeaders = buildPcLoginHeaders(headers, null, { kind: "sem" });
    const response = await this.http.get(this.semUrl + api, {
      headers: wireHeaders,
      proxies: this.proxies,
      timeout: REQUEST_TIMEOUT_MS,
    });
    this._mergeResponseCookies(cookies, response);
  }

  /** sbtsource 请求（对应 _fetch_sbtsource） */
  private async _fetchSbtsource(cookies: Record<string, string>): Promise<void> {
    const api = "/api/sec/v1/sbtsource";
    const payload = { callFrom: "web", appId: "xhs-pc-web" };
    const [headers, body] = await this._signedRequestParams(cookies, api, payload, "POST", {
      secDomain: true,
      tier: "0201",
      includeTraceHeaders: false,
    });
    const wireHeaders = buildPcLoginHeaders(headers, this._cookiesForUrl(this.asUrl, cookies), { kind: "security" });
    const response = await this.http.post(this.asUrl + api, {
      headers: wireHeaders,
      data: Buffer.from(String(body), "utf-8"),
      proxies: this.proxies,
      timeout: REQUEST_TIMEOUT_MS,
    });
    this._mergeResponseCookies(cookies, response);
  }

  /** 按浏览器顺序执行两个冷启动安全程序（对应 _initialize_security） */
  private async _initializeSecurity(cookies: Record<string, string>): Promise<void> {
    if (!this.dsl) {
      this.dsl = await getDsl({ httpClient: this.http });
    }

    await this._fetchHoneypot(cookies);
    await this._fetchRedcaptcha(cookies);
    await this._fetchSemSdk(cookies);

    const dsRes = await this._postScripting(
      cookies,
      { callFrom: "web", callback: "", type: "ds", appId: "xhs-pc-web" },
      "0201",
    );
    const dsCode = String(((dsRes.data as Record<string, unknown> | null) ?? {}).data ?? "");
    const match = GETDSS_RE.exec(dsCode);
    if (!match) {
      throw new Error("DS scripting response is empty or missing getdss()");
    }
    // 浏览器执行 DS 程序时会把该 getdss() 值写入 window._dsl，签名器只消费该显式值
    this.dsl = match[1];

    await this._fetchSbtsource(cookies);

    const secRes = await this._postScripting(cookies, { callFrom: "web", callback: "seccallback" }, "0101");
    const responseData = (secRes.data as Record<string, unknown> | null) ?? {};
    const secPoisonId = String(responseData.secPoisonId ?? "");
    const scriptingCode = String(responseData.data ?? "");
    if (!secPoisonId || scriptingCode.length < 1000) {
      throw new Error("seccallback response is missing secPoisonId or program data");
    }

    const websectiga = await generateWebsectiga(scriptingCode, {
      userAgent: REFERENCE_PROFILE.release.userAgent,
      platform: "Win32",
      pageUrl: this.homeUrl,
    });
    cookies.websectiga = websectiga;
    cookies.sec_poison_id = secPoisonId;
    const profile = this.profile!;
    profile.updateCookies(cookies);
    const tigaTime = profile.markTigaUpdated();
    profile.session.dsllt = tigaTime;
    // 解码 X-s 确认的浏览器转换：seccallback 为 0101；
    // activate、二维码、轮询与 webprofile 立即切换至 0301
    profile.markFingerprintReady(true);
  }

  /** 创建两种登录流程所需的匿名访客会话（对应 _activate） */
  private async _activate(cookies: Record<string, string>): Promise<Record<string, unknown>> {
    const api = "/api/sns/web/v1/login/activate";
    const [headers, body] = await this._signedRequestParams(cookies, api, {}, "POST", { tier: "0301" });
    const wireHeaders = buildPcLoginHeaders(headers, this._cookiesForUrl(this.baseUrl, cookies), { kind: "post" });
    const resp = await this.http.post(this.baseUrl + api, {
      headers: wireHeaders,
      data: String(body),
      proxies: this.proxies,
      timeout: REQUEST_TIMEOUT_MS,
    });
    this._mergeResponseCookies(cookies, resp);
    const res = resp.json<Record<string, any>>();
    const data = (res.data as Record<string, unknown> | null) ?? {};
    const ok = resp.statusCode < 400;
    if (!ok || !res.success) {
      throw new Error(res.msg ?? `login/activate HTTP ${resp.statusCode}`);
    }
    const visitorSession = String(data.session ?? "");
    if (visitorSession) {
      cookies.web_session = visitorSession;
      this.profile!.updateCookies(cookies);
    }
    if (!cookies.web_session) {
      throw new Error("login/activate did not issue visitor web_session");
    }
    return data;
  }

  /** 上报匿名 profileData 并取回 gid（对应 _fetch_gid） */
  private async _fetchGid(cookies: Record<string, string>): Promise<string | null> {
    if (this._webprofileReported && cookies.gid) {
      return cookies.gid;
    }
    const api = "/api/sec/v1/shield/webprofile";
    if (!this.profileData) {
      const options = this.profile!.profileDataOptions();
      this.profileData = generatePcProfileData({
        fields: options.fields as Record<string, unknown> | undefined,
        timestampMs: options.timestamp_ms as number | undefined,
        ets: options.ets as number | undefined,
        documentCookie: options.document_cookie as string | undefined,
        timeOrigin: options.time_origin as number | undefined,
        i12Seed: options.i12_seed as number | undefined,
        telemetryFi: options.telemetry_fi as number | undefined,
      });
    }
    const data = {
      platform: "Windows",
      sdkVersion: REFERENCE_PROFILE.release.webProfileSdkVersion,
      svn: "2",
      profileData: this.profileData,
    };

    const [headers, dataStr] = await this._signedRequestParams(cookies, api, data, "POST", {
      secDomain: true,
      tier: "0301",
      includeTraceHeaders: false,
      includeB1: true,
    });
    const wireHeaders = buildPcLoginHeaders(headers, this._cookiesForUrl(this.asUrl, cookies), { kind: "security" });
    try {
      const resp = await this.http.post(this.asUrl + api, {
        headers: wireHeaders,
        data: Buffer.from(String(dataStr), "utf-8"),
        proxies: this.proxies,
        timeout: REQUEST_TIMEOUT_MS,
      });
      this._mergeResponseCookies(cookies, resp);
      const res = resp.json<Record<string, any>>();
      const ok = resp.statusCode < 400;
      if (ok && (res.success === true || Number(res.code) === 0)) {
        const gid = cookies.gid;
        if (!gid) {
          return null;
        }
        this.profile!.markProfileReported();
        this._webprofileReported = true;
        return gid;
      }
      return null;
    } catch (error) {
      logger.debug(`fetch gid failed: ${(error as Error).message}`);
      return null;
    }
  }

  /** 两次首页导航，取回 abRequestId（对应 _initialize_navigation） */
  private async _initializeNavigation(cookies: Record<string, string>): Promise<void> {
    let headers = buildPcNavigationHeaders(getCommonHeaders());
    const first = await this.http.get(this.webUrl + "/", {
      headers,
      proxies: this.proxies,
      timeout: REQUEST_TIMEOUT_MS,
    });
    this._mergeResponseCookies(cookies, first);

    headers = buildPcNavigationHeaders(getCommonHeaders(), this._cookiesForUrl(this.webUrl, cookies));
    const second = await this.http.get(this.homeUrl, {
      headers,
      proxies: this.proxies,
      timeout: REQUEST_TIMEOUT_MS,
    });
    this._mergeResponseCookies(cookies, second);
    if (!cookies.abRequestId) {
      throw new Error("initial www navigation did not issue abRequestId");
    }
  }

  /** 生成匿名初始化 Cookie（对应 generate_init_cookies） */
  async generateInitCookies(): Promise<Record<string, string>> {
    const navigationCookies: Record<string, string> = {};
    this.profile = this._newProfile(navigationCookies);
    await this._initializeNavigation(navigationCookies);
    const ts = Date.now();
    const a1 = generateA1();
    const webId = generateWebId(a1);
    const cookies = initialPcCookies(a1, webId, {
      abRequestId: navigationCookies.abRequestId,
      timestampMs: ts,
      loadtsMs: ts + 50 + Math.floor(Math.random() * 151),
      webBuild: this.webBuild || undefined,
    });
    this.profile = this._newProfile(cookies);
    this.profileData = "";
    this._webprofileReported = false;
    this._loginB1 = "";
    await this._initializeSecurity(cookies);
    await this._activate(cookies);
    return cookies;
  }

  /** 在用户认证前生成/上报匿名 profileData（对应 ensure_webprofile） */
  async ensureWebprofile(cookies: Record<string, string>): Promise<string> {
    const gid = await this._fetchGid(cookies);
    if (!gid) {
      throw new Error("webprofile succeeded without issuing gid");
    }
    cookies.gid = gid;
    this.profile!.updateCookies(cookies);
    return gid;
  }

  /** 创建登录二维码（对应 generate_qrcode） */
  async generateQrcode(
    cookies: Record<string, string>,
  ): Promise<[boolean, string, QrCreateResult | QrCreatePartialResult | null]> {
    const api = "/api/sns/web/v1/login/qrcode/create";
    const data = { qr_type: 1 };

    const [headers, body] = await this._signedRequestParams(cookies, api, data);
    const wireHeaders = buildPcLoginHeaders(headers, this._cookiesForUrl(this.baseUrl, cookies), { kind: "post" });
    const resp = await this.http.post(this.baseUrl + api, {
      headers: wireHeaders,
      data: String(body),
      proxies: this.proxies,
      timeout: REQUEST_TIMEOUT_MS,
    });
    this._mergeResponseCookies(cookies, resp);

    const res = resp.json<Record<string, any>>();
    if (!res.success) {
      return [false, String(res.msg ?? "未知错误"), null];
    }
    const resultData = (res.data as Record<string, unknown> | null) ?? {};
    if (!("qr_id" in resultData && "code" in resultData && "url" in resultData)) {
      return [false, String(res.msg ?? "二维码响应缺少必要字段"), { cookies, res_json: res }];
    }

    return [
      true,
      "成功",
      { cookies, qr_id: String(resultData.qr_id), code: String(resultData.code), qr_url: String(resultData.url) },
    ];
  }

  /** 轮询二维码状态（对应 check_qrcode_status） */
  async checkQrcodeStatus(
    qrId: string,
    code: string,
    cookies: Record<string, string>,
  ): Promise<[boolean, string, Record<string, string>]> {
    const api = "/api/qrcode/userinfo";
    const data = { qrId, code };

    const [headers, body] = await this._signedRequestParams(cookies, api, data);
    const wireHeaders = buildPcLoginHeaders(headers, this._cookiesForUrl(this.baseUrl, cookies), { kind: "post" });
    const resp = await this.http.post(this.baseUrl + api, {
      headers: wireHeaders,
      data: String(body),
      proxies: this.proxies,
      timeout: REQUEST_TIMEOUT_MS,
    });
    this._mergeResponseCookies(cookies, resp);

    const res = resp.json<Record<string, any>>();
    const status = ((res.data as Record<string, unknown> | null) ?? {}).codeStatus;
    if (status === null || status === undefined) {
      return [false, String(res.msg ?? "二维码状态响应缺少 codeStatus"), cookies];
    }

    if (status === 2) {
      cookies = await this._loginByQrcodeStatus(qrId, code, cookies);
    }

    const statusMap: Record<number, [boolean, string]> = {
      0: [false, "请扫描二维码"],
      1: [false, "请确认登录"],
      2: [true, "验证成功"],
      3: [false, "二维码已过期"],
    };
    // 与 Python status_map.get(status) 语义一致：仅数字键命中，其余走默认分支
    const statusKey = typeof status === "number" ? status : -1;
    const [success, msg] = statusMap[statusKey] ?? [false, `未知状态: ${status}`];
    return [success, msg, cookies];
  }

  /** 扫码确认后换取正式会话（对应 _login_by_qrcode_status） */
  private async _loginByQrcodeStatus(
    qrId: string,
    code: string,
    cookies: Record<string, string>,
  ): Promise<Record<string, string>> {
    const api = "/api/sns/web/v1/login/qrcode/status";
    const params = { qr_id: qrId, code };
    const spliceApi = spliceStr(api, params);
    const visitorSession = String(cookies.web_session ?? "");

    const [headers] = await this._signedRequestParams(cookies, spliceApi, "", "GET");
    headers["x-login-mode"] = "";
    const wireHeaders = buildPcLoginHeaders(headers, this._cookiesForUrl(this.baseUrl, cookies), {
      kind: "get-login-mode",
    });
    const resp = await this.http.get(this.baseUrl + spliceApi, {
      headers: wireHeaders,
      proxies: this.proxies,
      timeout: REQUEST_TIMEOUT_MS,
    });
    this._mergeResponseCookies(cookies, resp, [
      "web_session",
      "id_token",
      "x-rednote-datactry",
      "x-rednote-holderctry",
    ]);

    const res = resp.json<Record<string, any>>();
    const data = (res.data as Record<string, unknown> | null) ?? {};
    if (!res.success || data.code_status !== 2) {
      throw new Error(res.msg ?? "二维码最终登录状态无效");
    }
    const loginInfo = (data.login_info as Record<string, unknown> | null) ?? {};
    const session = String(loginInfo.session ?? "");
    if (session) {
      // 即使 Set-Cookie 解析不可用也替换匿名会话；
      // 保留访客会话会产生虚假的登录成功
      delete cookies.web_session;
      cookies.web_session = session;
      this.profile!.updateCookies(cookies);
    } else if (!cookies.web_session || cookies.web_session === visitorSession) {
      throw new Error("二维码登录响应缺少正式 web_session");
    }

    return cookies;
  }

  /** 获取当前登录用户信息（对应 get_user_info） */
  async getUserInfo(
    cookies: Record<string, string>,
  ): Promise<[boolean, Record<string, unknown>, Record<string, string>]> {
    const api = "/api/sns/web/v2/user/me";

    const [headers] = await this._signedRequestParams(cookies, api, "", "GET");
    const wireHeaders = buildPcLoginHeaders(headers, this._cookiesForUrl(this.baseUrl, cookies), { kind: "get" });
    const resp = await this.http.get(this.baseUrl + api, {
      headers: wireHeaders,
      proxies: this.proxies,
      timeout: REQUEST_TIMEOUT_MS,
    });
    this._mergeResponseCookies(cookies, resp);

    const res = resp.json<Record<string, any>>();
    return [Boolean(res.success), (res.data as Record<string, unknown>) ?? {}, cookies];
  }

  /** 发送手机验证码（对应 send_phone_code） */
  async sendPhoneCode(
    phone: string,
    cookies: Record<string, string>,
    zone = "86",
  ): Promise<[boolean, string, Record<string, unknown>]> {
    const api = "/api/sns/web/v2/login/send_code";
    const params = { phone, zone, type: "login" };
    const spliceApi = spliceStr(api, params);

    const [headers] = await this._signedRequestParams(cookies, spliceApi, "", "GET");
    const wireHeaders = buildPcLoginHeaders(headers, this._cookiesForUrl(this.baseUrl, cookies), { kind: "get" });
    const resp = await this.http.get(this.baseUrl + spliceApi, {
      headers: wireHeaders,
      proxies: this.proxies,
      timeout: REQUEST_TIMEOUT_MS,
    });
    this._mergeResponseCookies(cookies, resp);
    const res = resp.json<Record<string, any>>();
    return [Boolean(res.success), String(res.msg ?? ""), res];
  }

  /** 手机验证码登录（对应 login_by_phone） */
  async loginByPhone(
    phone: string,
    code: string,
    cookies: Record<string, string>,
    zone = "86",
  ): Promise<[boolean, string, PhoneLoginResult | null]> {
    const checkApi = "/api/sns/web/v1/login/check_code";
    const params = { phone, zone, code };
    const spliceApi = spliceStr(checkApi, params);

    const [headers] = await this._signedRequestParams(cookies, spliceApi, "", "GET");
    const wireHeaders = buildPcLoginHeaders(headers, this._cookiesForUrl(this.baseUrl, cookies), { kind: "get" });
    const resp = await this.http.get(this.baseUrl + spliceApi, {
      headers: wireHeaders,
      proxies: this.proxies,
      timeout: REQUEST_TIMEOUT_MS,
    });
    this._mergeResponseCookies(cookies, resp);
    const res = resp.json<Record<string, any>>();
    if (!res.success) {
      return [false, String(res.msg ?? "验证码验证失败"), { cookies }];
    }
    const mobileToken = ((res.data as Record<string, unknown> | null) ?? {}).mobile_token;
    if (!mobileToken) {
      return [false, String(res.msg ?? "验证码响应缺少 mobile_token"), { cookies, res_json: res }];
    }

    const loginApi = "/api/sns/web/v2/login/code";
    const data = { mobile_token: mobileToken, zone, phone };
    const [loginHeaders, loginBody] = await this._signedRequestParams(cookies, loginApi, data);
    const loginWireHeaders = buildPcLoginHeaders(loginHeaders, this._cookiesForUrl(this.baseUrl, cookies), {
      kind: "post",
    });
    const loginResp = await this.http.post(this.baseUrl + loginApi, {
      headers: loginWireHeaders,
      data: String(loginBody),
      proxies: this.proxies,
      timeout: REQUEST_TIMEOUT_MS,
    });
    this._mergeResponseCookies(cookies, loginResp);

    const loginRes = loginResp.json<Record<string, any>>();
    if (!loginRes.success) {
      return [false, String(loginRes.msg ?? "登录失败"), { cookies }];
    }
    const session = ((loginRes.data as Record<string, unknown> | null) ?? {}).session;
    if (!session) {
      return [false, String(loginRes.msg ?? "登录响应缺少 session"), { cookies, res_json: loginRes }];
    }
    delete cookies.web_session;
    cookies.web_session = String(session);
    this.profile!.updateCookies(cookies);
    return [true, "成功", { cookies, res_json: loginRes }];
  }

  /** Cookie 字典序列化为 Cookie 头字符串（对应 cookies_to_str） */
  static cookiesToStr(cookies: Record<string, string>): string {
    return Object.entries(cookies)
      .map(([key, value]) => `${key}=${value}`)
      .join("; ");
  }

  /** 终端打印二维码（对应原版 show_qrcode_terminal，改用 npm qrcode terminal 模式） */
  async showQrcodeTerminal(url: string): Promise<void> {
    const text = await QRCode.toString(url, { type: "terminal", small: true });
    console.log(text);
  }

  /** 生成二维码图片并输出 data URL（对应原版 show_qrcode_image；Node 服务端无图形界面，以 data URL 供调用方展示） */
  async showQrcodeImage(url: string): Promise<void> {
    const dataUrl = await QRCode.toDataURL(url, { width: 320, margin: 4 });
    logger.info(`二维码图片 data URL: ${dataUrl}`);
  }

  /** 扫码登录全流程（对应原版 qrcode_login），返回 Cookie 头字符串或 null */
  async qrcodeLogin(
    options: { showInTerminal?: boolean; timeoutSeconds?: number; pollInterval?: number } = {},
  ): Promise<string | null> {
    const { showInTerminal = true, timeoutSeconds = 180, pollInterval = 2.0 } = options;

    logger.info("[1/5] 正在初始化匿名设备...");
    let cookies: Record<string, string>;
    try {
      cookies = await this.generateInitCookies();
    } catch (exc) {
      logger.error(`匿名设备初始化失败: ${(exc as Error).message}`);
      return null;
    }
    logger.debug(`初始 Cookie 字段: ${Object.keys(cookies).join(", ")}`);

    logger.info("[2/5] 正在获取二维码...");
    const [qrSuccess, qrMsg, qrData] = await this.generateQrcode(cookies);
    if (!qrSuccess || !qrData) {
      logger.error(`获取二维码失败: ${qrMsg}`);
      return null;
    }
    cookies = qrData.cookies;
    // 成功分支必为完整结果（含 qr_id/code/qr_url），失败分支已在上面拦截
    const qrInfo = qrData as QrCreateResult;

    logger.info("[3/5] 正在验证本地指纹环境...");
    try {
      // 浏览器顺序：创建二维码 -> 首次匿名轮询 -> webprofile
      const [preCheckSuccess, preCheckMsg, checkedCookies] = await this.checkQrcodeStatus(
        qrInfo.qr_id,
        qrInfo.code,
        cookies,
      );
      cookies = checkedCookies;
      if (preCheckSuccess) {
        logger.error("二维码在展示前已被确认，拒绝复用异常登录状态");
        return null;
      }
      if (preCheckMsg !== "请扫描二维码") {
        logger.error(`二维码预检查状态异常: ${preCheckMsg}`);
        return null;
      }
      await this.ensureWebprofile(cookies);
    } catch (exc) {
      logger.error(`匿名指纹验收失败，未进入扫码阶段: ${(exc as Error).message}`);
      return null;
    }

    logger.info("请使用小红书APP扫描以下二维码:");
    if (showInTerminal) {
      await this.showQrcodeTerminal(qrInfo.qr_url);
    } else {
      await this.showQrcodeImage(qrInfo.qr_url);
    }

    logger.info("[4/5] 等待扫码和手机确认...");
    const deadline = Date.now() + Math.max(1.0, Number(timeoutSeconds)) * 1000;
    let loginSuccess = false;
    let loginMsg = "";
    while (Date.now() < deadline) {
      try {
        [loginSuccess, loginMsg, cookies] = await this.checkQrcodeStatus(qrInfo.qr_id, qrInfo.code, cookies);
      } catch (exc) {
        logger.error(`二维码状态检查失败: ${(exc as Error).message}`);
        return null;
      }
      if (loginSuccess) {
        logger.info(loginMsg);
        break;
      }
      if (loginMsg === "二维码已过期") {
        logger.error(loginMsg);
        return null;
      }
      await sleep(Math.max(0.5, Number(pollInterval)));
    }
    if (!loginSuccess) {
      logger.error("等待扫码超时，请重新生成二维码");
      return null;
    }

    logger.info("[5/5] 验证正式登录状态...");
    const [userOk, userInfo, finalCookies] = await this.getUserInfo(cookies);
    if (!userOk || (userInfo as Record<string, unknown>).guest !== false) {
      logger.error("正式会话验证失败，拒绝返回访客 Cookie");
      return null;
    }
    logger.info(
      `用户: ${(userInfo as Record<string, unknown>).nickname ?? "未知"} (RedID: ${(userInfo as Record<string, unknown>).red_id ?? "未知"})`,
    );

    const cookiesStr = XHSLoginApi.cookiesToStr(finalCookies);
    logger.success("登录成功，Cookie 已通过返回值交给调用方");
    return cookiesStr;
  }

  /** 短信验证码登录全流程（对应原版 phone_login），返回 Cookie 头字符串或 null */
  async phoneLogin(): Promise<string | null> {
    logger.info("[1/5] 正在初始化匿名设备...");
    let cookies: Record<string, string>;
    try {
      cookies = await this.generateInitCookies();
      await this.ensureWebprofile(cookies);
    } catch (exc) {
      logger.error(`匿名设备验收失败，未发送验证码: ${(exc as Error).message}`);
      return null;
    }
    logger.debug(`初始 Cookie 字段: ${Object.keys(cookies).join(", ")}`);

    const phone = await promptInput("请输入手机号: ");
    logger.info("[2/5] 正在发送验证码...");
    const [sendOk, sendMsg] = await this.sendPhoneCode(phone, cookies);
    if (!sendOk) {
      logger.error(`发送失败: ${sendMsg}`);
      return null;
    }
    logger.info("验证码已发送");

    const code = await promptInput("请输入验证码: ");
    logger.info("[3/5] 正在验证...");
    const [loginOk, loginMsg, loginResult] = await this.loginByPhone(phone, code, cookies);
    if (!loginOk || !loginResult) {
      logger.error(`验证失败: ${loginMsg}`);
      return null;
    }
    cookies = loginResult.cookies;

    logger.info("[4/5] 正在合并正式会话...");
    const [userOk, userInfo, finalCookies] = await this.getUserInfo(cookies);
    if (!userOk || (userInfo as Record<string, unknown>).guest !== false) {
      logger.error("正式会话验证失败，拒绝返回访客 Cookie");
      return null;
    }
    logger.info(
      `用户: ${(userInfo as Record<string, unknown>).nickname ?? "未知"} (RedID: ${(userInfo as Record<string, unknown>).red_id ?? "未知"})`,
    );

    const cookiesStr = XHSLoginApi.cookiesToStr(finalCookies);
    logger.success("[5/5] 登录成功，Cookie 已通过返回值交给调用方");
    return cookiesStr;
  }
}
