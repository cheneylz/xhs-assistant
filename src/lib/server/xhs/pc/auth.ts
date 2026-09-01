/**
 * PC Web 认证（对应原版 xhs_pc/auth.py）
 */
import { PC_PLATFORM_CONFIG, XHSAuth } from "../core/auth";
import { HostCookieStore, cookieHeader, parseCookieKv, urlHost } from "../core/cookies";
import { getDsl } from "./dsl";
import { PcHttpClient } from "./http";
import { PcDeviceProfile, B1RuntimeState, PcSessionState, nowMs, type MnsStageMaterial } from "./state";

export const PC_PARAMETER_SOURCES = {
  local_algorithm: [
    "a1", "webId", "ets", "loadts", "b1",
    "MNS0101", "MNS0201", "MNS0301", "X-s", "X-t", "X-S-Common",
    "x-b3-traceid", "x-xray-traceid", "xy-direction", "x-rap-param",
    "search_id", "request_id", "profileData",
  ],
  reverse_alignment_override: [
    "b1_state", "local_storage", "session_storage", "xsecappid", "webBuild",
    "envConst", "envFpTail", "rap_fingerprint", "web_profile_fields",
    "web_profile_i12_seed", "web_profile_fi",
  ],
  managed_lifecycle_state: [
    "dsllt", "mns_seq", "last_tiga_update_time", "p1", "sc",
    "XHS_TAB_DEVICE_ID", "XHS_RWP_FINGERPRINT", "unread",
  ],
  remote_program_or_anchor: ["_dsl", "websectiga_scripting_code", "websectiga"],
  server_issued: [
    "abRequestId", "host-scoped acw_tc",
    "visitor_web_session", "web_session", "secure_session", "id_token",
    "gid", "sec_poison_id", "mobile_token", "mobile_token_security",
    "captcha_challenge", "login_token", "RWP_LOGIN_TOKEN",
  ],
  user_interaction: [
    "complete_cookie_for_cookie_login", "qr_scan_and_confirmation",
    "phone_number", "sms_code",
  ],
};

/** 认证工厂令牌：防止直接构造（对应 _AUTH_FACTORY_TOKEN） */
const AUTH_FACTORY_TOKEN = Symbol("XHSPcAuth.factory");

export interface XHSPcAuthOptions {
  loginSource?: string;
  cookies?: unknown;
  b1?: string;
  dsl?: string;
  userId?: string;
  localStorage?: Record<string, unknown>;
  sessionStorage?: Record<string, unknown>;
  b1State?: B1RuntimeState | null;
  webBuild?: string;
  mnsEnv?: Record<string, { envConst: number; envFpTailHex?: string; envFpTail?: unknown; evidence?: string }>;
  rapFingerprintHex?: string;
  webProfileFields?: Record<string, unknown>;
  webProfileI12Seed?: number | null;
  webProfileFi?: number | null;
  hostCookies?: Record<string, unknown>;
  hostCookieState?: Record<string, unknown>;
  cookieSourceUrl?: string;
  profile?: PcDeviceProfile | null;
  httpClient?: PcHttpClient | null;
  proxies?: Record<string, string> | null;
}

/** PC Web 认证 + 签名所需全部可变输入（对应 XHSPcAuth） */
export class XHSPcAuth extends XHSAuth {
  protected platformConfig = PC_PLATFORM_CONFIG;
  platform = "pc";
  loginSource = "cookie";
  cookies: string;
  b1 = "";
  dsl = "";
  userId = "";
  localStorage: Record<string, unknown>;
  sessionStorage: Record<string, unknown>;
  b1State: B1RuntimeState | null;
  webBuild: string;
  mnsEnv: Record<string, { envConst: number; envFpTailHex?: string; envFpTail?: unknown; evidence?: string }>;
  rapFingerprintHex: string;
  webProfileFields: Record<string, unknown>;
  webProfileI12Seed: number | null;
  webProfileFi: number | null;
  hostCookies: Record<string, Record<string, string>>;
  hostCookieState: Record<string, unknown>;
  cookieSourceUrl: string;
  profile: PcDeviceProfile;
  httpClient: PcHttpClient;
  private cookieStore: HostCookieStore;
  private userIdReady: boolean;

  protected constructor(options: XHSPcAuthOptions) {
    super();
    this.loginSource = this.bindPlatform(options.loginSource ?? "cookie");
    this.httpClient = options.httpClient ?? new PcHttpClient({ proxies: options.proxies ?? null });
    this.cookies = "";
    this.localStorage = { ...(options.localStorage ?? {}) };
    this.sessionStorage = { ...(options.sessionStorage ?? {}) };
    this.b1State = options.b1State ?? null;
    this.webBuild = options.webBuild ?? "";
    this.mnsEnv = { ...(options.mnsEnv ?? {}) };
    this.rapFingerprintHex = options.rapFingerprintHex ?? "";
    this.webProfileFields = { ...(options.webProfileFields ?? {}) };
    this.webProfileI12Seed = options.webProfileI12Seed ?? null;
    this.webProfileFi = options.webProfileFi ?? null;
    this.hostCookieState = { ...(options.hostCookieState ?? {}) };
    this.cookieSourceUrl = options.cookieSourceUrl ?? "";
    this.userId = options.userId ?? "";
    this.userIdReady = Boolean(this.userId);

    const cookieMap = parseCookieKv(options.cookies ?? "");
    this.cookieStore = Object.keys(this.hostCookieState).length
      ? HostCookieStore.fromState(this.hostCookieState)
      : new HostCookieStore(options.hostCookies ?? null);
    this.cookieStore.extractHostOnly(cookieMap, this.cookieSourceUrl || this.origin("api"));
    this.hostCookies = this.cookieStore.snapshot();
    this.cookies = cookieHeader(cookieMap);

    if (options.profile) {
      this.profile = options.profile;
      this.profile.updateCookies(cookieMap);
      this.profile.updateStorage(this.localStorage, this.sessionStorage);
      if (this.b1) this.profile.fixedB1 = this.b1;
      if (this.b1State) this.profile.b1State = this.b1State;
      if (this.webBuild) this.profile.webBuild = this.webBuild;
      if (this.rapFingerprintHex) this.profile.rapFingerprintHex = this.rapFingerprintHex;
      if (Object.keys(this.webProfileFields).length) {
        Object.assign(this.profile.webProfileFields, this.webProfileFields);
      }
      if (this.webProfileI12Seed !== null && this.webProfileI12Seed !== undefined) {
        this.profile.webProfileI12Seed = this.webProfileI12Seed;
      }
      if (this.webProfileFi !== null && this.webProfileFi !== undefined) {
        this.profile.webProfileFi = this.webProfileFi;
      }
    } else {
      this.profile = new PcDeviceProfile({
        cookies: cookieMap,
        localStorage: this.localStorage,
        sessionStorage: this.sessionStorage,
        fixedB1: this.b1,
        webBuild: this.webBuild,
        b1State: this.b1State,
        rapFingerprintHex: this.rapFingerprintHex,
        webProfileFields: this.webProfileFields,
        webProfileI12Seed: this.webProfileI12Seed,
        webProfileFi: this.webProfileFi,
        source: `auth:${this.loginSource}`,
      });
    }

    for (const [tier, material] of Object.entries(this.mnsEnv)) {
      this.profile.setMnsStage(tier, {
        envConst: Number(material.envConst),
        envFpTail: material.envFpTailHex ?? material.envFpTail,
        evidence: String(material.evidence ?? "XHSPcAuth override"),
      });
    }

    this.setDsl(this.dsl);
    this.webBuild = String(this.profile.webBuild);
    this.userIdReady = Boolean(this.userId);
    this.validate();
  }

  /** 工厂：从完整 Cookie 构建（对应 from_cookie） */
  static fromCookie(cookies: unknown, options: Omit<XHSPcAuthOptions, "loginSource"> = {}): XHSPcAuth {
    return new XHSPcAuth({ ...options, loginSource: "cookie", cookies });
  }

  /** 工厂：QR 登录流程（对应 from_qrcode_login，需要登录 API 实例） */
  static async fromQrcodeLogin(
    loginApi: { qrcodeLogin: (opts?: { showInTerminal?: boolean }) => Promise<string | null>; hostCookiesSnapshot?: () => Record<string, Record<string, string>>; hostCookieState?: () => Record<string, unknown> },
    options: Omit<XHSPcAuthOptions, "loginSource" | "hostCookies" | "cookieSourceUrl"> = {},
  ): Promise<XHSPcAuth> {
    const httpClient = options.httpClient ?? new PcHttpClient({ proxies: options.proxies ?? null });
    const cookies = await loginApi.qrcodeLogin({ showInTerminal: false });
    if (!cookies) {
      httpClient.close();
      throw new Error("XHS QR login did not return an authenticated Cookie");
    }
    return new XHSPcAuth({
      ...options,
      loginSource: "qrcode",
      cookies,
      httpClient,
      hostCookies: loginApi.hostCookiesSnapshot?.() ?? {},
      hostCookieState: loginApi.hostCookieState?.() ?? {},
      cookieSourceUrl: PC_PLATFORM_CONFIG.origin("api"),
    });
  }

  /** 工厂：短信登录流程（对应 from_phone_login） */
  static async fromPhoneLogin(
    loginApi: { phoneLogin: () => Promise<string | null>; hostCookiesSnapshot?: () => Record<string, Record<string, string>>; hostCookieState?: () => Record<string, unknown> },
    options: Omit<XHSPcAuthOptions, "loginSource" | "hostCookies" | "cookieSourceUrl"> = {},
  ): Promise<XHSPcAuth> {
    const httpClient = options.httpClient ?? new PcHttpClient({ proxies: options.proxies ?? null });
    const cookies = await loginApi.phoneLogin();
    if (!cookies) {
      httpClient.close();
      throw new Error("XHS phone login did not return an authenticated Cookie");
    }
    return new XHSPcAuth({
      ...options,
      loginSource: "phone",
      cookies,
      httpClient,
      hostCookies: loginApi.hostCookiesSnapshot?.() ?? {},
      hostCookieState: loginApi.hostCookieState?.() ?? {},
      cookieSourceUrl: PC_PLATFORM_CONFIG.origin("api"),
    });
  }

  /** 校验 Cookie 完整性（对应 validate） */
  validate(requireUserId = false): void {
    const cookies = this.profile.cookieMap;
    if (!cookies.a1) {
      throw new Error("XHSPcAuth.cookies must contain a1; use a saved local login Cookie or XHSPcAuth.from_qrcode_login()/from_phone_login()");
    }
    if (!cookies.web_session) {
      throw new Error("XHSPcAuth.cookies must contain server-issued web_session; use qrcode/phone login when no saved session is available");
    }
    if (requireUserId && !this.userId) {
      throw new Error("user_id is missing; call XHS_Apis(auth).bootstrap() first");
    }
  }

  static parameterSources(): Record<string, string[]> {
    return Object.fromEntries(Object.entries(PC_PARAMETER_SOURCES).map(([k, v]) => [k, [...v]]));
  }

  get a1(): string {
    return this.profile.cookieMap.a1;
  }

  get signCookie(): string {
    return this.profile.documentCookie;
  }

  cookiesForUrl(url: string, cookies?: unknown): Record<string, string> {
    return this.cookieStore.cookiesForUrl(url, cookies === undefined ? this.profile.cookieMap : cookies);
  }

  hostCookiesSnapshot(): Record<string, Record<string, string>> {
    return this.cookieStore.snapshot();
  }

  currentB1(timestampMs?: number): string {
    return this.profile.currentB1(timestampMs);
  }

  nextSignContext(api: string, options: { tier?: string | null; timestampMs?: number } = {}): Record<string, unknown> {
    return this.profile.nextSignContext(api, options);
  }

  updateCookies(cookies: unknown, options: { sourceUrl?: string } = {}): void {
    const values = this.profile.cookieMap;
    const updates = parseCookieKv(cookies);
    this.cookieStore.extractHostOnly(updates, options.sourceUrl || this.origin("api"));
    Object.assign(values, updates);
    this.profile.updateCookies(values);
    this.cookies = cookieHeader(this.profile.cookieMap);
    this.hostCookies = this.cookieStore.snapshot();
  }

  updateRuntimeState(options: {
    b1?: string | null;
    dsl?: string | null;
    userId?: string | null;
    localStorage?: Record<string, unknown> | null;
    sessionStorage?: Record<string, unknown> | null;
    webProfileFields?: Record<string, unknown> | null;
    webProfileI12Seed?: number | null;
    webProfileFi?: number | null;
  }): this {
    if (options.b1 !== undefined && options.b1 !== null) {
      this.b1 = String(options.b1);
      this.profile.fixedB1 = this.b1;
    }
    if (options.dsl !== undefined && options.dsl !== null) this.setDsl(options.dsl);
    if (options.userId !== undefined && options.userId !== null) this.setUserId(options.userId);
    if (options.webProfileFields !== undefined && options.webProfileFields !== null) {
      this.webProfileFields = { ...options.webProfileFields };
      Object.assign(this.profile.webProfileFields, this.webProfileFields);
    }
    if (options.webProfileI12Seed !== undefined && options.webProfileI12Seed !== null) {
      this.webProfileI12Seed = options.webProfileI12Seed;
      this.profile.webProfileI12Seed = options.webProfileI12Seed;
    }
    if (options.webProfileFi !== undefined && options.webProfileFi !== null) {
      this.webProfileFi = options.webProfileFi;
      this.profile.webProfileFi = options.webProfileFi;
    }
    this.profile.updateStorage(options.localStorage ?? undefined, options.sessionStorage ?? undefined);
    return this;
  }

  updateBrowserState(options: Parameters<XHSPcAuth["updateRuntimeState"]>[0]): this {
    return this.updateRuntimeState(options);
  }

  /** 当前 dsl_pair（对应 dsl_pair 属性） */
  async dslPair(): Promise<string> {
    let value = this.dsl;
    if (!value) {
      value = await getDsl({ httpClient: this.httpClient });
    }
    return this.profile.dslPair(value);
  }

  /** 强制刷新 dsl（对应 refresh_dsl） */
  async refreshDsl(): Promise<string> {
    this.dsl = await getDsl({ force: true, httpClient: this.httpClient });
    this.profile.session.dsllt = nowMs();
    return this.profile.dslPair(this.dsl);
  }

  needsTigaRefresh(timestampMs?: number): boolean {
    return this.profile.needsTigaRefresh(timestampMs);
  }

  stateSnapshot(includeTokens = false): Record<string, unknown> {
    const state = this.profile.stateSnapshot();
    state.loginSource = this.loginSource;
    state.transport = this.httpClient.stateSnapshot();
    state.hostCookieKeys = Object.fromEntries(
      Object.entries(this.cookieStore.snapshot()).map(([host, values]) => [host, Object.keys(values)]),
    );
    if (!includeTokens) state.RWP_LOGIN_TOKEN = {};
    return state;
  }

  close(): void {
    this.httpClient.close();
  }

  setUserId(userId: string): this {
    if (!userId) throw new Error("user_id is empty");
    this.userId = String(userId);
    this.userIdReady = true;
    return this;
  }

  /** 解析 dsl 输入（兼容 "<dsllt>;<dsl>" 旧格式，对应 _set_dsl） */
  private setDsl(value: string): void {
    const text = String(value ?? "");
    let content = text;
    if (text.includes(";")) {
      const [dsllt, rest] = text.split(";", 2);
      if (/^\d+$/.test(dsllt)) {
        this.profile.session.dsllt = Number.parseInt(dsllt, 10);
      }
      content = rest;
    }
    this.dsl = content;
  }
}
