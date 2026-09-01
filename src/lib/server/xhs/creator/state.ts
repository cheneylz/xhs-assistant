/**
 * Creator 4.3.6 签名状态（对应原版 xhs_creator/state.py，逐逻辑平移）
 */
import { createRequire } from "node:module";
import { randomInt } from "node:crypto";
import { generateB1 } from "../core/runtime";

const require = createRequire(import.meta.url);
const referenceProfileJson = require("../js/creator/reference_profile.json") as Record<string, any>;

export const DS_REFRESH_INTERVAL_MS = 15 * 60 * 1000;

export function nowMs(): number {
  return Date.now();
}

const DOCUMENT_COOKIE_ORDER = [
  "ets", "a1", "webId", "gid", "abRequestId", "webBuild", "xsecappid",
  "websectiga", "sec_poison_id", "loadts",
];

/** 解析 Cookie 键值 */
export function parseCookieKv(value: unknown): Record<string, string> {
  if (value === null || value === undefined) return {};
  if (typeof value === "object" && !Array.isArray(value)) {
    const result: Record<string, string> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (key !== null && item !== null && item !== undefined) result[String(key)] = String(item);
    }
    return result;
  }
  const result: Record<string, string> = {};
  for (const part of String(value).split(";")) {
    const item = part.trim();
    if (!item) continue;
    const index = item.indexOf("=");
    if (index > 0) result[item.slice(0, index).trim()] = item.slice(index + 1);
  }
  return result;
}

export function cookieHeader(value: unknown): string {
  return Object.entries(parseCookieKv(value))
    .map(([key, item]) => `${key}=${item}`)
    .join("; ");
}

/** document.cookie 视图（按白名单顺序，隐藏 HttpOnly 登录令牌，对应 document_cookie_header） */
export function documentCookieHeader(value: unknown): string {
  const values = parseCookieKv(value);
  return DOCUMENT_COOKIE_ORDER.filter((key) => values[key] !== undefined && key in values)
    .map((key) => `${key}=${values[key]}`)
    .join("; ");
}

function tailBytes(value: unknown): number[] {
  let raw: Buffer;
  if (typeof value === "string") raw = Buffer.from(value, "hex");
  else if (Array.isArray(value)) raw = Buffer.from(value.map((item) => Number(item) & 0xff));
  else throw new Error("Creator MNS envFpTail must be hex string or byte array");
  if (raw.length !== 14) throw new Error(`Creator MNS envFpTail must be 14 bytes, got ${raw.length}`);
  return [...raw];
}

function jsAtom(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  return String(value);
}

function mapText(value: Record<string, unknown>): string {
  return Object.entries(value)
    .map(([key, item]) => `${key}:${jsAtom(item)}`)
    .join(",");
}

export interface CreatorMnsMaterial {
  tier: string;
  deviceTag: string;
  envConst: number;
  envFpTail: number[];
  evidence: string;
}

function mnsFromMapping(value: Record<string, unknown>): CreatorMnsMaterial {
  return {
    tier: String(value.tier),
    deviceTag: String(value.deviceTag),
    envConst: Number(value.envConst),
    envFpTail: tailBytes(value.envFpTailHex ?? value.envFpTail),
    evidence: String(value.evidence ?? ""),
  };
}

function referenceMnsStages(): Record<string, CreatorMnsMaterial> {
  const result: Record<string, CreatorMnsMaterial> = {};
  for (const [name, value] of Object.entries(referenceProfileJson.mnsStages)) {
    result[name] = mnsFromMapping(value as Record<string, unknown>);
  }
  return result;
}

function referenceMnsProfiles(): Record<string, CreatorMnsMaterial> {
  const result: Record<string, CreatorMnsMaterial> = {};
  for (const [name, value] of Object.entries(referenceProfileJson.mnsProfiles ?? {})) {
    result[name] = mnsFromMapping(value as Record<string, unknown>);
  }
  return result;
}

// ---------------- Creator b1 运行时状态 ----------------

export interface CreatorB1RuntimeStateOptions {
  frameCount: number;
  x39Value: number;
  x50Value: string;
  x51Value: string;
  generatedAtOffsetMs: number | null;
  secCanvas: string;
  x37Value: string;
  x38Value: string;
  selectedGlobalNames: string[];
  timeOriginMs: number;
  mouse: Record<string, unknown>;
  keyboard: Record<string, unknown>;
  page: Record<string, unknown>;
  state: Record<string, unknown>;
  features: Record<string, unknown>;
  overrides?: Record<string, unknown>;
}

/** Creator b1 收集器状态（对应 CreatorB1RuntimeState，含会话级抖动） */
export class CreatorB1RuntimeState {
  frameCount: number;
  x39Value: number;
  x50Value: string;
  x51Value: string;
  generatedAtOffsetMs: number | null;
  secCanvas: string;
  x37Value: string;
  x38Value: string;
  selectedGlobalNames: string[];
  timeOriginMs: number;
  mouse: Record<string, unknown>;
  keyboard: Record<string, unknown>;
  page: Record<string, unknown>;
  state: Record<string, unknown>;
  features: Record<string, unknown>;
  overrides: Record<string, unknown>;

  constructor(options: CreatorB1RuntimeStateOptions) {
    this.frameCount = options.frameCount;
    this.x39Value = options.x39Value;
    this.x50Value = options.x50Value;
    this.x51Value = options.x51Value;
    this.generatedAtOffsetMs = options.generatedAtOffsetMs;
    this.secCanvas = options.secCanvas;
    this.x37Value = options.x37Value;
    this.x38Value = options.x38Value;
    this.selectedGlobalNames = options.selectedGlobalNames;
    this.timeOriginMs = options.timeOriginMs;
    this.mouse = options.mouse;
    this.keyboard = options.keyboard;
    this.page = options.page;
    this.state = options.state;
    this.features = options.features;
    this.overrides = options.overrides ?? {};
  }

  /** 构建浏览器派生页面 profile（对应 reference()） */
  static reference(startedAt?: number, profileName = "login"): CreatorB1RuntimeState {
    const value: Record<string, unknown> = { ...referenceProfileJson.b1Reference };
    if (profileName !== "" && profileName !== "login" && profileName !== "default") {
      const profile = (referenceProfileJson.b1Profiles ?? {})[profileName];
      if (!profile) {
        const available = ["login", ...Object.keys(referenceProfileJson.b1Profiles ?? {})].join(", ");
        throw new Error(`unknown Creator b1 profile '${profileName}'; available: ${available}`);
      }
      Object.assign(value, profile);
    }
    const originBase = startedAt ?? nowMs();
    const state = new CreatorB1RuntimeState({
      frameCount: Number(value.frameCount),
      x39Value: Number(value.x39),
      x50Value: String(value.x50),
      x51Value: String(value.x51 ?? ""),
      generatedAtOffsetMs: value.generatedAtOffsetMs !== undefined && value.generatedAtOffsetMs !== null ? Number(value.generatedAtOffsetMs) : null,
      secCanvas: String(value.secCanvas),
      x37Value: String(value.x37),
      x38Value: String(value.x38),
      selectedGlobalNames: Array.isArray(value.selectedGlobalNames) ? value.selectedGlobalNames.map(String) : [],
      timeOriginMs: originBase + Number(value.timeOriginOffsetMs ?? 0),
      mouse: { ...((value.mouse as Record<string, unknown>) ?? {}) },
      keyboard: { ...((value.keyboard as Record<string, unknown>) ?? {}) },
      page: { ...((value.page as Record<string, unknown>) ?? {}) },
      state: { ...((value.state as Record<string, unknown>) ?? {}) },
      features: { ...((value.features as Record<string, unknown>) ?? {}) },
    });
    state.jitter(originBase);
    return state;
  }

  /** 会话级抖动（对应 _jitter，2026-07-25 实测：静态 b1 会被边缘聚类标记返回 406） */
  private jitter(originBase: number): void {
    this.frameCount = Math.max(1, this.frameCount + [-1, 0, 1][Math.floor(Math.random() * 3)]);
    const bits = this.x37Value.split("|").map(Number);
    const zeros = bits.map((bit, index) => (bit === 0 ? index : -1)).filter((index) => index >= 0);
    const flipCount = Math.min(zeros.length, 1 + Math.floor(Math.random() * 3));
    // 随机翻转 1~3 个 0 位
    const shuffled = [...zeros].sort(() => Math.random() - 0.5);
    for (const index of shuffled.slice(0, flipCount)) bits[index] = 1;
    this.x37Value = bits.join("|");
    this.x39Value = Math.floor(Math.random() * 6);
    this.timeOriginMs = originBase - (50 + Math.random() * 2950);
    // x84 页面遥测键序对齐浏览器序列化
    const preference = ["ulr", "f", "rs", "ps"];
    const reordered: Record<string, unknown> = {};
    for (const key of preference) {
      if (key in this.page) reordered[key] = this.page[key];
    }
    for (const [key, value] of Object.entries(this.page)) {
      if (!preference.includes(key)) reordered[key] = value;
    }
    this.page = reordered;
  }

  telemetry(): string {
    const features: Record<string, unknown> = {
      ae: null, ak: null, cdr: null, bf: null, fi: null,
      ...this.features,
    };
    const bf = features.bf as Record<string, unknown> | null | undefined;
    const bfText = bf === null || bf === undefined ? "null" : `{ar:${jsAtom(bf.ar)},fr:${jsAtom(bf.fr)}}`;
    return (
      `{mt:{to:${this.timeOriginMs}},` +
      `m:{${mapText(this.mouse)}},` +
      `k:{${mapText(this.keyboard)}},` +
      `p:{${mapText(this.page)}},` +
      `st:{${mapText(this.state)}},` +
      `ft:{ae:${jsAtom(features.ae)},ak:${jsAtom(features.ak)},cdr:${jsAtom(features.cdr)},bf:${bfText},fi:${jsAtom(features.fi)}}}}`
    );
  }

  toB1Options(timestampMs: number): Record<string, unknown> {
    const overrides = {
      x36: String(this.frameCount),
      x37: this.x37Value,
      x38: this.x38Value,
      x82: this.selectedGlobalNames.join("|"),
      x84: this.telemetry(),
      ...this.overrides,
    };
    return {
      now: Math.floor(timestampMs),
      x39: this.x39Value,
      x50: this.x50Value,
      x51: this.x51Value,
      secCanvas: this.secCanvas,
      overrides,
    };
  }

  updateWindowState(options: {
    frameCount?: number;
    x39Value?: number;
    x50Value?: string;
    x51Value?: string;
    secCanvas?: string;
    selectedGlobalNames?: Iterable<string>;
  }): void {
    if (options.frameCount !== undefined) this.frameCount = Math.floor(options.frameCount);
    if (options.x39Value !== undefined) this.x39Value = Math.floor(options.x39Value);
    if (options.x50Value !== undefined) this.x50Value = String(options.x50Value);
    if (options.x51Value !== undefined) this.x51Value = String(options.x51Value);
    if (options.secCanvas !== undefined) this.secCanvas = String(options.secCanvas);
    if (options.selectedGlobalNames !== undefined) this.selectedGlobalNames = [...options.selectedGlobalNames].map(String);
  }
}

// ---------------- Creator 会话状态 ----------------

export interface CreatorSessionStateOptions {
  loadts: number;
  dsllt: number;
  ets: number;
  mnsSeq?: number;
  securityReady?: boolean;
  profileCount?: number;
  signCount?: number;
}

/** Creator 会话状态（对应 CreatorSessionState） */
export class CreatorSessionState {
  loadts: number;
  dsllt: number;
  ets: number;
  mnsSeq: number;
  securityReady: boolean;
  profileCount: number;
  signCount: number;

  constructor(options: CreatorSessionStateOptions) {
    this.loadts = Math.floor(options.loadts);
    this.dsllt = Math.floor(options.dsllt);
    this.ets = Math.floor(options.ets);
    this.mnsSeq = options.mnsSeq ?? 0;
    this.securityReady = options.securityReady ?? false;
    this.profileCount = options.profileCount ?? 0;
    this.signCount = options.signCount ?? 0;
  }

  nextSeq(): number {
    this.mnsSeq += 1;
    return this.mnsSeq;
  }

  ensureDsllt(timestampMs: number, force = false): number {
    const timestamp = Math.floor(timestampMs);
    if (force || timestamp - this.dsllt >= DS_REFRESH_INTERVAL_MS) {
      this.dsllt = timestamp;
    }
    return this.dsllt;
  }

  snapshot(): Record<string, unknown> {
    return {
      loadts: this.loadts,
      dsllt: this.dsllt,
      ets: this.ets,
      mnsSeq: this.mnsSeq,
      securityReady: this.securityReady,
      p1: this.profileCount,
      sc: this.signCount,
    };
  }
}

// ---------------- Creator 设备资料 ----------------

export interface CreatorDeviceProfileOptions {
  cookies?: unknown;
  localStorage?: Record<string, unknown>;
  sessionStorage?: Record<string, unknown>;
  fixedB1?: string;
  dsl?: string;
  dsProgram?: string;
  release?: Record<string, unknown>;
  b1State?: CreatorB1RuntimeState | null;
  session?: CreatorSessionState | null;
  mnsStages?: Record<string, CreatorMnsMaterial>;
  mnsProfiles?: Record<string, CreatorMnsMaterial>;
  webProfileFields?: Record<string, unknown>;
  source?: string;
}

/** Creator b1/MNS/X-S-Common/profileData 状态（对应 CreatorDeviceProfile） */
export class CreatorDeviceProfile {
  cookies: string;
  localStorage: Record<string, unknown>;
  sessionStorage: Record<string, unknown>;
  fixedB1: string;
  dsl: string;
  dsProgram: string;
  release: Record<string, unknown>;
  b1State: CreatorB1RuntimeState;
  session: CreatorSessionState;
  mnsStages: Record<string, CreatorMnsMaterial>;
  mnsProfiles: Record<string, CreatorMnsMaterial>;
  webProfileFields: Record<string, unknown>;
  source: string;
  private cookieMapData: Record<string, string>;
  private namedB1States = new Map<string, CreatorB1RuntimeState>();
  private namedB1Values = new Map<string, string>();
  private b1StateExplicit: boolean;
  private mnsStageOverrides = new Set<string>();

  constructor(options: CreatorDeviceProfileOptions) {
    this.cookieMapData = parseCookieKv(options.cookies ?? "");
    this.cookies = cookieHeader(this.cookieMapData);
    this.localStorage = { ...(options.localStorage ?? {}) };
    this.sessionStorage = { ...(options.sessionStorage ?? {}) };
    this.fixedB1 = options.fixedB1 ?? "";
    this.dsl = options.dsl ?? "";
    this.dsProgram = options.dsProgram ?? "";
    this.release = { ...(options.release ?? referenceProfileJson.release) };
    this.webProfileFields = { ...(options.webProfileFields ?? {}) };
    this.mnsStages = options.mnsStages ? { ...options.mnsStages } : referenceMnsStages();
    this.mnsProfiles = options.mnsProfiles ? { ...options.mnsProfiles } : referenceMnsProfiles();
    this.source = options.source ?? "reference";

    const started = this.cookieMapData.loadts ? Number(this.cookieMapData.loadts) : nowMs();
    if (options.session) {
      this.session = options.session;
    } else {
      this.session = new CreatorSessionState({
        loadts: started,
        dsllt: this.localStorage.dsllt ? Number(this.localStorage.dsllt) : started,
        ets: this.cookieMapData.ets ? Number(this.cookieMapData.ets) : started,
        mnsSeq: this.localStorage.mns_seq ? Number(this.localStorage.mns_seq) : 0,
        securityReady: Boolean(this.cookieMapData.websectiga || this.cookieMapData.gid || this.dsl),
        profileCount: this.localStorage.p1 ? Number(this.localStorage.p1) : 0,
        signCount: this.sessionStorage.sc ? Number(this.sessionStorage.sc) : this.localStorage.sc ? Number(this.localStorage.sc) : 0,
      });
    }
    this.b1StateExplicit = options.b1State !== undefined && options.b1State !== null;
    this.b1State = options.b1State ?? CreatorB1RuntimeState.reference(started);
  }

  get cookieMap(): Record<string, string> {
    return { ...this.cookieMapData };
  }

  get documentCookie(): string {
    return documentCookieHeader(this.cookieMapData);
  }

  updateCookies(cookies: unknown): void {
    const updates = parseCookieKv(cookies);
    Object.assign(this.cookieMapData, updates);
    this.cookies = cookieHeader(this.cookieMapData);
    if (updates.loadts) this.session.loadts = Number(updates.loadts);
    if (updates.ets) this.session.ets = Number(updates.ets);
    if (updates.websectiga || updates.gid) this.session.securityReady = true;
  }

  activateSecurity(dsl: string, dsProgram = "", options: { timestampMs?: number } = {}): void {
    this.dsl = String(dsl ?? "");
    if (dsProgram) this.dsProgram = String(dsProgram);
    // DS 程序安装时即设置 dsllt（首个 mns0101 请求之前）
    this.session.dsllt = Math.floor(options.timestampMs ?? nowMs());
    this.session.securityReady = true;
  }

  resolveMnsTier(explicitTier?: string | null): string {
    if (explicitTier !== undefined && explicitTier !== null) {
      const tier = String(explicitTier);
      if (!["0101", "0201"].includes(tier)) throw new Error(`unsupported Creator MNS tier: ${tier}`);
      return tier;
    }
    return this.session.securityReady ? "0101" : "0201";
  }

  /** 解析具体 MNS 档位与材料（不推进序列号，对应 resolve_mns_material） */
  resolveMnsMaterial(options: { tier?: string | null; mnsProfile?: string | null } = {}): [string, CreatorMnsMaterial] {
    const resolved = this.resolveMnsTier(options.tier ?? null);
    const stageKey = resolved === "0201" ? "bootstrap" : "ready";
    let material = this.mnsStages[stageKey];
    if (options.mnsProfile && !this.mnsStageOverrides.has(stageKey)) {
      const candidate = this.mnsProfiles[String(options.mnsProfile)];
      if (!candidate) {
        const available = Object.keys(this.mnsProfiles).join(", ") || "(none)";
        throw new Error(`unknown Creator MNS profile '${options.mnsProfile}'; available: ${available}`);
      }
      if (candidate.tier !== resolved) {
        throw new Error(`Creator MNS profile '${options.mnsProfile}' uses ${candidate.tier}, request resolved to ${resolved}`);
      }
      material = candidate;
    }
    return [resolved, material];
  }

  setMnsStage(
    nameOrTier: string,
    options: { envConst: number; envFpTail: unknown; deviceTag?: string | null; evidence?: string },
  ): void {
    const key = String(nameOrTier) === "0201" ? "bootstrap" : "ready";
    const current = this.mnsStages[key];
    this.mnsStages[key] = {
      tier: current.tier,
      deviceTag: String(options.deviceTag ?? current.deviceTag),
      envConst: Math.floor(options.envConst),
      envFpTail: tailBytes(options.envFpTail),
      evidence: String(options.evidence ?? "runtime override"),
    };
    this.mnsStageOverrides.add(key);
  }

  nextSignContext(options: {
    tier?: string | null;
    mnsProfile?: string | null;
    timestampMs?: number;
    version?: number | null;
  } = {}): Record<string, unknown> {
    const [resolved, material] = this.resolveMnsMaterial({ tier: options.tier ?? null, mnsProfile: options.mnsProfile ?? null });
    const timestamp = Math.floor(options.timestampMs ?? nowMs());
    return {
      tier: resolved,
      now: timestamp,
      version: Math.floor(options.version ?? randomInt(0, 0x100000000)),
      loadts: this.session.loadts,
      seq: this.session.nextSeq(),
      envConst: material.envConst,
      envFpTail: [...material.envFpTail],
      deviceTag: material.deviceTag,
      b1b1: String(this.localStorage.b1b1 ?? "1"),
      signCount: this.session.signCount,
      webBuild: String(this.release.webBuild ?? ""),
      signVersion: String(this.release.signVersion ?? "4.3.6"),
      appId: String(this.release.appId ?? "ugc"),
      platform: String(this.release.platform ?? "Windows"),
      userAgent: String(this.release.userAgent ?? ""),
      secChUa: String(this.release.secChUa ?? ""),
      dsProgram: String(this.dsProgram ?? ""),
    };
  }

  currentB1(timestampMs?: number, profileName?: string | null): string {
    if (this.fixedB1) return this.fixedB1;
    const timestamp = Math.floor(timestampMs ?? nowMs());
    if (profileName && !this.b1StateExplicit) {
      const key = String(profileName);
      const cached = this.namedB1Values.get(key);
      if (cached) return cached;
      let named = this.namedB1States.get(key);
      if (!named) {
        named = CreatorB1RuntimeState.reference(this.session.loadts, key);
        this.namedB1States.set(key, named);
      }
      let generatedAt = timestamp;
      if (named.generatedAtOffsetMs !== null && named.generatedAtOffsetMs !== undefined) {
        generatedAt = this.session.loadts + named.generatedAtOffsetMs;
      }
      const value = generateB1(named.toB1Options(generatedAt));
      this.namedB1Values.set(key, value);
      return value;
    }
    return generateB1(this.b1State.toB1Options(timestamp));
  }

  dslPair(timestampMs?: number): string {
    const timestamp = Math.floor(timestampMs ?? nowMs());
    const dsllt = this.session.ensureDsllt(timestamp);
    return `${dsllt};${this.dsl || "undefined"}`;
  }

  profileDataOptions(options: { timestampMs?: number; location?: string; referer?: string } = {}): Record<string, unknown> {
    const timestamp = Math.floor(options.timestampMs ?? nowMs());
    return {
      timestampMs: timestamp,
      timeOrigin: this.b1State.timeOriginMs,
      documentCookie: this.documentCookie,
      location: options.location ?? "https://creator.xiaohongshu.com/login",
      referer: options.referer ?? "https://creator.xiaohongshu.com/login",
      fields: { ...this.webProfileFields },
    };
  }

  stateSnapshot(): Record<string, unknown> {
    const state = this.session.snapshot();
    return {
      ...state,
      webBuild: String(this.release.webBuild ?? ""),
      xsecappid: String(this.release.appId ?? "ugc"),
      deviceTag: this.session.securityReady ? this.mnsStages.ready.deviceTag : this.mnsStages.bootstrap.deviceTag,
    };
  }
}
