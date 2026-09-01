/**
 * XHS PC 签名所需的本地设备模板、页面遥测与会话状态
 * （对应原版 xhs_pc/state.py，逐逻辑平移）
 *
 * SDK 补充：额外导出 REFERENCE_PROFILE（对应原版 state.py __all__ 中的
 * REFERENCE_PROFILE 常量），供 pc/login-api.ts 读取 release 字段
 * （userAgent / secChUa / webProfileSdkVersion）。
 */
import { createRequire } from "node:module";
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { generateB1 } from "../core/runtime";

const require = createRequire(import.meta.url);
const referenceProfileJson = require("../js/pc/reference_profile.json") as Record<string, any>;

/** 参考设备模板（对应原版 REFERENCE_PROFILE） */
export const REFERENCE_PROFILE: Record<string, any> = referenceProfileJson;

export const DS_REFRESH_INTERVAL_MS = 15 * 60 * 1000;
export const TIGA_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

export function nowMs(): number {
  return Date.now();
}

/** 对齐浏览器 ets 写入（避免末位数字 1） */
export function normalizeEtsTimestamp(timestampMs: number): number {
  const value = Math.floor(timestampMs);
  return value % 10 === 1 ? value + 1 : value;
}

/** 构建匿名 Cookie 集合（对应 initial_pc_cookies） */
export function initialPcCookies(
  a1: string,
  webId: string,
  options: { abRequestId: string; timestampMs?: number; loadtsMs?: number; webBuild?: string; appId?: string },
): Record<string, string> {
  const timestamp = Math.floor(options.timestampMs ?? nowMs());
  const loadts = Math.floor(options.loadtsMs ?? timestamp);
  if (!options.abRequestId) throw new Error("initial_pc_cookies requires server-issued abRequestId");
  return {
    abRequestId: String(options.abRequestId),
    ets: String(normalizeEtsTimestamp(timestamp)),
    webBuild: String(options.webBuild ?? referenceProfileJson.release.webBuild),
    xsecappid: String(options.appId ?? referenceProfileJson.release.appId),
    loadts: String(loadts),
    a1: String(a1),
    webId: String(web_id_to_string(webId)),
  };
}

function web_id_to_string(webId: string): string {
  return webId;
}

// ---------------- Cookie 工具（PC 局部，与原版 state.py 一致） ----------------

export function parseCookieKv(cookies: unknown): Record<string, string> {
  if (cookies && typeof cookies === "object" && !Array.isArray(cookies)) {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(cookies as Record<string, unknown>)) {
      result[String(key)] = String(value);
    }
    return result;
  }
  const result: Record<string, string> = {};
  for (const item of String(cookies ?? "").split(";")) {
    const part = item.trim();
    if (!part) continue;
    const index = part.indexOf("=");
    if (index >= 0) result[part.slice(0, index).trim()] = part.slice(index + 1);
  }
  return result;
}

export function cookieHeader(cookies: Record<string, unknown> | unknown): string {
  const values = parseCookieKv(cookies);
  return Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join("; ");
}

// ---------------- MNS 环境材料 ----------------

export interface MnsStageMaterial {
  tier: string;
  envConst: number;
  envFpTail: number[];
  evidence: string;
}

function hexTail(value: unknown): number[] {
  let raw: Buffer;
  if (typeof value === "string") {
    raw = Buffer.from(value, "hex");
  } else if (Array.isArray(value)) {
    raw = Buffer.from(value.map((item) => Number(item) & 0xff));
  } else {
    throw new Error("MNS envFpTail 必须为 hex 字符串或字节数组");
  }
  if (raw.length !== 14) throw new Error(`MNS envFpTail 必须为 14 bytes，当前 ${raw.length}`);
  return [...raw];
}

function mnsStageFromMapping(value: Record<string, unknown>): MnsStageMaterial {
  const tail = value.envFpTailHex ?? value.envFpTail;
  if (tail === null || tail === undefined) throw new Error("MNS stage requires envFpTailHex or envFpTail");
  return {
    tier: String(value.tier),
    envConst: Number(value.envConst),
    envFpTail: hexTail(tail),
    evidence: String(value.evidence ?? ""),
  };
}

function referenceMnsStages(): Record<string, MnsStageMaterial> {
  const result: Record<string, MnsStageMaterial> = {};
  for (const [name, value] of Object.entries(referenceProfileJson.mnsStages)) {
    result[name] = mnsStageFromMapping(value as Record<string, unknown>);
  }
  return result;
}

const STAGE_NAME_BY_TIER: Record<string, string> = {
  "0201": "security",
  "0101": "coldContent",
  "0301": "steadyContent",
};

// ---------------- B1 运行时状态 ----------------

export interface B1RuntimeStateOptions {
  frameCount?: number;
  x39Value?: number;
  x50Value?: string;
  secCanvas?: string;
  generatedAtOffsetMs?: number | null;
  selectedGlobalNames?: string[];
  timeOriginMs?: number;
  telemetryProfile?: string;
  telemetryTemplate?: string;
  mouse?: Record<string, unknown>;
  keyboard?: Record<string, unknown>;
  page?: Record<string, unknown>;
  state?: Record<string, unknown>;
  features?: Record<string, unknown>;
  overrides?: Record<string, unknown>;
}

/** 生成 b1 明文所需的本地设备模板和动态遥测输入（对应 B1RuntimeState） */
export class B1RuntimeState {
  frameCount: number;
  x39Value: number;
  x50Value: string;
  secCanvas: string;
  generatedAtOffsetMs: number | null;
  selectedGlobalNames: string[];
  timeOriginMs: number;
  telemetryProfile: string;
  telemetryTemplate: string;
  mouse: Record<string, unknown>;
  keyboard: Record<string, unknown>;
  page: Record<string, unknown>;
  state: Record<string, unknown>;
  features: Record<string, unknown>;
  overrides: Record<string, unknown>;

  constructor(options: B1RuntimeStateOptions) {
    this.frameCount = options.frameCount ?? 0;
    this.x39Value = options.x39Value ?? 0;
    this.x50Value = options.x50Value ?? "";
    this.secCanvas = options.secCanvas ?? "";
    this.generatedAtOffsetMs = options.generatedAtOffsetMs ?? null;
    this.selectedGlobalNames = options.selectedGlobalNames ?? [];
    this.timeOriginMs = options.timeOriginMs ?? 0;
    this.telemetryProfile = options.telemetryProfile ?? "active";
    this.telemetryTemplate = options.telemetryTemplate ?? "";
    this.mouse = options.mouse ?? {};
    this.keyboard = options.keyboard ?? {};
    this.page = options.page ?? {};
    this.state = options.state ?? {};
    this.features = options.features ?? {};
    this.overrides = options.overrides ?? {};
  }

  /** 从参考模板构建（对应 reference()） */
  static reference(startedAt?: number, profileName = ""): B1RuntimeState {
    const value: Record<string, unknown> = { ...referenceProfileJson.b1Reference };
    if (profileName) {
      const profile = (referenceProfileJson.b1Profiles ?? {})[profileName];
      if (!profile) {
        const available = Object.keys(referenceProfileJson.b1Profiles ?? {}).join(", ") || "(none)";
        throw new Error(`unknown PC b1 profile '${profileName}'; available: ${available}`);
      }
      Object.assign(value, profile);
    }
    const originBase = startedAt ?? nowMs();
    const overrides: Record<string, unknown> = { ...((value.overrides as Record<string, unknown>) ?? {}) };
    for (const key of ["x37", "x38", "x82"]) {
      if (value[key] !== undefined) overrides[key] = String(value[key]);
    }
    return new B1RuntimeState({
      frameCount: Number(value.frameCount),
      x39Value: Number(value.x39),
      x50Value: String(value.x50),
      secCanvas: String(value.secCanvas),
      generatedAtOffsetMs: value.generatedAtOffsetMs !== undefined && value.generatedAtOffsetMs !== null ? Number(value.generatedAtOffsetMs) : null,
      selectedGlobalNames: Array.isArray(value.selectedGlobalNames) ? value.selectedGlobalNames.map(String) : [],
      timeOriginMs: originBase + Number(value.timeOriginOffsetMs ?? 0),
      telemetryProfile: String(value.telemetryProfile ?? "active"),
      telemetryTemplate: String(value.telemetryTemplate ?? ""),
      mouse: { ...((value.mouse as Record<string, unknown>) ?? {}) },
      keyboard: { ...((value.keyboard as Record<string, unknown>) ?? {}) },
      page: { ...((value.page as Record<string, unknown>) ?? {}) },
      state: { ...((value.state as Record<string, unknown>) ?? {}) },
      features: { ...((value.features as Record<string, unknown>) ?? {}) },
      overrides,
    });
  }

  /** 组装 b1.js 输入（对应 to_b1_options） */
  toB1Options(timestampMs: number): Record<string, unknown> {
    const overrides: Record<string, unknown> = { ...this.overrides };
    overrides.x36 = String(this.frameCount);
    if (this.telemetryTemplate) {
      overrides.x84 = this.telemetryTemplate.replace("__TIME_ORIGIN__", String(this.timeOriginMs));
    }
    return {
      now: Math.floor(timestampMs),
      x39: this.x39Value,
      x50: this.x50Value,
      secCanvas: this.secCanvas,
      windowKeys: [...this.selectedGlobalNames],
      telemetry: {
        profile: this.telemetryProfile,
        timeOrigin: this.timeOriginMs,
        mouse: { ...this.mouse },
        keyboard: { ...this.keyboard },
        page: { ...this.page },
        state: { ...this.state },
        features: { ...this.features },
      },
      overrides,
    };
  }

  updateWindowState(options: {
    frameCount?: number;
    x39Value?: number;
    x50Value?: string;
    secCanvas?: string;
    globalCount?: number;
    selectedGlobalNames?: Iterable<string>;
  }): void {
    if (options.frameCount !== undefined) this.frameCount = Math.floor(options.frameCount);
    if (options.x39Value !== undefined) this.x39Value = Math.floor(options.x39Value);
    else if (options.globalCount !== undefined) this.x39Value = Math.floor(options.globalCount);
    if (options.x50Value !== undefined) this.x50Value = String(options.x50Value);
    if (options.secCanvas !== undefined) this.secCanvas = String(options.secCanvas);
    if (options.selectedGlobalNames !== undefined) {
      this.selectedGlobalNames = [...options.selectedGlobalNames].map(String);
    }
  }
}

// ---------------- 会话状态 ----------------

export interface PcSessionStateOptions {
  loadts: number;
  dsllt: number;
  ets: number;
  mnsSeq?: number;
  fingerprintReady?: boolean;
  lastTigaUpdateTime?: number;
  profileCount?: number;
  signCount?: number;
  tabDeviceId?: string;
  rwpFingerprint?: string;
  rwpLoginToken?: Record<string, unknown>;
  unreadState?: Record<string, unknown>;
}

/** PC 会话状态（对应 PcSessionState） */
export class PcSessionState {
  loadts: number;
  dsllt: number;
  ets: number;
  mnsSeq: number;
  fingerprintReady: boolean;
  lastTigaUpdateTime: number;
  profileCount: number;
  signCount: number;
  tabDeviceId: string;
  rwpFingerprint: string;
  rwpLoginToken: Record<string, unknown>;
  unreadState: Record<string, unknown>;

  constructor(options: PcSessionStateOptions) {
    this.loadts = Math.floor(options.loadts);
    this.dsllt = Math.floor(options.dsllt);
    this.ets = Math.floor(options.ets);
    this.mnsSeq = options.mnsSeq ?? 0;
    this.fingerprintReady = options.fingerprintReady ?? false;
    this.lastTigaUpdateTime = options.lastTigaUpdateTime ?? 0;
    this.profileCount = options.profileCount ?? 0;
    this.signCount = options.signCount ?? 0;
    this.tabDeviceId = options.tabDeviceId ?? "";
    this.rwpFingerprint = options.rwpFingerprint ?? "";
    this.rwpLoginToken = options.rwpLoginToken ?? {};
    this.unreadState = options.unreadState ?? {};
  }

  nextSeq(): number {
    this.mnsSeq += 1;
    return this.mnsSeq;
  }

  nextSignCount(): number {
    this.signCount += 1;
    return this.signCount;
  }

  ensureDsllt(timestampMs: number, force = false): number {
    const timestamp = Math.floor(timestampMs);
    if (force || timestamp - this.dsllt >= DS_REFRESH_INTERVAL_MS) {
      this.dsllt = timestamp;
    }
    return this.dsllt;
  }

  needsTigaRefresh(timestampMs: number): boolean {
    return !this.lastTigaUpdateTime || Math.floor(timestampMs) - this.lastTigaUpdateTime >= TIGA_REFRESH_INTERVAL_MS;
  }

  markTigaUpdated(timestampMs?: number): number {
    this.lastTigaUpdateTime = Math.floor(timestampMs ?? nowMs());
    return this.lastTigaUpdateTime;
  }

  markProfileReported(): number {
    this.profileCount += 1;
    this.fingerprintReady = true;
    return this.profileCount;
  }

  ensureTabDeviceId(): string {
    if (!this.tabDeviceId) {
      this.tabDeviceId = randomUUID();
    }
    return this.tabDeviceId;
  }

  ensureRwpFingerprint(timestampMs?: number): string {
    if (!this.rwpFingerprint) {
      this.rwpFingerprint = String(Math.floor(timestampMs ?? nowMs()));
    }
    return this.rwpFingerprint;
  }

  setRwpLoginToken(token: Record<string, unknown>): void {
    this.rwpLoginToken = { ...token };
  }

  currentRwpLoginToken(userId: string, timestampMs?: number): Record<string, unknown> | null {
    const token = { ...this.rwpLoginToken };
    const timestamp = Math.floor(timestampMs ?? nowMs());
    if (
      !Object.keys(token).length ||
      String(token.uid ?? "") !== String(userId ?? "") ||
      Number(token.expiredAt ?? 0) <= timestamp
    ) {
      this.rwpLoginToken = {};
      return null;
    }
    return token;
  }

  snapshot(): Record<string, unknown> {
    return {
      loadts: this.loadts,
      dsllt: this.dsllt,
      ets: this.ets,
      mnsSeq: this.mnsSeq,
      fingerprintReady: this.fingerprintReady,
      lastTigaUpdateTime: this.lastTigaUpdateTime,
      p1: this.profileCount,
      sc: this.signCount,
      XHS_TAB_DEVICE_ID: this.ensureTabDeviceId(),
      XHS_RWP_FINGERPRINT: this.ensureRwpFingerprint(),
      RWP_LOGIN_TOKEN: { ...this.rwpLoginToken },
      unread: { ...this.unreadState },
    };
  }
}

// ---------------- 设备资料 ----------------

const COOKIE_HIDDEN = new Set([
  "acw_tc",
  "web_session",
  "secure_session",
  "id_token",
  "customer-sso-sid",
  "access-token-creator.xiaohongshu.com",
  "galaxy_creator_session_id",
]);

export interface PcDeviceProfileOptions {
  cookies?: unknown;
  localStorage?: Record<string, unknown>;
  sessionStorage?: Record<string, unknown>;
  fixedB1?: string;
  webBuild?: string;
  release?: Record<string, unknown>;
  b1State?: B1RuntimeState | null;
  session?: PcSessionState | null;
  mnsStages?: Record<string, MnsStageMaterial>;
  rapFingerprintHex?: string;
  webProfileFields?: Record<string, unknown>;
  webProfileI12Seed?: number | null;
  webProfileFi?: number | null;
  source?: string;
  browserExactInputs?: boolean;
}

/** 跨 b1/MNS/X-S-Common/RAP/webprofile 共用的显式运行时输入（对应 PcDeviceProfile） */
export class PcDeviceProfile {
  cookies: string;
  localStorage: Record<string, unknown>;
  sessionStorage: Record<string, unknown>;
  fixedB1: string;
  webBuild: string;
  release: Record<string, unknown>;
  b1State: B1RuntimeState;
  session: PcSessionState;
  mnsStages: Record<string, MnsStageMaterial>;
  rapFingerprintHex: string;
  webProfileFields: Record<string, unknown>;
  webProfileI12Seed: number | null;
  webProfileFi: number | null;
  source: string;
  browserExactInputs: boolean;
  private cookieMapData: Record<string, string>;
  private namedB1States = new Map<string, B1RuntimeState>();
  private namedB1Values = new Map<string, string>();

  constructor(options: PcDeviceProfileOptions) {
    this.cookieMapData = parseCookieKv(options.cookies ?? "");
    this.cookies = cookieHeader(this.cookieMapData);
    this.localStorage = { ...(options.localStorage ?? {}) };
    this.sessionStorage = { ...(options.sessionStorage ?? {}) };
    this.fixedB1 = options.fixedB1 ?? "";
    this.release = { ...(options.release ?? referenceProfileJson.release) };
    this.webProfileFields = { ...(options.webProfileFields ?? {}) };
    this.webProfileI12Seed = options.webProfileI12Seed !== undefined && options.webProfileI12Seed !== null ? Math.floor(options.webProfileI12Seed) : null;
    if (this.webProfileI12Seed !== null && !(0 <= this.webProfileI12Seed && this.webProfileI12Seed <= 255)) {
      throw new Error("web_profile_i12_seed must be in [0, 255]");
    }
    this.webProfileFi = options.webProfileFi !== undefined && options.webProfileFi !== null ? Math.floor(options.webProfileFi) : null;
    if (this.webProfileFi !== null && this.webProfileFi < 0) throw new Error("web_profile_fi must be >= 0");
    this.rapFingerprintHex = options.rapFingerprintHex ?? "";
    this.mnsStages = options.mnsStages ? { ...options.mnsStages } : referenceMnsStages();
    this.source = options.source ?? "reference";
    this.browserExactInputs = options.browserExactInputs ?? false;

    const started = this.cookieMapData.loadts ? Number(this.cookieMapData.loadts) : nowMs();
    if (options.session) {
      this.session = options.session;
    } else {
      // websectiga 由 seccallback 程序在成功上报前产出；gid 存在即视为指纹就绪
      const ready = Boolean(this.cookieMapData.gid);
      this.session = new PcSessionState({
        loadts: started,
        dsllt: this.localStorage.dsllt ? Number(this.localStorage.dsllt) : started,
        ets: this.cookieMapData.ets ? Number(this.cookieMapData.ets) : normalizeEtsTimestamp(started),
        fingerprintReady: ready,
        lastTigaUpdateTime: this.localStorage.last_tiga_update_time ? Number(this.localStorage.last_tiga_update_time) : 0,
        profileCount: this.localStorage.p1 !== undefined ? Number(this.localStorage.p1) : 0,
        signCount: this.localStorage.sc !== undefined ? Number(this.localStorage.sc) : 0,
        tabDeviceId: String(this.sessionStorage.XHS_TAB_DEVICE_ID ?? ""),
        rwpFingerprint: String(this.sessionStorage.XHS_RWP_FINGERPRINT ?? ""),
        rwpLoginToken: jsonObject(this.localStorage.RWP_LOGIN_TOKEN ?? {}),
        unreadState: jsonObject(this.cookieMapData.unread ?? {}),
      });
    }
    this.session.ensureTabDeviceId();
    this.session.ensureRwpFingerprint(started);
    this.b1State = options.b1State ?? B1RuntimeState.reference(started);
    this.webBuild = options.webBuild ?? this.cookieMapData.webBuild ?? String(this.release.webBuild ?? "");
  }

  get cookieMap(): Record<string, string> {
    return { ...this.cookieMapData };
  }

  /** document.cookie 视图（隐藏 HttpOnly 等字段，对应原版 document_cookie 属性） */
  get documentCookie(): string {
    return cookieHeader(
      Object.fromEntries(
        Object.entries(this.cookieMapData).filter(([key]) => !COOKIE_HIDDEN.has(key)),
      ),
    );
  }

  updateCookies(cookies: unknown): void {
    const updates = parseCookieKv(cookies);
    const oldWebsectiga = this.cookieMapData.websectiga;
    Object.assign(this.cookieMapData, updates);
    this.cookies = cookieHeader(this.cookieMapData);
    if (updates.webBuild) this.webBuild = updates.webBuild;
    if (updates.loadts) this.session.loadts = Number(updates.loadts);
    if (updates.ets) this.session.ets = Number(updates.ets);
    if (updates.unread) this.session.unreadState = jsonObject(updates.unread);
    if (updates.websectiga && updates.websectiga !== oldWebsectiga) {
      this.session.markTigaUpdated();
    }
    if (updates.gid) this.session.fingerprintReady = true;
  }

  resolveMnsTier(api: string, explicitTier?: string | null): string {
    if (explicitTier) {
      const tier = String(explicitTier);
      if (!["0101", "0201", "0301"].includes(tier)) throw new Error(`unsupported mns tier: ${tier}`);
      return tier;
    }
    const value = String(api ?? "");
    if (this.session.fingerprintReady) return "0301";
    if (value.includes("/api/sec/v1/") || value.includes("/api/redcaptcha/") || value.includes("sem_sdk")) return "0201";
    return "0101";
  }

  setMnsStage(tier: string, options: { envConst: number; envFpTail: unknown; evidence?: string }): void {
    const resolved = String(tier);
    const stageName = STAGE_NAME_BY_TIER[resolved];
    if (!stageName) throw new Error(`unsupported mns tier: ${resolved}`);
    this.mnsStages[stageName] = {
      tier: resolved,
      envConst: Math.floor(options.envConst),
      envFpTail: hexTail(options.envFpTail),
      evidence: String(options.evidence ?? "runtime override"),
    };
  }

  private stageForTier(tier: string): MnsStageMaterial {
    const name = STAGE_NAME_BY_TIER[tier];
    const material = this.mnsStages[name];
    if (!material || material.tier !== tier) {
      throw new Error(`MNS stage ${name} tier mismatch: ${material?.tier ?? "missing"} != ${tier}`);
    }
    return material;
  }

  nextSignContext(
    api: string,
    options: { tier?: string | null; timestampMs?: number; version?: number | null } = {},
  ): Record<string, unknown> {
    const resolved = this.resolveMnsTier(api, options.tier ?? null);
    const material = this.stageForTier(resolved);
    const timestamp = Math.floor(options.timestampMs ?? nowMs());
    return {
      tier: resolved,
      now: timestamp,
      version: Math.floor(options.version ?? randomInt(0, 0x100000000)),
      loadts: this.session.loadts,
      seq: this.session.nextSeq(),
      envConst: material.envConst,
      envFpTail: [...material.envFpTail],
      webBuild: this.webBuild,
      signVersion: String(this.release.signVersion ?? "4.3.7"),
      appId: String(this.release.appId ?? "xhs-pc-web"),
      platform: String(this.release.platform ?? "Windows"),
      userAgent: String(this.release.userAgent ?? ""),
      secChUa: String(this.release.secChUa ?? ""),
    };
  }

  currentB1(timestampMs?: number, profileName?: string | null): string {
    if (this.fixedB1) return this.fixedB1;
    const timestamp = Math.floor(timestampMs ?? nowMs());
    if (profileName) {
      const key = String(profileName);
      const cached = this.namedB1Values.get(key);
      if (cached) return cached;
      let state = this.namedB1States.get(key);
      if (!state) {
        state = B1RuntimeState.reference(this.session.loadts, key);
        this.namedB1States.set(key, state);
      }
      let usedTimestamp = timestamp;
      if (state.generatedAtOffsetMs !== null && state.generatedAtOffsetMs !== undefined) {
        usedTimestamp = this.session.loadts + state.generatedAtOffsetMs;
      }
      const value = generateB1(state.toB1Options(usedTimestamp));
      this.namedB1Values.set(key, value);
      return value;
    }
    return generateB1(this.b1State.toB1Options(timestamp));
  }

  profileDataOptions(timestampMs?: number): Record<string, unknown> {
    const timestamp = Math.floor(timestampMs ?? nowMs());
    const options: Record<string, unknown> = {
      fields: { ...this.webProfileFields },
      timestamp_ms: timestamp,
      ets: this.session.ets,
      document_cookie: this.documentCookie,
      time_origin: this.session.loadts + Number(referenceProfileJson.webProfile?.timeOriginOffsetMs ?? 0),
    };
    if (this.webProfileI12Seed !== null && this.webProfileI12Seed !== undefined) {
      options.i12_seed = this.webProfileI12Seed;
    }
    if (this.webProfileFi !== null && this.webProfileFi !== undefined) {
      options.telemetry_fi = this.webProfileFi;
    }
    return options;
  }

  dslPair(dsl: string, options: { timestampMs?: number; refreshed?: boolean } = {}): string {
    if (!dsl) throw new Error("_dsl 为空");
    const timestamp = Math.floor(options.timestampMs ?? nowMs());
    const dsllt = this.session.ensureDsllt(timestamp, options.refreshed ?? false);
    return `${dsllt};${dsl}`;
  }

  markFingerprintReady(ready = true): void {
    this.session.fingerprintReady = Boolean(ready);
  }

  needsTigaRefresh(timestampMs?: number): boolean {
    return this.session.needsTigaRefresh(Math.floor(timestampMs ?? nowMs()));
  }

  markTigaUpdated(timestampMs?: number): number {
    return this.session.markTigaUpdated(timestampMs);
  }

  markProfileReported(): number {
    return this.session.markProfileReported();
  }

  updateStorage(localStorage?: Record<string, unknown> | null, sessionStorage?: Record<string, unknown> | null): void {
    const localState = { ...(localStorage ?? {}) };
    const tabState = { ...(sessionStorage ?? {}) };
    if (localState.dsllt) this.session.dsllt = Number(localState.dsllt);
    if (localState.last_tiga_update_time) this.session.lastTigaUpdateTime = Number(localState.last_tiga_update_time);
    if (localState.p1 !== undefined && localState.p1 !== null) this.session.profileCount = Number(localState.p1);
    if (localState.sc !== undefined && localState.sc !== null) this.session.signCount = Number(localState.sc);
    if (localState.RWP_LOGIN_TOKEN) this.session.rwpLoginToken = jsonObject(localState.RWP_LOGIN_TOKEN);
    if (tabState.XHS_TAB_DEVICE_ID) this.session.tabDeviceId = String(tabState.XHS_TAB_DEVICE_ID);
    if (tabState.XHS_RWP_FINGERPRINT) this.session.rwpFingerprint = String(tabState.XHS_RWP_FINGERPRINT);
  }

  stateSnapshot(): Record<string, unknown> {
    const snapshot = this.session.snapshot();
    return {
      ...snapshot,
      webBuild: this.webBuild,
      xsecappid: String(this.release.appId ?? "xhs-pc-web"),
    };
  }
}

/** 解析 JSON 对象（容忍失败返回 {}） */
function jsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return { ...(value as Record<string, unknown>) };
  }
  try {
    const parsed = JSON.parse(decodeURIComponent(String(value ?? "")));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {
    // 解析失败返回空对象
  }
  return {};
}

export { randomBytes, randomInt, randomUUID };
