/**
 * Creator 认证对象（对应原版 xhs_creator/auth.py）
 */
import { CREATOR_PLATFORM_CONFIG, XHSAuth } from "../core/auth";
import { HostCookieStore, cookieHeader, parseCookieKv } from "../core/cookies";
import { getDsBundle } from "./dsl";
import { CreatorHttpClient } from "./http";
import { CreatorDeviceProfile, CreatorB1RuntimeState, DS_REFRESH_INTERVAL_MS, nowMs } from "./state";

export const CREATOR_PARAMETER_SOURCES = {
  local_algorithm: [
    "a1", "webId", "ets", "loadts", "b1",
    "MNS0101", "MNS0201", "X-s", "X-t", "X-S-Common",
    "x-b3-traceid", "x-xray-traceid", "profileData",
  ],
  browser_derived_profile_data: [
    "b1_state", "web_profile_fields", "MNS envConst/envFpTail",
    "release appId/platform/webBuild/signVersion",
    "optional post-login abRequestId",
  ],
  managed_lifecycle_state: ["dsllt", "MNS seq", "b1b1", "sc", "security_ready"],
  remote_program_or_anchor: ["_dsl", "_dsf DS program", "scripting program", "websectiga"],
  server_issued: [
    "gid", "sec_poison_id", "host-scoped acw_tc", "customer-sso-sid",
    "access-token-creator.xiaohongshu.com", "galaxy_creator_session_id",
    "web_session", "id_token", "QR id/url", "service ticket",
  ],
  user_interaction: ["complete_cookie_for_cookie_login", "QR scan and confirmation", "phone number", "SMS code"],
};

const AUTH_FACTORY_TOKEN = Symbol("XHSCreatorAuth.factory");

const AUTH_COOKIE_KEYS = [
  "customer-sso-sid",
  "access-token-creator.xiaohongshu.com",
  "galaxy_creator_session_id",
  "web_session",
];

export interface XHSCreatorAuthOptions {
  loginSource?: string;
  cookies?: unknown;
  b1?: string;
  dsl?: string;
  localStorage?: Record<string, unknown>;
  sessionStorage?: Record<string, unknown>;
  b1State?: CreatorB1RuntimeState | null;
  mnsEnv?: Record<string, { envConst: number; envFpTailHex?: string; envFpTail?: unknown; deviceTag?: string | null; evidence?: string }>;
  webProfileFields?: Record<string, unknown>;
  hostCookies?: Record<string, unknown>;
  hostCookieState?: Record<string, unknown>;
  cookieSourceUrl?: string;
  profile?: CreatorDeviceProfile | null;
  httpClient?: CreatorHttpClient | null;
  proxies?: Record<string, string> | null;
}

/** Creator 创作者中心认证（对应 XHSCreatorAuth） */
export class XHSCreatorAuth extends XHSAuth {
  protected platformConfig = CREATOR_PLATFORM_CONFIG;
  platform = "creator";
  loginSource = "cookie";
  cookies: string;
  b1: string;
  dsl: string;
  localStorage: Record<string, unknown>;
  sessionStorage: Record<string, unknown>;
  b1State: CreatorB1RuntimeState | null;
  mnsEnv: Record<string, { envConst: number; envFpTailHex?: string; envFpTail?: unknown; deviceTag?: string | null; evidence?: string }>;
  webProfileFields: Record<string, unknown>;
  hostCookies: Record<string, Record<string, string>>;
  hostCookieState: Record<string, unknown>;
  cookieSourceUrl: string;
  profile: CreatorDeviceProfile;
  httpClient: CreatorHttpClient;
  private cookieStore: HostCookieStore;

  protected constructor(options: XHSCreatorAuthOptions) {
    super();
    this.loginSource = this.bindPlatform(options.loginSource ?? "cookie");
    this.httpClient = options.httpClient ?? new CreatorHttpClient({ proxies: options.proxies ?? null });
    this.cookies = "";
    this.b1 = options.b1 ?? "";
    this.dsl = options.dsl ?? "";
    this.localStorage = { ...(options.localStorage ?? {}) };
    this.sessionStorage = { ...(options.sessionStorage ?? {}) };
    this.b1State = options.b1State ?? null;
    this.mnsEnv = { ...(options.mnsEnv ?? {}) };
    this.webProfileFields = { ...(options.webProfileFields ?? {}) };
    this.hostCookieState = { ...(options.hostCookieState ?? {}) };
    this.cookieSourceUrl = options.cookieSourceUrl ?? "";

    const values = parseCookieKv(options.cookies ?? "");
    this.cookieStore = Object.keys(this.hostCookieState).length
      ? HostCookieStore.fromState(this.hostCookieState)
      : new HostCookieStore(options.hostCookies ?? null);
    this.cookieStore.extractHostOnly(values, this.cookieSourceUrl || this.origin("api"));
    this.hostCookies = this.cookieStore.snapshot();
    this.cookies = cookieHeader(values);

    if (options.profile) {
      this.profile = options.profile;
      this.profile.updateCookies(values);
      if (this.b1) this.profile.fixedB1 = String(this.b1);
      if (this.b1State) this.profile.b1State = this.b1State;
      if (Object.keys(this.webProfileFields).length) {
        Object.assign(this.profile.webProfileFields, this.webProfileFields);
      }
    } else {
      this.profile = new CreatorDeviceProfile({
        cookies: values,
        localStorage: this.localStorage,
        sessionStorage: this.sessionStorage,
        fixedB1: this.b1,
        dsl: this.dsl,
        b1State: this.b1State,
        webProfileFields: this.webProfileFields,
        source: `auth:${this.loginSource}`,
      });
    }

    for (const [stage, material] of Object.entries(this.mnsEnv)) {
      this.profile.setMnsStage(stage, {
        envConst: Number(material.envConst),
        envFpTail: material.envFpTailHex ?? material.envFpTail,
        deviceTag: material.deviceTag ?? null,
        evidence: String(material.evidence ?? "XHSCreatorAuth override"),
      });
    }
    this.setDsl(this.dsl || this.profile.dsl);
    this.validate(true);
  }

  /** 工厂：完整 Cookie（对应 from_cookie） */
  static fromCookie(cookies: unknown, options: Omit<XHSCreatorAuthOptions, "loginSource"> = {}): XHSCreatorAuth {
    return new XHSCreatorAuth({ ...options, loginSource: "cookie", cookies });
  }

  /** 工厂：QR 登录（对应 from_qrcode_login，登录期间可能重建传输实例，用最终 client） */
  static async fromQrcodeLogin(
    loginApi: {
      qrcodeLogin: (opts?: { showInTerminal?: boolean }) => Promise<string | null>;
      http?: CreatorHttpClient;
      hostCookiesSnapshot?: () => Record<string, Record<string, string>>;
      hostCookieState?: () => Record<string, unknown>;
    },
    options: Omit<XHSCreatorAuthOptions, "loginSource" | "hostCookies" | "cookieSourceUrl"> = {},
  ): Promise<XHSCreatorAuth> {
    const profile = XHSCreatorAuth.newLoginProfile(options, "auth:qrcode");
    const httpClient = options.httpClient ?? new CreatorHttpClient({ proxies: options.proxies ?? null });
    const login = {
      ...loginApi,
      http: loginApi.http ?? httpClient,
    };
    const cookies = await login.qrcodeLogin({ showInTerminal: false });
    if (!cookies) {
      login.http.close();
      throw new Error("Creator QR login did not return an authenticated Cookie");
    }
    return new XHSCreatorAuth({
      ...options,
      loginSource: "qrcode",
      cookies,
      profile,
      httpClient: login.http,
      hostCookies: login.hostCookiesSnapshot?.() ?? {},
      hostCookieState: login.hostCookieState?.() ?? {},
      cookieSourceUrl: CREATOR_PLATFORM_CONFIG.origin("api"),
    });
  }

  /** 工厂：短信登录（对应 from_phone_login） */
  static async fromPhoneLogin(
    loginApi: {
      phoneLogin: () => Promise<string | null>;
      http?: CreatorHttpClient;
      hostCookiesSnapshot?: () => Record<string, Record<string, string>>;
      hostCookieState?: () => Record<string, unknown>;
    },
    options: Omit<XHSCreatorAuthOptions, "loginSource" | "hostCookies" | "cookieSourceUrl"> = {},
  ): Promise<XHSCreatorAuth> {
    const profile = XHSCreatorAuth.newLoginProfile(options, "auth:phone");
    const httpClient = options.httpClient ?? new CreatorHttpClient({ proxies: options.proxies ?? null });
    const login = {
      ...loginApi,
      http: loginApi.http ?? httpClient,
    };
    const cookies = await login.phoneLogin();
    if (!cookies) {
      login.http.close();
      throw new Error("Creator phone login did not return an authenticated Cookie");
    }
    return new XHSCreatorAuth({
      ...options,
      loginSource: "phone",
      cookies,
      profile,
      httpClient: login.http,
      hostCookies: login.hostCookiesSnapshot?.() ?? {},
      hostCookieState: login.hostCookieState?.() ?? {},
      cookieSourceUrl: CREATOR_PLATFORM_CONFIG.origin("api"),
    });
  }

  private static newLoginProfile(
    options: XHSCreatorAuthOptions,
    source: string,
  ): CreatorDeviceProfile {
    const profile = new CreatorDeviceProfile({
      cookies: "",
      localStorage: options.localStorage ?? {},
      sessionStorage: options.sessionStorage ?? {},
      fixedB1: String(options.b1 ?? ""),
      dsl: String(options.dsl ?? ""),
      b1State: options.b1State ?? null,
      webProfileFields: options.webProfileFields ?? {},
      source,
    });
    for (const [stage, material] of Object.entries(options.mnsEnv ?? {})) {
      profile.setMnsStage(stage, {
        envConst: Number(material.envConst),
        envFpTail: material.envFpTailHex ?? material.envFpTail,
        deviceTag: material.deviceTag ?? null,
        evidence: String(material.evidence ?? source),
      });
    }
    return profile;
  }

  static parameterSources(): Record<string, string[]> {
    return Object.fromEntries(Object.entries(CREATOR_PARAMETER_SOURCES).map(([k, v]) => [k, [...v]]));
  }

  get cookieMap(): Record<string, string> {
    return this.profile.cookieMap;
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

  get a1(): string {
    return this.profile.cookieMap.a1;
  }

  validate(requireAuthenticated = true): void {
    const cookies = this.profile.cookieMap;
    if (!cookies.a1) throw new Error("Creator Cookie must contain a1");
    if (requireAuthenticated && !AUTH_COOKIE_KEYS.some((key) => cookies[key])) {
      throw new Error("Creator Cookie is not authenticated; pass the complete Cookie or use QR/phone login");
    }
  }

  currentB1(timestampMs?: number, profileName?: string | null): string {
    return this.profile.currentB1(timestampMs, profileName);
  }

  nextSignContext(
    _api: string,
    options: { tier?: string | null; mnsProfile?: string | null; timestampMs?: number; version?: number | null } = {},
  ): Record<string, unknown> {
    return this.profile.nextSignContext(options);
  }

  dslPair(timestampMs?: number): Promise<string> {
    return this.ensureDsMaterial().then(() => this.profile.dslPair(timestampMs));
  }

  /** 确保 _dsl 与 _dsf 程序就绪（对应 ensure_ds_material） */
  async ensureDsMaterial(force = false): Promise<void> {
    if (!this.profile.session.securityReady) return;
    const stale = nowMs() - this.profile.session.dsllt >= DS_REFRESH_INTERVAL_MS;
    if (!force && !stale && this.profile.dsl && this.profile.dsProgram) return;
    const effectiveForce = Boolean(force || stale);
    const [dsl, program] = await getDsBundle({
      force: effectiveForce,
      httpClient: this.httpClient,
    });
    if (effectiveForce || !this.profile.dsl) this.profile.dsl = dsl;
    this.profile.dsProgram = program;
    if (effectiveForce) this.profile.session.dsllt = nowMs();
  }

  async refreshDsl(): Promise<string> {
    await this.ensureDsMaterial(true);
    return this.profile.dslPair();
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
    b1State?: CreatorB1RuntimeState | null;
    webProfileFields?: Record<string, unknown> | null;
  }): this {
    if (options.b1 !== undefined && options.b1 !== null) {
      this.b1 = String(options.b1);
      this.profile.fixedB1 = this.b1;
    }
    if (options.dsl !== undefined && options.dsl !== null) this.setDsl(options.dsl);
    if (options.b1State !== undefined && options.b1State !== null) {
      this.b1State = options.b1State;
      this.profile.b1State = options.b1State;
    }
    if (options.webProfileFields !== undefined && options.webProfileFields !== null) {
      this.webProfileFields = { ...options.webProfileFields };
      Object.assign(this.profile.webProfileFields, this.webProfileFields);
    }
    return this;
  }

  stateSnapshot(): Record<string, unknown> {
    const state = this.profile.stateSnapshot();
    state.loginSource = this.loginSource;
    state.transport = this.httpClient.stateSnapshot();
    state.hostCookieKeys = Object.fromEntries(
      Object.entries(this.cookieStore.snapshot()).map(([host, values]) => [host, Object.keys(values)]),
    );
    return state;
  }

  close(): void {
    this.httpClient.close();
  }

  /** 解析 dsl（兼容 "<dsllt>;<dsl>"，对应 _set_dsl） */
  private setDsl(value: string): void {
    const text = String(value ?? "");
    let content = text;
    if (text.includes(";")) {
      const [dsllt, rest] = text.split(";", 2);
      if (/^\d+$/.test(dsllt)) this.profile.session.dsllt = Number.parseInt(dsllt, 10);
      content = rest;
    }
    this.dsl = content;
    this.profile.dsl = content;
    if (content && content !== "undefined") {
      this.profile.session.securityReady = true;
    }
  }
}
