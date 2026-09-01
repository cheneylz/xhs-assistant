/**
 * PC 请求参数与签名组装（对应原版 xhs_pc/params.py）
 */
import { randomUUID } from "node:crypto";
import { generateXB3Traceid, generateXrayTraceid, spliceStr } from "../core/params";
import { generateXRapParam, runSigner } from "../core/runtime";
import { orderedWireHeaders } from "../core/http";
import { transCookies } from "../core/util";

export const PC_LOGIN_ACCEPT_LANGUAGE = "zh-CN,zh;q=0.9";
export const PC_BUSINESS_ACCEPT_LANGUAGE = "zh-CN,zh;q=0.9,en;q=0.8,zh-TW;q=0.7,ja;q=0.6";
export const PC_SEC_CH_UA = '"Not;A=Brand";v="8", "Chromium";v="150", "Google Chrome";v="150"';

export const PC_NAVIGATION_HEADER_ORDER = [
  "upgrade-insecure-requests", "user-agent", "sec-ch-ua", "sec-ch-ua-mobile",
  "sec-ch-ua-platform", "accept", "accept-encoding", "accept-language",
  "cookie", "priority", "sec-fetch-dest", "sec-fetch-mode", "sec-fetch-site",
  "sec-fetch-user",
];
export const PC_HONEYPOT_HEADER_ORDER = [
  "sec-ch-ua-platform", "referer", "user-agent", "accept", "sec-ch-ua",
  "content-type", "sec-ch-ua-mobile", "accept-encoding", "accept-language",
  "cookie", "origin", "priority", "sec-fetch-dest", "sec-fetch-mode",
  "sec-fetch-site",
];
export const PC_SECURITY_HEADER_ORDER = [
  "sec-ch-ua-platform", "referer", "sec-ch-ua", "sec-ch-ua-mobile",
  "x-t", "x-s-common", "user-agent", "accept", "content-type", "x-s",
  "accept-encoding", "accept-language", "cookie", "origin", "priority",
  "sec-fetch-dest", "sec-fetch-mode", "sec-fetch-site",
];
export const PC_SEM_HEADER_ORDER = [
  "sec-ch-ua-platform", "referer", "sec-ch-ua", "sec-ch-ua-mobile",
  "x-t", "x-s-common", "user-agent", "accept", "x-s", "accept-encoding",
  "accept-language", "origin", "priority", "sec-fetch-dest",
  "sec-fetch-mode", "sec-fetch-site",
];
export const PC_SIGNED_POST_HEADER_ORDER = [
  "sec-ch-ua-platform", "referer", "sec-ch-ua", "x-xray-traceid",
  "sec-ch-ua-mobile", "x-t", "x-b3-traceid", "x-s-common",
  "user-agent", "accept", "content-type", "x-s", "accept-encoding",
  "accept-language", "cookie", "origin", "priority", "sec-fetch-dest",
  "sec-fetch-mode", "sec-fetch-site",
];
export const PC_SIGNED_GET_HEADER_ORDER = [
  "sec-ch-ua-platform", "referer", "sec-ch-ua", "x-xray-traceid",
  "sec-ch-ua-mobile", "x-t", "x-b3-traceid", "x-s-common",
  "user-agent", "accept", "x-s", "accept-encoding", "accept-language",
  "cookie", "origin", "priority", "sec-fetch-dest", "sec-fetch-mode",
  "sec-fetch-site",
];
export const PC_RAP_POST_HEADER_ORDER = [
  "sec-ch-ua-platform", "referer", "sec-ch-ua", "x-xray-traceid",
  "sec-ch-ua-mobile", "x-t", "x-b3-traceid", "x-s-common",
  "x-rap-param", "accept", "content-type", "x-s", "user-agent",
  "accept-encoding", "accept-language", "cookie", "origin", "priority",
  "sec-fetch-dest", "sec-fetch-mode", "sec-fetch-site",
];
export const PC_XY_RAP_POST_HEADER_ORDER = ["sec-ch-ua-platform", "xy-direction", ...PC_RAP_POST_HEADER_ORDER.slice(1)];
export const PC_RAP_GET_HEADER_ORDER = [
  "sec-ch-ua-platform", "referer", "sec-ch-ua", "x-xray-traceid",
  "sec-ch-ua-mobile", "x-t", "x-rap-param", "x-b3-traceid",
  "x-s-common", "user-agent", "accept", "x-s", "accept-encoding",
  "accept-language", "cookie", "origin", "priority", "sec-fetch-dest",
  "sec-fetch-mode", "sec-fetch-site",
];

/** 按接口解析 mnsv2 档位（对应 resolve_mns_tier） */
export function resolveMnsTier(api: string, fingerprintReady = true): string {
  const a = String(api ?? "");
  if (fingerprintReady) return "0301";
  if (a.includes("/api/sec/v1/") || a.includes("/api/redcaptcha/") || a.includes("sem_sdk")) return "0201";
  return "0101";
}

const BASE36_CHARS = "0123456789abcdefghijklmnopqrstuvwxyz";

export function intToBase36BigInt(value: bigint): string {
  if (value === 0n) return "0";
  let result = "";
  let current = value;
  const base = 36n;
  while (current) {
    const remainder = Number(current % base);
    current = current / base;
    result = BASE36_CHARS[remainder] + result;
  }
  return result;
}

/** 生成 search_id（对应 generate_search_id，timestamp<<64 + random 转 base36） */
export function generateSearchId(rootSearchId?: string | null): string {
  if (rootSearchId) return rootSearchId;
  const timestampMs = BigInt(Date.now());
  const randomPart = BigInt(Math.ceil(0x7ffffffe * Math.random()));
  return intToBase36BigInt((timestampMs << 64n) + randomPart);
}

/** 生成 search_request_id（对应 generate_search_request_id） */
export function generateSearchRequestId(): string {
  const timestampMs = Date.now();
  const randomPart = Math.ceil(0x7ffffffe * Math.random());
  return `${randomPart}-${timestampMs}`;
}

/** 生成 search_session_id（UUIDv4，对应 generate_search_session_id） */
export function generateSearchSessionId(): string {
  return randomUUID();
}

export interface XsSignContext extends Record<string, unknown> {
  tier?: string;
  [key: string]: unknown;
}

/** 仅生成 X-s/X-t（无 X-S-Common 的接口，如蒲公英，对应 generate_xs） */
export function generateXs(
  a1: string,
  api: string,
  data: unknown = "",
  _method = "POST",
  options: { cookie?: string; tier?: string | null; signContext?: Record<string, unknown> } = {},
): [string, string] {
  const { cookie = "", tier = null, signContext } = options;
  if (!cookie || !cookie.includes("a1=")) throw new Error("generate_xs: cookie 须含 a1");
  if (!signContext) throw new Error("generate_xs: sign_context 必传");
  const resolvedTier = tier || signContext.tier || resolveMnsTier(api);
  const result = runSigner({
    api,
    data,
    a1,
    cookie,
    b1: "",
    dslPair: "",
    tier: String(resolvedTier),
    ...signContext,
  });
  if (!result || !result.xs) throw new Error(`JS X-s 生成失败（档位 mns${resolvedTier}_）`);
  return [String(result.xs), String(result.xt ?? Math.floor(Date.now()).toString())];
}

/** 生成 X-s / X-t / X-S-Common（对应 generate_xs_xs_common） */
export function generateXsXsCommon(
  a1: string,
  api: string,
  data: unknown = "",
  _method = "POST",
  options: { b1?: string | null; dslPair?: string | null; cookie?: string; tier?: string | null; signContext?: Record<string, unknown> } = {},
): [string, string, string] {
  const { cookie = "", tier = null, signContext } = options;
  let { b1 = null, dslPair = null } = options;
  if (!cookie || !cookie.includes("a1=")) throw new Error("generate_xs_xs_common: cookie(document.cookie 含 a1) 必传");
  if (b1 === null || b1 === undefined) throw new Error("generate_xs_xs_common: b1 必须显式传入（允许空字符串）");
  if (!dslPair || !String(dslPair).includes(";")) throw new Error("generate_xs_xs_common: dsl_pair 必传，格式 dsllt;_dsl");
  if (!signContext) throw new Error("generate_xs_xs_common: sign_context 必传（PcDeviceProfile 会话状态）");
  b1 = String(b1);
  dslPair = String(dslPair);
  const resolvedTier = tier || signContext.tier || resolveMnsTier(api);
  const result = runSigner({
    api,
    data,
    a1,
    cookie,
    b1,
    dslPair,
    tier: String(resolvedTier),
    ...signContext,
  });
  if (!result || !result.xs) {
    throw new Error(`JS mnsv2 签名失败或未达到硬门禁（档位 mns${resolvedTier}_，无短签/静态兜底）`);
  }
  const xs = String(result.xs);
  const xt = String(result.xt ?? Math.floor(Date.now()).toString());
  const xsCommon = String(result.xs_common ?? "");
  if (!xsCommon) throw new Error("JS X-S-Common 生成失败（缺 b1/dsl_pair 或运行时异常）");
  return [xs, xt, xsCommon];
}

/** x-rap-param（对应 generate_x_rap_param） */
export function generateXRapParamValue(api: string, data: unknown, appId?: string | null, fingerprintHex = ""): string {
  return generateXRapParam(api, data, fingerprintHex);
}

/** 通用请求头（对应 get_common_headers） */
export function getCommonHeaders(): Record<string, string> {
  return {
    "upgrade-insecure-requests": "1",
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
    "sec-ch-ua": PC_SEC_CH_UA,
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
    "accept-language": PC_LOGIN_ACCEPT_LANGUAGE,
    priority: "u=0, i",
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "none",
    "sec-fetch-user": "?1",
  };
}

/** xy-direction（murmurHash3_32(userId, 151488) % 100 + 1，对应 generate_xy_direction） */
export function generateXyDirection(userId: string): number {
  if (!userId) return 0;
  return (murmurHash3_32(userId, 151488) % 100) + 1;
}

/** murmurHash3_32（对齐小红书 index.bundle 实现） */
export function murmurHash3_32(key: string, seed = 0): number {
  const data = Buffer.from(key, "utf-8");
  const length = data.length;
  let h = seed >>> 0;
  const nblocks = Math.floor(length / 4);
  for (let i = 0; i < nblocks; i++) {
    let k = (data[4 * i] | (data[4 * i + 1] << 8) | (data[4 * i + 2] << 16) | (data[4 * i + 3] << 24)) >>> 0;
    k = Math.imul(k, 0xcc9e2d51) >>> 0;
    k = ((k << 15) | (k >>> 17)) >>> 0;
    k = Math.imul(k, 0x1b873593) >>> 0;
    h ^= k;
    h = ((h << 13) | (h >>> 19)) >>> 0;
    h = (Math.imul(h, 5) + 0xe6546b64) >>> 0;
  }
  const tailIndex = 4 * nblocks;
  let k = 0;
  const rem = length % 4;
  if (rem === 3) k ^= data[tailIndex + 2] << 16;
  if (rem >= 2) k ^= data[tailIndex + 1] << 8;
  if (rem >= 1) {
    k ^= data[tailIndex];
    k = Math.imul(k, 0xcc9e2d51) >>> 0;
    k = ((k << 15) | (k >>> 17)) >>> 0;
    k = Math.imul(k, 0x1b873593) >>> 0;
    h ^= k;
  }
  h ^= length;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

const DEFAULT_PC_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";

/** 请求头模板（对应 get_request_headers_template） */
export function getRequestHeadersTemplate(
  signContext?: Record<string, unknown> | null,
  options: { method?: string; acceptLanguage?: string; hasBody?: boolean | null } = {},
): Record<string, string> {
  const context = signContext ?? {};
  const userAgent = String(context.userAgent ?? DEFAULT_PC_USER_AGENT);
  const headers: Record<string, string> = {
    "sec-ch-ua-platform": '"Windows"',
    referer: "https://www.xiaohongshu.com/",
    "sec-ch-ua": String(context.secChUa ?? PC_SEC_CH_UA),
    "x-xray-traceid": generateXrayTraceid(),
    "sec-ch-ua-mobile": "?0",
    "x-t": "",
    "x-b3-traceid": "",
    "x-s-common": "",
    "user-agent": userAgent,
    accept: "application/json, text/plain, */*",
    "x-s": "",
    "accept-language": options.acceptLanguage ?? PC_BUSINESS_ACCEPT_LANGUAGE,
    origin: "https://www.xiaohongshu.com",
    priority: "u=1, i",
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-site",
  };
  const hasBody = options.hasBody ?? String(options.method ?? "POST").toUpperCase() !== "GET";
  if (hasBody) headers["content-type"] = "application/json;charset=UTF-8";
  return headers;
}

function withContentTypeTrim(order: string[], headers: Record<string, unknown>): string[] {
  const hasContentType = Object.keys(headers).some((key) => key.toLowerCase() === "content-type");
  return hasContentType ? order : order.filter((key) => key !== "content-type");
}

/** 导航请求头（对应 build_pc_navigation_headers） */
export function buildPcNavigationHeaders(headers: Record<string, unknown>, cookies?: unknown): Record<string, string> {
  return orderedWireHeaders(headers, { order: PC_NAVIGATION_HEADER_ORDER, cookies, optional: ["cookie"] });
}

/** 登录请求头（对应 build_pc_login_headers） */
export function buildPcLoginHeaders(
  headers: Record<string, unknown>,
  cookies?: unknown,
  options: { kind?: "post" | "get" | "honeypot" | "security" | "sem" | "get-login-mode" } = {},
): Record<string, string> {
  const { kind = "post" } = options;
  let order = PC_SIGNED_POST_HEADER_ORDER;
  if (kind === "honeypot") order = PC_HONEYPOT_HEADER_ORDER;
  else if (kind === "security") order = PC_SECURITY_HEADER_ORDER;
  else if (kind === "sem") order = PC_SEM_HEADER_ORDER;
  else if (kind === "get") order = PC_SIGNED_GET_HEADER_ORDER;
  else if (kind === "get-login-mode") order = ["sec-ch-ua-platform", "x-login-mode", ...PC_SIGNED_GET_HEADER_ORDER.slice(1)];
  order = withContentTypeTrim(order, headers);
  return orderedWireHeaders(headers, { order, cookies });
}

/** 业务请求头（对应 build_pc_business_headers） */
export function buildPcBusinessHeaders(
  headers: Record<string, unknown>,
  cookies: unknown,
  options: { api: string; method?: string },
): Record<string, string> {
  const upperMethod = String(options.method ?? "POST").toUpperCase();
  const headerNames = new Set(Object.keys(headers).map((k) => k.toLowerCase()));
  const hasRap = headerNames.has("x-rap-param");
  const hasXy = headerNames.has("xy-direction");
  let order: string[];
  if (hasXy) order = PC_XY_RAP_POST_HEADER_ORDER;
  else if (hasRap && upperMethod === "GET") order = PC_RAP_GET_HEADER_ORDER;
  else if (hasRap) order = PC_RAP_POST_HEADER_ORDER;
  else if (upperMethod === "GET") order = PC_SIGNED_GET_HEADER_ORDER;
  else order = PC_SIGNED_POST_HEADER_ORDER;
  order = withContentTypeTrim(order, headers);
  return orderedWireHeaders(headers, { order, cookies });
}

/** 生成完整签名请求头（对应 generate_headers） */
export function generateHeaders(
  a1: string,
  api: string,
  data: unknown = "",
  method = "POST",
  options: {
    userId?: string;
    cookie?: string;
    b1?: string | null;
    dslPair?: string | null;
    withXyDirection?: boolean;
    tier?: string | null;
    signContext?: Record<string, unknown>;
  } = {},
): [Record<string, string>, unknown] {
  const { userId = "", cookie = "", tier = null, signContext, withXyDirection = false } = options;
  let { b1 = null, dslPair = null } = options;
  const [xs, xt, xsCommon] = generateXsXsCommon(a1, api, data, method, { b1, dslPair, cookie, tier, signContext });
  const xB3Traceid = generateXB3Traceid();
  const hasBody = data !== "" && data !== null && data !== undefined;
  const headers = getRequestHeadersTemplate(signContext, { method, hasBody });
  headers["x-s"] = xs;
  headers["x-t"] = String(xt);
  headers["x-s-common"] = xsCommon;
  headers["x-b3-traceid"] = xB3Traceid;
  if (withXyDirection) {
    if (!userId) throw new Error("generate_headers: 该接口需要 xy-direction，user_id 必传");
    headers["xy-direction"] = String(generateXyDirection(userId));
  }
  let normalizedData: unknown = "";
  if (data === "" || data === null || data === undefined) normalizedData = "";
  else if (typeof data === "string") normalizedData = data;
  else normalizedData = JSON.stringify(data);
  return [headers, normalizedData];
}

/** 生成请求参数（对应 generate_request_params） */
export function generateRequestParams(
  cookiesStr: string,
  api: string,
  data: unknown = "",
  method = "POST",
  options: {
    userId?: string;
    b1?: string | null;
    dslPair?: string | null;
    docCookie?: string;
    withXyDirection?: boolean;
    tier?: string | null;
    signContext?: Record<string, unknown>;
  } = {},
): [Record<string, string>, Record<string, string>, unknown] {
  const { userId = "", docCookie = "", tier = null, signContext, withXyDirection = false } = options;
  let { b1 = null, dslPair = null } = options;
  const signCookie = docCookie || cookiesStr;
  if (!signCookie || !signCookie.includes("a1=")) {
    throw new Error("generate_request_params: cookies 须含 a1（Network Cookie 或 document.cookie）");
  }
  if (b1 === null || b1 === undefined) throw new Error("generate_request_params: b1 必须显式传入（允许空字符串）");
  if (!dslPair || !String(dslPair).includes(";")) throw new Error("generate_request_params: dsl_pair 必传");
  if (withXyDirection && !userId) throw new Error("generate_request_params: 该接口需要 xy-direction，user_id 必传");
  const cookies = transCookies(cookiesStr);
  if (!cookies.a1) throw new Error("generate_request_params: cookies_str 须含 a1");
  const a1 = cookies.a1;
  const [headers, normalizedData] = generateHeaders(a1, api, data, method, {
    userId,
    cookie: signCookie,
    b1,
    dslPair,
    withXyDirection,
    tier,
    signContext,
  });
  return [headers, cookies, normalizedData];
}

export { spliceStr };
