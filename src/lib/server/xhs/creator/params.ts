/**
 * Creator 请求签名与浏览器形态请求头（对应原版 xhs_creator/params.py）
 */
import { generateXB3Traceid, generateXrayTraceid } from "../core/params";
import { orderedWireHeaders } from "../core/http";
import { runSigner } from "./runtime";
import type { CreatorDeviceProfile } from "./state";
import type { XHSCreatorAuth } from "./auth";

export const CREATOR_SEC_CH_UA = '"Not;A=Brand";v="8", "Chromium";v="150", "Google Chrome";v="150"';

export const CREATOR_NAVIGATION_HEADER_ORDER = [
  "upgrade-insecure-requests", "user-agent", "sec-ch-ua", "sec-ch-ua-mobile",
  "sec-ch-ua-platform", "accept", "accept-encoding", "accept-language",
  "cookie", "priority", "sec-fetch-dest", "sec-fetch-mode", "sec-fetch-site",
  "sec-fetch-user",
];
export const CREATOR_HONEYPOT_HEADER_ORDER = [
  "referer", "user-agent", "accept", "content-type", "accept-encoding",
  "accept-language", "cookie", "origin", "priority", "sec-fetch-dest",
  "sec-fetch-mode", "sec-fetch-site",
];
export const CREATOR_REDCAPTCHA_HEADER_ORDER = [
  "referer", "x-xray-traceid", "x-t", "x-b3-traceid", "x-s-common",
  "user-agent", "accept", "content-type", "x-s", "accept-encoding",
  "accept-language", "cookie", "origin", "priority", "sec-fetch-dest",
  "sec-fetch-mode", "sec-fetch-site",
];
export const CREATOR_SECURITY_HEADER_ORDER = [
  "authorization", "referer", "x-t", "x-s-common", "user-agent", "accept",
  "content-type", "x-s", "accept-encoding", "accept-language", "cookie",
  "origin", "priority", "sec-fetch-dest", "sec-fetch-mode", "sec-fetch-site",
];
export const CREATOR_SIGNED_GET_HEADER_ORDER = [
  "authorization", "referer", "x-xray-traceid", "x-t", "x-b3-traceid",
  "x-s-common", "user-agent", "accept", "x-s", "accept-encoding",
  "accept-language", "cookie", "priority", "sec-fetch-dest",
  "sec-fetch-mode", "sec-fetch-site",
];
export const CREATOR_SIGNED_POST_HEADER_ORDER = [
  "authorization", "referer", "x-xray-traceid", "x-t", "x-b3-traceid",
  "x-s-common", "user-agent", "accept", "content-type", "x-s",
  "accept-encoding", "accept-language", "cookie", "origin", "priority",
  "sec-fetch-dest", "sec-fetch-mode", "sec-fetch-site",
];
export const CREATOR_CAS_GET_HEADER_ORDER = [
  "authorization", "referer", "x-t", "x-s-common", "user-agent", "accept",
  "x-ratelimit-meta", "x-s", "accept-encoding", "accept-language",
  "cookie", "origin", "priority", "sec-fetch-dest", "sec-fetch-mode",
  "sec-fetch-site",
];
export const CREATOR_CAS_POST_HEADER_ORDER = [
  "authorization", "referer", "x-t", "x-s-common", "user-agent", "accept",
  "x-ratelimit-meta", "content-type", "x-s", "accept-encoding",
  "accept-language", "cookie", "origin", "priority", "sec-fetch-dest",
  "sec-fetch-mode", "sec-fetch-site",
];
export const CREATOR_CAS_GET_NO_RATE_HEADER_ORDER = [
  "authorization", "referer", "x-t", "x-s-common", "user-agent", "accept",
  "x-s", "accept-encoding", "accept-language", "cookie", "origin", "priority",
  "sec-fetch-dest", "sec-fetch-mode", "sec-fetch-site",
];
export const CREATOR_CAS_POST_NO_RATE_HEADER_ORDER = [
  "authorization", "referer", "x-t", "x-s-common", "user-agent", "accept",
  "content-type", "x-s", "accept-encoding", "accept-language", "cookie",
  "origin", "priority", "sec-fetch-dest", "sec-fetch-mode", "sec-fetch-site",
];
export const CREATOR_LOGIN_USER_INFO_HEADER_ORDER = [
  "authorization", "referer", "x-xray-traceid", "x-t", "x-b3-traceid",
  "x-s-common", "user-agent", "accept", "content-type", "x-s",
  "accept-encoding", "accept-language", "cookie", "priority",
  "sec-fetch-dest", "sec-fetch-mode", "sec-fetch-site",
];

const DEFAULT_CREATOR_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";

export function buildCreatorNavigationHeaders(headers: Record<string, unknown>, cookies?: unknown): Record<string, string> {
  return orderedWireHeaders(headers, { order: CREATOR_NAVIGATION_HEADER_ORDER, cookies, optional: ["cookie"] });
}

export function buildCreatorLoginHeaders(
  headers: Record<string, unknown>,
  cookies?: unknown,
  options: { kind?: "security" | "honeypot" | "redcaptcha" | "get" | "cas-get" | "cas-post" | "cas-get-no-rate" | "cas-post-no-rate" | "login-user-info" } = {},
): Record<string, string> {
  const { kind = "security" } = options;
  const orders: Record<string, string[]> = {
    honeypot: CREATOR_HONEYPOT_HEADER_ORDER,
    redcaptcha: CREATOR_REDCAPTCHA_HEADER_ORDER,
    get: CREATOR_SIGNED_GET_HEADER_ORDER,
    "cas-get": CREATOR_CAS_GET_HEADER_ORDER,
    "cas-post": CREATOR_CAS_POST_HEADER_ORDER,
    "cas-get-no-rate": CREATOR_CAS_GET_NO_RATE_HEADER_ORDER,
    "cas-post-no-rate": CREATOR_CAS_POST_NO_RATE_HEADER_ORDER,
    "login-user-info": CREATOR_LOGIN_USER_INFO_HEADER_ORDER,
  };
  const order = orders[kind] ?? CREATOR_SECURITY_HEADER_ORDER;
  return orderedWireHeaders(headers, { order, cookies });
}

export function buildCreatorBusinessHeaders(
  headers: Record<string, unknown>,
  cookies?: unknown,
  options: { method?: string } = {},
): Record<string, string> {
  if (Object.keys(headers).some((key) => key.toLowerCase() === "x-rap-param")) {
    throw new Error("Creator RAP Header order is not verified by this builder");
  }
  const order = String(options.method ?? "GET").toUpperCase() === "GET" ? CREATOR_SIGNED_GET_HEADER_ORDER : CREATOR_SIGNED_POST_HEADER_ORDER;
  return orderedWireHeaders(headers, { order, cookies });
}

/** Creator CAS 保持 URL scheme 冒号不转义（对应 splice_str） */
export function spliceStrCreator(api: string, params: Record<string, unknown>): string {
  const query = Object.entries(params)
    .map(([key, value]) => `${encodeURIComponent(key)}=${value === null || value === undefined ? "" : encodeURIComponent(String(value)).replace(/%3A/g, ":")}`)
    .join("&");
  return `${api}?${query}`;
}

/** Creator 请求头模板（对应 get_request_headers_template） */
export function getRequestHeadersTemplate(
  signContext?: Record<string, unknown> | null,
  options: {
    method?: string;
    origin?: string;
    referer?: string;
    secFetchSite?: string;
    includeClientHints?: boolean;
    includeTraceHeaders?: boolean;
    includeAuthorization?: boolean;
    includeOrigin?: boolean | null;
  } = {},
): Record<string, string> {
  const context = signContext ?? {};
  const method = String(options.method ?? "POST").toUpperCase();
  const headers: Record<string, string> = {
    "user-agent": String(context.userAgent ?? DEFAULT_CREATOR_USER_AGENT),
    accept: "application/json, text/plain, */*",
    "accept-language": "zh-CN,zh;q=0.9,en;q=0.8,zh-TW;q=0.7,ja;q=0.6",
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": options.secFetchSite ?? "same-site",
    referer: options.referer ?? "https://creator.xiaohongshu.com/",
    priority: "u=1, i",
  };
  if (options.includeAuthorization !== false) headers.authorization = "";
  if (options.includeTraceHeaders !== false) {
    headers["x-b3-traceid"] = generateXB3Traceid();
    headers["x-xray-traceid"] = generateXrayTraceid();
  }
  const includeOrigin = options.includeOrigin ?? method !== "GET";
  if (includeOrigin) headers.origin = options.origin ?? "https://creator.xiaohongshu.com";
  if (method !== "GET") headers["content-type"] = "application/json";
  if (options.includeClientHints !== false) {
    headers["sec-ch-ua"] = String(context.secChUa ?? CREATOR_SEC_CH_UA);
    headers["sec-ch-ua-mobile"] = "?0";
    headers["sec-ch-ua-platform"] = '"Windows"';
  }
  return headers;
}

export interface CreatorRequestParamsOptions {
  tier?: string | null;
  b1Profile?: string | null;
  mnsProfile?: string | null;
  origin?: string;
  referer?: string;
  secFetchSite?: string;
  includeClientHints?: boolean;
  includeTraceHeaders?: boolean;
  includeAuthorization?: boolean;
  includeOrigin?: boolean | null;
  b1Value?: string | null;
  dslPairValue?: string | null;
}

/** Creator 签名请求参数（对应 generate_request_params） */
export async function generateRequestParams(
  auth: XHSCreatorAuth,
  api: string,
  data: unknown = "",
  method = "POST",
  options: CreatorRequestParamsOptions = {},
): Promise<[Record<string, string>, Record<string, string>, string]> {
  auth.validate(true);
  const [, material] = auth.profile.resolveMnsMaterial({ tier: options.tier ?? null, mnsProfile: options.mnsProfile ?? null });
  // Creator 首个 note-manager 请求是 deviceTag=nop 的 MNS0101 冷路径，
  // 直接签 URL MD5，不得在请求发出前激活通用 DS 程序
  if (material.deviceTag !== "nop") {
    await auth.ensureDsMaterial();
  }
  return generateProfileRequestParams(auth.profile, api, data, method, options);
}

/** 低层签名（匿名 QR/SMS 初始化时使用，对应 generate_profile_request_params） */
export function generateProfileRequestParams(
  profile: CreatorDeviceProfile,
  api: string,
  data: unknown = "",
  method = "POST",
  options: CreatorRequestParamsOptions = {},
): [Record<string, string>, Record<string, string>, string] {
  const cookies = profile.cookieMap;
  if (!cookies.a1) throw new Error("Creator profile Cookie must contain a1");
  const context = profile.nextSignContext({ tier: options.tier ?? null, mnsProfile: options.mnsProfile ?? null });
  const b1 =
    options.b1Value !== undefined && options.b1Value !== null
      ? String(options.b1Value)
      : profile.currentB1(Number(context.now), options.b1Profile ?? null);
  const dslPair =
    options.dslPairValue !== undefined && options.dslPairValue !== null
      ? String(options.dslPairValue)
      : profile.dslPair(Number(context.now));
  const result = runSigner({
    api,
    data,
    cookie: Object.entries(cookies)
      .map(([key, value]) => `${key}=${value}`)
      .join("; "),
    a1: cookies.a1,
    b1,
    dslPair,
    tier: String(context.tier),
    ...context,
  });
  if (!result.xs || !result.xs_common) {
    throw new Error("Creator signer gate failed: missing xs/xs_common");
  }
  const headers = getRequestHeadersTemplate(context, {
    method,
    origin: options.origin,
    referer: options.referer,
    secFetchSite: options.secFetchSite,
    includeClientHints: options.includeClientHints,
    includeTraceHeaders: options.includeTraceHeaders,
    includeAuthorization: options.includeAuthorization,
    includeOrigin: options.includeOrigin,
  });
  headers["x-s"] = String(result.xs);
  headers["x-t"] = String(result.xt ?? Math.floor(Date.now()).toString());
  headers["x-s-common"] = String(result.xs_common);
  let body = "";
  if (data === "" || data === null || data === undefined) body = "";
  else if (typeof data === "string") body = data;
  else body = JSON.stringify(data);
  return [headers, cookies, body];
}

/** 仅取签名头（对应 generate_xsc） */
export async function generateXsc(
  auth: XHSCreatorAuth,
  api: string,
  data: unknown = "",
  method = "POST",
  options: CreatorRequestParamsOptions = {},
): Promise<Record<string, string>> {
  const [headers] = await generateRequestParams(auth, api, data, method, options);
  const result: Record<string, string> = {};
  for (const key of ["x-s", "x-t", "x-s-common", "x-b3-traceid", "x-xray-traceid"]) {
    if (headers[key]) result[key] = headers[key];
  }
  return result;
}
