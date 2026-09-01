/**
 * PC 端 API（对应原版 XHS_ALL_IN_ONE/apis/xhs_pc_apis.py）
 *
 * 鉴权与动态签名材料全部走 XHSPcAuth，接口不再散传 cookies/b1/dsl/user_id。
 *
 *   const auth = XHSPcAuth.fromCookie(xhrCookie, { b1, dsl });
 *   const apis = new XhsPcApis(auth);
 *   await apis.bootstrap();              // 自动填入 auth.userId（算 xy-direction 用）
 *   await apis.getUnreadMessage();
 */
import { XHSPcAuth } from "./auth";
import { PcHttpClient } from "./http";
import {
  buildPcBusinessHeaders,
  buildPcNavigationHeaders,
  generateRequestParams,
  generateSearchId,
  generateSearchRequestId,
  generateSearchSessionId,
  generateXRapParamValue,
  getCommonHeaders,
  spliceStr,
} from "./params";

/** 请求超时（与原版 REQUEST_TIMEOUT=15 一致；本传输层按毫秒计） */
const REQUEST_TIMEOUT = 15 * 1000;

/** 通用 JSON 对象（对齐 Python dict 语义） */
export type JsonObject = Record<string, any>;

/** 代理配置（对齐 requests proxies 语义） */
type Proxies = Record<string, string> | null | undefined;

// RAP 白名单（浏览器实抓：需 x-rap-param）
const RAP_PATH_MARKERS = [
  "api/sns/web/v1/homefeed",
  "api/sns/web/v1/search/notes",
  "api/sns/web/v2/search/notes",
  "api/sns/web/v1/user_posted",
  "api/sns/web/v1/feed",
  "api/sns/web/v1/comment/post",
];
// 浏览器实抓：仅这些接口带 xy-direction
const XY_PATH_MARKERS = ["api/sns/web/v1/homefeed", "api/sns/web/v1/feed"];

/** 记录 API 请求异常（对应 _log_api_error） */
function logApiError(error: unknown): string {
  console.error(`XHS PC API request failed: ${error instanceof Error ? error.message : String(error)}`);
  return error instanceof Error ? error.message : String(error);
}

/** 解析 URL（对齐 urllib.parse.urlparse：不抛错，兼容无 scheme 输入） */
function parseUrlCompat(input: string): { path: string; query: string } {
  try {
    const parsed = new URL(String(input));
    return { path: parsed.pathname, query: parsed.search.replace(/^\?/, "") };
  } catch {
    const text = String(input ?? "");
    const queryIndex = text.indexOf("?");
    if (queryIndex >= 0) {
      return { path: text.slice(0, queryIndex), query: text.slice(queryIndex + 1) };
    }
    return { path: text, query: "" };
  }
}

/** 解析查询参数（对应 urllib.parse.parse_qs：keep_blank_values=True，同名键取最后一个值） */
function getQueryParams(query: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!query) return result;
  for (const part of query.split("&")) {
    if (!part) continue;
    const index = part.indexOf("=");
    const rawKey = index >= 0 ? part.slice(0, index) : part;
    const rawValue = index >= 0 ? part.slice(index + 1) : "";
    result[decodeComponent(rawKey)] = decodeComponent(rawValue);
  }
  return result;
}

/** 解码查询组件（parse_qs 会把 + 视为空格，且容忍非法百分号序列） */
function decodeComponent(value: string): string {
  const text = value.replace(/\+/g, " ");
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** 取 path 最后一段（对齐 urlParse.path.split("/")[-1]） */
function lastPathSegment(path: string): string {
  const parts = path.split("/");
  return parts.length ? parts[parts.length - 1] : "";
}

export class XhsPcApis {
  auth: XHSPcAuth;
  http: PcHttpClient;
  baseUrl: string;
  soBaseUrl: string;

  constructor(auth: XHSPcAuth) {
    if (!(auth instanceof XHSPcAuth)) {
      throw new TypeError("XhsPcApis 当前仅支持 XHSPcAuth，其它平台鉴权类后续扩展");
    }
    this.auth = auth;
    this.http = auth.httpClient;
    this.baseUrl = auth.origin("api");
    this.soBaseUrl = auth.origin("search");
  }

  /** 调 user/me 写入 auth.userId（算 xy-direction 用），失败抛错（对应 bootstrap） */
  async bootstrap(proxies: Proxies = null): Promise<this> {
    const [success, msg, res] = await this.getUserMe(proxies);
    if (!success) throw new Error(`bootstrap user/me failed: ${msg}`);
    const uid = String(((res ?? {})["data"] ?? {})["user_id"] ?? "");
    if (!uid) throw new Error("bootstrap: user/me 未返回 user_id");
    this.auth.setUserId(uid);
    return this;
  }

  _proxies(proxies: Proxies = null): Proxies {
    return proxies !== null && proxies !== undefined ? proxies : this.auth.proxies;
  }

  /** 该接口是否需要 x-rap-param（对应 _needs_rap） */
  static _needsRap(api: string): boolean {
    const path = String(api ?? "").split("?", 1)[0].replace(/\/+$/, "").replace(/^\/+/, "");
    for (const marker of RAP_PATH_MARKERS) {
      if (marker.includes("user_posted")) {
        if (path.includes(marker)) return true;
      } else if (path === marker) {
        return true;
      }
    }
    return false;
  }

  /** 该接口是否需要 xy-direction（对应 _needs_xy） */
  static _needsXy(api: string): boolean {
    const path = String(api ?? "").split("?", 1)[0].replace(/\/+$/, "").replace(/^\/+/, "");
    return XY_PATH_MARKERS.includes(path);
  }

  /**
   * 按浏览器实抓组装请求头、Cookie 与线上 body（对应 _request_params）：
   * 必有: x-s / x-t / x-s-common / x-b3-traceid / x-xray-traceid
   * 条件: x-rap-param（RAP 白名单）、xy-direction（仅 homefeed/feed）
   * 无 x-mns（浏览器 edith 业务请求未带）
   * tier: null → 按 resolveMnsTier(api) 自动选档（爬虫内容接口=mns0301，与真机
   *       稳态一致、服务端接受）；个别接口如需强制档位可显式传 "0201"/"0101"。
   */
  async _requestParams(
    api: string,
    data: unknown = "",
    method = "POST",
    tier: string | null = null,
    options: { targetOrigin?: string | null } = {},
  ): Promise<[Record<string, string>, Record<string, string>, unknown]> {
    this.auth.validate(false);
    if (XhsPcApis._needsXy(api) && !this.auth.userId) {
      await this.bootstrap();
    }
    const signContext = this.auth.nextSignContext(api, { tier: tier ?? null });
    const b1 = this.auth.currentB1(Number(signContext["now"]));
    const dslPair = await this.auth.dslPair();
    let headers: Record<string, string>;
    let cookies: Record<string, string>;
    let body: unknown;
    [headers, cookies, body] = generateRequestParams(this.auth.cookies, api, data, method, {
      userId: this.auth.userId,
      b1,
      dslPair,
      docCookie: this.auth.signCookie,
      withXyDirection: XhsPcApis._needsXy(api),
      tier: String(signContext["tier"]),
      signContext,
    });
    delete headers["x-mns"];
    if (XhsPcApis._needsRap(api)) {
      headers["x-rap-param"] = generateXRapParamValue(
        api,
        body || "",
        String(this.auth.profile.release["appId"] ?? ""),
        this.auth.profile.rapFingerprintHex,
      );
    } else if ("x-rap-param" in headers) {
      delete headers["x-rap-param"];
    }
    const target = (options.targetOrigin ?? this.baseUrl) + api;
    const wireCookies = this.auth.cookiesForUrl(target, cookies);
    headers = buildPcBusinessHeaders(headers, wireCookies, { api, method });
    return [headers, wireCookies, body];
  }

  /** 获取主页的所有频道（对应 get_homefeed_all_channel） */
  async getHomefeedAllChannel(proxies: Proxies = null): Promise<[boolean, string, JsonObject | null]> {
    let resJson: JsonObject | null = null;
    let success = false;
    let msg = "";
    try {
      const api = "/api/sns/web/v1/homefeed/category";
      const [headers, cookies] = await this._requestParams(api, "", "GET");
      const response = await this.http.get(this.baseUrl + api, {
        headers,
        cookies,
        proxies: this._proxies(proxies),
        timeout: REQUEST_TIMEOUT,
      });
      resJson = response.json<JsonObject>();
      success = Boolean(resJson["success"]);
      msg = String(resJson["msg"]);
    } catch (error) {
      success = false;
      msg = logApiError(error);
    }
    return [success, msg, resJson];
  }

  /**
   * 获取主页推荐的笔记（对应 get_homefeed_recommend）
   * @param category 你想要获取的频道
   * @param cursorScore 你想要获取的笔记的 cursor
   * @param refreshType 你想要获取的笔记的刷新类型
   * @param noteIndex 你想要获取的笔记的 index
   * @param num 单次候选数量；页面会按视口/阶段动态调整
   * @param needNum 单次期望返回数量；页面会按视口/阶段动态调整
   */
  async getHomefeedRecommend(
    category: string,
    cursorScore: string,
    refreshType: number,
    noteIndex: number,
    proxies: Proxies = null,
    options: { num?: number; needNum?: number } = {},
  ): Promise<[boolean, string, JsonObject | null]> {
    let resJson: JsonObject | null = null;
    let success = false;
    let msg = "";
    try {
      const api = "/api/sns/web/v1/homefeed";
      const data = {
        cursor_score: cursorScore,
        num: Math.floor(options.num ?? 20),
        refresh_type: refreshType,
        note_index: noteIndex,
        unread_begin_note_id: "",
        unread_end_note_id: "",
        unread_note_count: 0,
        category,
        search_key: "",
        need_num: Math.floor(options.needNum ?? 10),
        image_formats: ["jpg", "webp", "avif"],
        need_filter_image: false,
      };
      const [headers, cookies, transData] = await this._requestParams(api, data, "POST");
      const response = await this.http.post(this.baseUrl + api, {
        headers,
        data: String(transData),
        cookies,
        proxies: this._proxies(proxies),
        timeout: REQUEST_TIMEOUT,
      });
      resJson = response.json<JsonObject>();
      success = Boolean(resJson["success"]);
      msg = String(resJson["msg"]);
    } catch (error) {
      success = false;
      msg = logApiError(error);
    }
    return [success, msg, resJson];
  }

  /**
   * 根据数量获取主页推荐的笔记（对应 get_homefeed_recommend_by_num）
   * @param category 你想要获取的频道
   * @param requireNum 你想要获取的笔记的数量
   */
  async getHomefeedRecommendByNum(category: string, requireNum: number, proxies: Proxies = null): Promise<[boolean, string, JsonObject[]]> {
    let cursorScore = "";
    let refreshType = 1;
    let noteIndex = 0;
    let noteList: JsonObject[] = [];
    let success = false;
    let msg = "";
    try {
      while (true) {
        const [ok, message, resJson] = await this.getHomefeedRecommend(category, cursorScore, refreshType, noteIndex, proxies);
        if (!ok) throw new Error(message);
        if (!("items" in resJson!["data"])) break;
        const notes = resJson!["data"]["items"];
        noteList = noteList.concat(notes);
        cursorScore = String(resJson!["data"]["cursor_score"]);
        refreshType = 3;
        noteIndex += 20;
        if (noteList.length > requireNum) break;
      }
    } catch (error) {
      success = false;
      msg = logApiError(error);
    }
    if (noteList.length > requireNum) noteList = noteList.slice(0, requireNum);
    return [success, msg, noteList];
  }

  /** 获取用户的信息（对应 get_user_info） */
  async getUserInfo(userId: string, proxies: Proxies = null): Promise<[boolean, string, JsonObject | null]> {
    let resJson: JsonObject | null = null;
    let success = false;
    let msg = "";
    try {
      const api = "/api/sns/web/v1/user/otherinfo";
      const params = { target_user_id: userId };
      const spliceApi = spliceStr(api, params);
      const [headers, cookies] = await this._requestParams(spliceApi, "", "GET");
      const response = await this.http.get(this.baseUrl + spliceApi, {
        headers,
        cookies,
        proxies: this._proxies(proxies),
        timeout: REQUEST_TIMEOUT,
      });
      resJson = response.json<JsonObject>();
      success = Boolean(resJson["success"]);
      msg = String(resJson["msg"]);
    } catch (error) {
      success = false;
      msg = logApiError(error);
    }
    return [success, msg, resJson];
  }

  /** 获取用户自己的信息（对应 get_user_me） */
  async getUserMe(proxies: Proxies = null): Promise<[boolean, string, JsonObject | null]> {
    let resJson: JsonObject | null = null;
    let success = false;
    let msg = "";
    try {
      const api = "/api/sns/web/v2/user/me";
      const [headers, cookies] = await this._requestParams(api, "", "GET");
      const response = await this.http.get(this.baseUrl + api, {
        headers,
        cookies,
        proxies: this._proxies(proxies),
        timeout: REQUEST_TIMEOUT,
      });
      resJson = response.json<JsonObject>();
      success = Boolean(resJson["success"]);
      msg = String(resJson["msg"]);
    } catch (error) {
      success = false;
      msg = logApiError(error);
    }
    return [success, msg, resJson];
  }

  /** 获取用户指定位置的笔记（对应 get_user_note_info） */
  async getUserNoteInfo(
    userId: string,
    cursor: string,
    xsecToken = "",
    xsecSource = "",
    proxies: Proxies = null,
  ): Promise<[boolean, string, JsonObject | null]> {
    let resJson: JsonObject | null = null;
    let success = false;
    let msg = "";
    try {
      const api = "/api/sns/web/v1/user_posted";
      const params = {
        num: "30",
        cursor,
        user_id: userId,
        image_formats: "jpg,webp,avif",
        xsec_token: xsecToken,
        xsec_source: xsecSource,
      };
      const spliceApi = spliceStr(api, params);
      const [headers, cookies] = await this._requestParams(spliceApi, "", "GET");
      const response = await this.http.get(this.baseUrl + spliceApi, {
        headers,
        cookies,
        proxies: this._proxies(proxies),
        timeout: REQUEST_TIMEOUT,
      });
      resJson = response.json<JsonObject>();
      success = Boolean(resJson["success"]);
      msg = String(resJson["msg"]);
    } catch (error) {
      success = false;
      msg = logApiError(error);
    }
    return [success, msg, resJson];
  }

  /** 获取用户所有笔记（对应 get_user_all_notes） */
  async getUserAllNotes(userUrl: string, proxies: Proxies = null): Promise<[boolean, string, JsonObject[]]> {
    let cursor = "";
    let noteList: JsonObject[] = [];
    let success = false;
    let msg = "";
    try {
      const urlParse = parseUrlCompat(userUrl);
      const userId = lastPathSegment(urlParse.path);
      const kvDist = getQueryParams(urlParse.query);
      const xsecToken = "xsec_token" in kvDist ? kvDist["xsec_token"] : "";
      const xsecSource = "xsec_source" in kvDist ? kvDist["xsec_source"] : "pc_search";
      while (true) {
        const [ok, message, resJson] = await this.getUserNoteInfo(userId, cursor, xsecToken, xsecSource, proxies);
        if (!ok) throw new Error(message);
        const notes = resJson!["data"]["notes"];
        if ("cursor" in resJson!["data"]) {
          cursor = String(resJson!["data"]["cursor"]);
        } else {
          break;
        }
        noteList = noteList.concat(notes);
        if (notes.length === 0 || !resJson!["data"]["has_more"]) break;
      }
    } catch (error) {
      success = false;
      msg = logApiError(error);
    }
    return [success, msg, noteList];
  }

  /** 获取用户指定位置喜欢的笔记（对应 get_user_like_note_info） */
  async getUserLikeNoteInfo(
    userId: string,
    cursor: string,
    xsecToken = "",
    xsecSource = "",
    proxies: Proxies = null,
  ): Promise<[boolean, string, JsonObject | null]> {
    let resJson: JsonObject | null = null;
    let success = false;
    let msg = "";
    try {
      const api = "/api/sns/web/v1/note/like/page";
      const params = {
        num: "30",
        cursor,
        user_id: userId,
        image_formats: "jpg,webp,avif",
        xsec_token: xsecToken,
        xsec_source: xsecSource,
      };
      const spliceApi = spliceStr(api, params);
      const [headers, cookies] = await this._requestParams(spliceApi, "", "GET");
      const response = await this.http.get(this.baseUrl + spliceApi, {
        headers,
        cookies,
        proxies: this._proxies(proxies),
        timeout: REQUEST_TIMEOUT,
      });
      resJson = response.json<JsonObject>();
      success = Boolean(resJson["success"]);
      msg = String(resJson["msg"]);
    } catch (error) {
      success = false;
      msg = logApiError(error);
    }
    return [success, msg, resJson];
  }

  /** 获取用户所有喜欢笔记（对应 get_user_all_like_note_info） */
  async getUserAllLikeNoteInfo(userUrl: string, proxies: Proxies = null): Promise<[boolean, string, JsonObject[]]> {
    let cursor = "";
    let noteList: JsonObject[] = [];
    let success = false;
    let msg = "";
    try {
      const urlParse = parseUrlCompat(userUrl);
      const userId = lastPathSegment(urlParse.path);
      const kvDist = getQueryParams(urlParse.query);
      const xsecToken = "xsec_token" in kvDist ? kvDist["xsec_token"] : "";
      const xsecSource = "xsec_source" in kvDist ? kvDist["xsec_source"] : "pc_user";
      while (true) {
        const [ok, message, resJson] = await this.getUserLikeNoteInfo(userId, cursor, xsecToken, xsecSource, proxies);
        if (!ok) throw new Error(message);
        const notes = resJson!["data"]["notes"];
        if ("cursor" in resJson!["data"]) {
          cursor = String(resJson!["data"]["cursor"]);
        } else {
          break;
        }
        noteList = noteList.concat(notes);
        if (notes.length === 0 || !resJson!["data"]["has_more"]) break;
      }
    } catch (error) {
      success = false;
      msg = logApiError(error);
    }
    return [success, msg, noteList];
  }

  /** 获取用户指定位置收藏的笔记（对应 get_user_collect_note_info） */
  async getUserCollectNoteInfo(
    userId: string,
    cursor: string,
    xsecToken = "",
    xsecSource = "",
    proxies: Proxies = null,
  ): Promise<[boolean, string, JsonObject | null]> {
    let resJson: JsonObject | null = null;
    let success = false;
    let msg = "";
    try {
      const api = "/api/sns/web/v2/note/collect/page";
      const params = {
        num: "30",
        cursor,
        user_id: userId,
        image_formats: "jpg,webp,avif",
        xsec_token: xsecToken,
        xsec_source: xsecSource,
      };
      const spliceApi = spliceStr(api, params);
      const [headers, cookies] = await this._requestParams(spliceApi, "", "GET");
      const response = await this.http.get(this.baseUrl + spliceApi, {
        headers,
        cookies,
        proxies: this._proxies(proxies),
        timeout: REQUEST_TIMEOUT,
      });
      resJson = response.json<JsonObject>();
      success = Boolean(resJson["success"]);
      msg = String(resJson["msg"]);
    } catch (error) {
      success = false;
      msg = logApiError(error);
    }
    return [success, msg, resJson];
  }

  /** 获取用户所有收藏笔记（对应 get_user_all_collect_note_info） */
  async getUserAllCollectNoteInfo(userUrl: string, proxies: Proxies = null): Promise<[boolean, string, JsonObject[]]> {
    let cursor = "";
    let noteList: JsonObject[] = [];
    let success = false;
    let msg = "";
    try {
      const urlParse = parseUrlCompat(userUrl);
      const userId = lastPathSegment(urlParse.path);
      const kvDist = getQueryParams(urlParse.query);
      const xsecToken = "xsec_token" in kvDist ? kvDist["xsec_token"] : "";
      const xsecSource = "xsec_source" in kvDist ? kvDist["xsec_source"] : "pc_search";
      while (true) {
        const [ok, message, resJson] = await this.getUserCollectNoteInfo(userId, cursor, xsecToken, xsecSource, proxies);
        if (!ok) throw new Error(message);
        const notes = resJson!["data"]["notes"];
        if ("cursor" in resJson!["data"]) {
          cursor = String(resJson!["data"]["cursor"]);
        } else {
          break;
        }
        noteList = noteList.concat(notes);
        if (notes.length === 0 || !resJson!["data"]["has_more"]) break;
      }
    } catch (error) {
      success = false;
      msg = logApiError(error);
    }
    return [success, msg, noteList];
  }

  /**
   * 获取笔记的详细（对应 get_note_info）
   * @param url 你想要获取的笔记的 url（含 xsec_source / xsec_token 查询参数）
   */
  async getNoteInfo(url: string, proxies: Proxies = null): Promise<[boolean, string, JsonObject | null]> {
    let resJson: JsonObject | null = null;
    let success = false;
    let msg = "";
    try {
      const urlParse = parseUrlCompat(url);
      const noteId = lastPathSegment(urlParse.path);
      const kvDist = getQueryParams(urlParse.query);
      const api = "/api/sns/web/v1/feed";
      const data = {
        source_note_id: noteId,
        image_formats: ["jpg", "webp", "avif"],
        extra: { need_body_topic: "1" },
        xsec_source: "xsec_source" in kvDist ? kvDist["xsec_source"] : "pc_search",
        xsec_token: kvDist["xsec_token"] ?? "",
      };
      const [headers, cookies, body] = await this._requestParams(api, data, "POST");
      const response = await this.http.post(this.baseUrl + api, {
        headers,
        data: String(body),
        cookies,
        proxies: this._proxies(proxies),
        timeout: REQUEST_TIMEOUT,
      });
      resJson = response.json<JsonObject>();
      success = Boolean(resJson["success"]);
      msg = String(resJson["msg"]);
    } catch (error) {
      success = false;
      msg = logApiError(error);
    }
    return [success, msg, resJson];
  }

  /** 获取搜索关键词（对应 get_search_keyword） */
  async getSearchKeyword(word: string, proxies: Proxies = null): Promise<[boolean, string, JsonObject | null]> {
    let resJson: JsonObject | null = null;
    let success = false;
    let msg = "";
    try {
      const api = "/api/sns/web/v1/search/recommend";
      // 浏览器: keyword 由 urlencode 一次编码，勿预先 quote
      const spliceApi = spliceStr(api, { keyword: word });
      const [headers, cookies] = await this._requestParams(spliceApi, "", "GET");
      const response = await this.http.get(this.baseUrl + spliceApi, {
        headers,
        cookies,
        proxies: this._proxies(proxies),
        timeout: REQUEST_TIMEOUT,
      });
      resJson = response.json<JsonObject>();
      success = Boolean(resJson["success"]);
      msg = String(resJson["msg"]);
    } catch (error) {
      success = false;
      msg = logApiError(error);
    }
    return [success, msg, resJson];
  }

  /**
   * 获取搜索笔记的结果（对应 search_note；浏览器实抓：so.xiaohongshu.com /api/sns/web/v2/search/notes）
   * @param query 搜索的关键词
   * @param page 搜索的页数
   * @param sortTypeChoice 排序方式 0 综合排序, 1 最新, 2 最多点赞, 3 最多评论, 4 最多收藏
   * @param noteType 笔记类型 0 不限, 1 视频笔记, 2 普通笔记
   * @param noteTime / noteRange / posDistance 保留参数；当前 PC 默认搜索体与浏览器一致不带 filters
   */
  async searchNote(
    query: string,
    page = 1,
    sortTypeChoice = 0,
    noteType = 0,
    noteTime = 0,
    noteRange = 0,
    posDistance = 0,
    geo: unknown = "",
    searchId: string | null = null,
    proxies: Proxies = null,
  ): Promise<[boolean, string, JsonObject | null]> {
    let resJson: JsonObject | null = null;
    let sortType = "general";
    if (sortTypeChoice === 1) sortType = "time_descending";
    else if (sortTypeChoice === 2) sortType = "popularity_descending";
    else if (sortTypeChoice === 3) sortType = "comment_descending";
    else if (sortTypeChoice === 4) sortType = "collect_descending";
    // note_type: 浏览器默认 0；1/2 时写入 body.note_type
    let bodyNoteType = 0;
    if (noteType === 1) bodyNoteType = 1;
    else if (noteType === 2) bodyNoteType = 2;
    let geoValue = geo;
    if (geoValue && typeof geoValue !== "string") {
      geoValue = JSON.stringify(geoValue);
    }
    let success = false;
    let msg = "";
    try {
      // 2026-07 浏览器实抓（非 edith v1）
      const api = "/api/sns/web/v2/search/notes";
      const data: Record<string, any> = {
        keyword: query,
        page,
        page_size: 20,
        search_id: searchId || generateSearchId(),
        sort: sortType,
        note_type: bodyNoteType,
        ext_flags: [],
        geo: geoValue || "",
        image_formats: ["jpg", "webp", "avif"],
        session_id: generateSearchSessionId(),
      };
      // 兼容旧筛选：仅当调用方显式要求非默认时附加 filters（浏览器默认搜索无此字段）
      if (noteTime || noteRange || posDistance) {
        data["filters"] = [
          { tags: [sortType], type: "sort_type" },
          { tags: [noteType === 0 || noteType === 1 || noteType === 2 ? ["不限", "视频笔记", "普通笔记"][noteType] : "不限"], type: "filter_note_type" },
          { tags: [noteTime === 0 || noteTime === 1 || noteTime === 2 || noteTime === 3 ? ["不限", "一天内", "一周内", "半年内"][noteTime] : "不限"], type: "filter_note_time" },
          { tags: [noteRange === 0 || noteRange === 1 || noteRange === 2 || noteRange === 3 ? ["不限", "已看过", "未看过", "已关注"][noteRange] : "不限"], type: "filter_note_range" },
          { tags: [posDistance === 0 || posDistance === 1 || posDistance === 2 ? ["不限", "同城", "附近"][posDistance] : "不限"], type: "filter_pos_distance" },
        ];
      }
      const [headers, cookies, body] = await this._requestParams(api, data, "POST", null, {
        targetOrigin: this.soBaseUrl,
      });
      const response = await this.http.post(this.soBaseUrl + api, {
        headers,
        data: String(body),
        cookies,
        proxies: this._proxies(proxies),
        timeout: REQUEST_TIMEOUT,
      });
      resJson = response.json<JsonObject>();
      success = Boolean(resJson["success"]);
      msg = String(resJson["msg"]);
    } catch (error) {
      success = false;
      msg = logApiError(error);
    }
    return [success, msg, resJson];
  }

  /**
   * 指定数量搜索笔记（对应 search_some_note），可设置排序方式和笔记类型和笔记数量
   * @param query 搜索的关键词
   * @param requireNum 搜索的数量
   * @param sortTypeChoice 排序方式 0 综合排序, 1 最新, 2 最多点赞, 3 最多评论, 4 最多收藏
   * @param noteType 笔记类型 0 不限, 1 视频笔记, 2 普通笔记
   * @param noteTime 笔记时间 0 不限, 1 一天内, 2 一周内, 3 半年内
   * @param noteRange 笔记范围 0 不限, 1 已看过, 2 未看过, 3 已关注
   * @param posDistance 位置距离 0 不限, 1 同城, 2 附近；指定这个必须要指定 geo
   * @param geo 定位信息 经纬度
   */
  async searchSomeNote(
    query: string,
    requireNum: number,
    sortTypeChoice = 0,
    noteType = 0,
    noteTime = 0,
    noteRange = 0,
    posDistance = 0,
    geo: unknown = "",
    proxies: Proxies = null,
  ): Promise<[boolean, string, JsonObject[]]> {
    let page = 1;
    let noteList: JsonObject[] = [];
    let success = false;
    let msg = "";
    const rootSearchId = generateSearchId();
    try {
      while (true) {
        const searchId = generateSearchId(rootSearchId);
        const [ok, message, resJson] = await this.searchNote(query, page, sortTypeChoice, noteType, noteTime, noteRange, posDistance, geo, searchId, proxies);
        if (!ok) throw new Error(message);
        if (!("items" in resJson!["data"])) break;
        const notes = resJson!["data"]["items"];
        noteList = noteList.concat(notes);
        page += 1;
        if (noteList.length >= requireNum || !resJson!["data"]["has_more"]) break;
      }
    } catch (error) {
      success = false;
      msg = logApiError(error);
    }
    if (noteList.length > requireNum) noteList = noteList.slice(0, requireNum);
    return [success, msg, noteList];
  }

  /** 获取搜索用户的结果（对应 search_user） */
  async searchUser(query: string, page = 1, proxies: Proxies = null): Promise<[boolean, string, JsonObject | null]> {
    let resJson: JsonObject | null = null;
    let success = false;
    let msg = "";
    try {
      const api = "/api/sns/web/v1/search/usersearch";
      const data = {
        search_user_request: {
          keyword: query,
          search_id: generateSearchId(),
          page,
          page_size: 15,
          biz_type: "web_search_user",
          request_id: generateSearchRequestId(),
        },
      };
      const [headers, cookies, body] = await this._requestParams(api, data, "POST");
      const response = await this.http.post(this.baseUrl + api, {
        headers,
        data: String(body),
        cookies,
        proxies: this._proxies(proxies),
        timeout: REQUEST_TIMEOUT,
      });
      resJson = response.json<JsonObject>();
      success = Boolean(resJson["success"]);
      msg = String(resJson["msg"]);
    } catch (error) {
      success = false;
      msg = logApiError(error);
    }
    return [success, msg, resJson];
  }

  /** 指定数量搜索用户（对应 search_some_user） */
  async searchSomeUser(query: string, requireNum: number, proxies: Proxies = null): Promise<[boolean, string, JsonObject[]]> {
    let page = 1;
    let userList: JsonObject[] = [];
    let success = false;
    let msg = "";
    try {
      while (true) {
        const [ok, message, resJson] = await this.searchUser(query, page, proxies);
        if (!ok) throw new Error(message);
        if (!("users" in resJson!["data"])) break;
        const users = resJson!["data"]["users"];
        userList = userList.concat(users);
        page += 1;
        if (userList.length >= requireNum || !resJson!["data"]["has_more"]) break;
      }
    } catch (error) {
      success = false;
      msg = logApiError(error);
    }
    if (userList.length > requireNum) userList = userList.slice(0, requireNum);
    return [success, msg, userList];
  }

  /** 获取指定位置的笔记一级评论（对应 get_note_out_comment） */
  async getNoteOutComment(noteId: string, cursor: string, xsecToken: string, proxies: Proxies = null): Promise<[boolean, string, JsonObject | null]> {
    let resJson: JsonObject | null = null;
    let success = false;
    let msg = "";
    try {
      const api = "/api/sns/web/v2/comment/page";
      const params = {
        note_id: noteId,
        cursor,
        top_comment_id: "",
        image_formats: "jpg,webp,avif",
        xsec_token: xsecToken,
      };
      const spliceApi = spliceStr(api, params);
      const [headers, cookies] = await this._requestParams(spliceApi, "", "GET");
      const response = await this.http.get(this.baseUrl + spliceApi, {
        headers,
        cookies,
        proxies: this._proxies(proxies),
        timeout: REQUEST_TIMEOUT,
      });
      resJson = response.json<JsonObject>();
      success = Boolean(resJson["success"]);
      msg = String(resJson["msg"]);
    } catch (error) {
      success = false;
      msg = logApiError(error);
    }
    return [success, msg, resJson];
  }

  /** 获取笔记的全部一级评论（对应 get_note_all_out_comment） */
  async getNoteAllOutComment(noteId: string, xsecToken: string, proxies: Proxies = null): Promise<[boolean, string, JsonObject[]]> {
    let cursor = "";
    let noteOutCommentList: JsonObject[] = [];
    let success = false;
    let msg = "";
    try {
      while (true) {
        const [ok, message, resJson] = await this.getNoteOutComment(noteId, cursor, xsecToken, proxies);
        if (!ok) throw new Error(message);
        const comments = resJson!["data"]["comments"];
        if ("cursor" in resJson!["data"]) {
          cursor = String(resJson!["data"]["cursor"]);
        } else {
          break;
        }
        noteOutCommentList = noteOutCommentList.concat(comments);
        if (noteOutCommentList.length === 0 || !resJson!["data"]["has_more"]) break;
      }
    } catch (error) {
      success = false;
      msg = logApiError(error);
    }
    return [success, msg, noteOutCommentList];
  }

  /** 获取指定位置的笔记二级评论（对应 get_note_inner_comment） */
  async getNoteInnerComment(comment: JsonObject, cursor: string, xsecToken: string, proxies: Proxies = null): Promise<[boolean, string, JsonObject | null]> {
    let resJson: JsonObject | null = null;
    let success = false;
    let msg = "";
    try {
      const api = "/api/sns/web/v2/comment/sub/page";
      const params = {
        note_id: comment["note_id"],
        root_comment_id: comment["id"],
        num: "10",
        cursor,
        image_formats: "jpg,webp,avif",
        top_comment_id: "",
        xsec_token: xsecToken,
      };
      const spliceApi = spliceStr(api, params);
      const [headers, cookies] = await this._requestParams(spliceApi, "", "GET");
      const response = await this.http.get(this.baseUrl + spliceApi, {
        headers,
        cookies,
        proxies: this._proxies(proxies),
        timeout: REQUEST_TIMEOUT,
      });
      resJson = response.json<JsonObject>();
      success = Boolean(resJson["success"]);
      msg = String(resJson["msg"]);
    } catch (error) {
      success = false;
      msg = logApiError(error);
    }
    return [success, msg, resJson];
  }

  /** 获取笔记的全部二级评论（对应 get_note_all_inner_comment），会把结果写回一级评论的 sub_comments */
  async getNoteAllInnerComment(comment: JsonObject, xsecToken: string, proxies: Proxies = null): Promise<[boolean, string, JsonObject]> {
    let success = false;
    let msg = "";
    try {
      if (!comment["sub_comment_has_more"]) {
        return [true, "success", comment];
      }
      let cursor = String(comment["sub_comment_cursor"]);
      let innerCommentList: JsonObject[] = [];
      while (true) {
        const [ok, message, resJson] = await this.getNoteInnerComment(comment, cursor, xsecToken, proxies);
        if (!ok) throw new Error(message);
        const comments = resJson!["data"]["comments"];
        if ("cursor" in resJson!["data"]) {
          cursor = String(resJson!["data"]["cursor"]);
        } else {
          break;
        }
        innerCommentList = innerCommentList.concat(comments);
        if (!resJson!["data"]["has_more"]) break;
      }
      comment["sub_comments"] = (comment["sub_comments"] as JsonObject[]).concat(innerCommentList);
    } catch (error) {
      success = false;
      msg = logApiError(error);
    }
    return [success, msg, comment];
  }

  /** 获取一篇文章的所有评论（对应 get_note_all_comment） */
  async getNoteAllComment(url: string, proxies: Proxies = null): Promise<[boolean, string, JsonObject[]]> {
    let outCommentList: JsonObject[] = [];
    let success = false;
    let msg = "";
    try {
      const urlParse = parseUrlCompat(url);
      const noteId = lastPathSegment(urlParse.path);
      const kvDist = getQueryParams(urlParse.query);
      const xsecToken = kvDist["xsec_token"] ?? "";
      const [ok, message, list] = await this.getNoteAllOutComment(noteId, xsecToken, proxies);
      if (!ok) throw new Error(message);
      outCommentList = list;
      for (const comment of outCommentList) {
        const [innerOk, innerMsg] = await this.getNoteAllInnerComment(comment, xsecToken, proxies);
        if (!innerOk) throw new Error(innerMsg);
      }
    } catch (error) {
      success = false;
      msg = logApiError(error);
    }
    return [success, msg, outCommentList];
  }

  /**
   * 发布评论（对应 post_comment，/api/sns/web/v1/comment/post，RAP 白名单已内置）
   * @param noteId 笔记 ID
   * @param content 评论内容
   * @param xsecToken 笔记详情返回的 xsec_token
   * @param parentCommentId 回复二级评论时传一级评论 ID（可空）
   */
  async postComment(
    noteId: string,
    content: string,
    xsecToken: string,
    parentCommentId: string | null = null,
    proxies: Proxies = null,
  ): Promise<[boolean, string, JsonObject | null]> {
    let resJson: JsonObject | null = null;
    let success = false;
    let msg = "";
    try {
      const api = "/api/sns/web/v1/comment/post";
      const data: Record<string, unknown> = {
        note_id: noteId,
        content,
        at_users: "",
        xsec_token: xsecToken,
        ...(parentCommentId ? { reply_comment_id: parentCommentId } : {}),
      };
      const [headers, cookies, body] = await this._requestParams(api, data, "POST");
      const response = await this.http.post(this.baseUrl + api, {
        headers,
        data: String(body),
        cookies,
        proxies: this._proxies(proxies),
        timeout: REQUEST_TIMEOUT,
      });
      resJson = response.json<JsonObject>();
      success = Boolean(resJson["success"]);
      msg = String(resJson["msg"]);
    } catch (error) {
      success = false;
      msg = logApiError(error);
    }
    return [success, msg, resJson];
  }

  /** 获取未读消息（对应 get_unread_message） */
  async getUnreadMessage(proxies: Proxies = null): Promise<[boolean, string, JsonObject | null]> {
    let resJson: JsonObject | null = null;
    let success = false;
    let msg = "";
    try {
      const api = "/api/sns/web/unread_count";
      const [headers, cookies] = await this._requestParams(api, "", "GET");
      const response = await this.http.get(this.baseUrl + api, {
        headers,
        cookies,
        proxies: this._proxies(proxies),
        timeout: REQUEST_TIMEOUT,
      });
      resJson = response.json<JsonObject>();
      success = Boolean(resJson["success"]);
      msg = String(resJson["msg"]);
    } catch (error) {
      success = false;
      msg = logApiError(error);
    }
    return [success, msg, resJson];
  }

  /** 获取评论和@提醒（对应 get_metions） */
  async getMetions(cursor: string, proxies: Proxies = null): Promise<[boolean, string, JsonObject | null]> {
    let resJson: JsonObject | null = null;
    let success = false;
    let msg = "";
    try {
      const api = "/api/sns/web/v1/you/mentions";
      const params = { num: "20", cursor };
      const spliceApi = spliceStr(api, params);
      const [headers, cookies] = await this._requestParams(spliceApi, "", "GET");
      const response = await this.http.get(this.baseUrl + spliceApi, {
        headers,
        cookies,
        proxies: this._proxies(proxies),
        timeout: REQUEST_TIMEOUT,
      });
      resJson = response.json<JsonObject>();
      success = Boolean(resJson["success"]);
      msg = String(resJson["msg"]);
    } catch (error) {
      success = false;
      msg = logApiError(error);
    }
    return [success, msg, resJson];
  }

  /** 获取全部的评论和@提醒（对应 get_all_metions） */
  async getAllMetions(proxies: Proxies = null): Promise<[boolean, string, JsonObject[]]> {
    let cursor = "";
    let metionsList: JsonObject[] = [];
    let success = false;
    let msg = "";
    try {
      while (true) {
        const [ok, message, resJson] = await this.getMetions(cursor, proxies);
        if (!ok) throw new Error(message);
        const metions = resJson!["data"]["message_list"];
        if ("cursor" in resJson!["data"]) {
          cursor = String(resJson!["data"]["cursor"]);
        } else {
          break;
        }
        metionsList = metionsList.concat(metions);
        if (!resJson!["data"]["has_more"]) break;
      }
    } catch (error) {
      success = false;
      msg = logApiError(error);
    }
    return [success, msg, metionsList];
  }

  /** 获取赞和收藏（对应 get_likesAndcollects） */
  async getLikesAndcollects(cursor: string, proxies: Proxies = null): Promise<[boolean, string, JsonObject | null]> {
    let resJson: JsonObject | null = null;
    let success = false;
    let msg = "";
    try {
      const api = "/api/sns/web/v1/you/likes";
      const params = { num: "20", cursor };
      const spliceApi = spliceStr(api, params);
      const [headers, cookies] = await this._requestParams(spliceApi, "", "GET");
      const response = await this.http.get(this.baseUrl + spliceApi, {
        headers,
        cookies,
        proxies: this._proxies(proxies),
        timeout: REQUEST_TIMEOUT,
      });
      resJson = response.json<JsonObject>();
      success = Boolean(resJson["success"]);
      msg = String(resJson["msg"]);
    } catch (error) {
      success = false;
      msg = logApiError(error);
    }
    return [success, msg, resJson];
  }

  /** 获取全部的赞和收藏（对应 get_all_likesAndcollects） */
  async getAllLikesAndcollects(proxies: Proxies = null): Promise<[boolean, string, JsonObject[]]> {
    let cursor = "";
    let likesAndcollectsList: JsonObject[] = [];
    let success = false;
    let msg = "";
    try {
      while (true) {
        const [ok, message, resJson] = await this.getLikesAndcollects(cursor, proxies);
        if (!ok) throw new Error(message);
        const likesAndcollects = resJson!["data"]["message_list"];
        if ("cursor" in resJson!["data"]) {
          cursor = String(resJson!["data"]["cursor"]);
        } else {
          break;
        }
        likesAndcollectsList = likesAndcollectsList.concat(likesAndcollects);
        if (!resJson!["data"]["has_more"]) break;
      }
    } catch (error) {
      success = false;
      msg = logApiError(error);
    }
    return [success, msg, likesAndcollectsList];
  }

  /** 获取新增关注（对应 get_new_connections） */
  async getNewConnections(cursor: string, proxies: Proxies = null): Promise<[boolean, string, JsonObject | null]> {
    let resJson: JsonObject | null = null;
    let success = false;
    let msg = "";
    try {
      const api = "/api/sns/web/v1/you/connections";
      const params = { num: "20", cursor };
      const spliceApi = spliceStr(api, params);
      const [headers, cookies] = await this._requestParams(spliceApi, "", "GET");
      const response = await this.http.get(this.baseUrl + spliceApi, {
        headers,
        cookies,
        proxies: this._proxies(proxies),
        timeout: REQUEST_TIMEOUT,
      });
      resJson = response.json<JsonObject>();
      success = Boolean(resJson["success"]);
      msg = String(resJson["msg"]);
    } catch (error) {
      success = false;
      msg = logApiError(error);
    }
    return [success, msg, resJson];
  }

  /** 获取全部的新增关注（对应 get_all_new_connections） */
  async getAllNewConnections(proxies: Proxies = null): Promise<[boolean, string, JsonObject[]]> {
    let cursor = "";
    let connectionsList: JsonObject[] = [];
    let success = false;
    let msg = "";
    try {
      while (true) {
        const [ok, message, resJson] = await this.getNewConnections(cursor, proxies);
        if (!ok) throw new Error(message);
        const connections = resJson!["data"]["message_list"];
        if ("cursor" in resJson!["data"]) {
          cursor = String(resJson!["data"]["cursor"]);
        } else {
          break;
        }
        connectionsList = connectionsList.concat(connections);
        if (!resJson!["data"]["has_more"]) break;
      }
    } catch (error) {
      success = false;
      msg = logApiError(error);
    }
    return [success, msg, connectionsList];
  }

  /** 获取笔记无水印视频（对应 get_note_no_water_video），解析 explore 页 og:video meta */
  static async getNoteNoWaterVideo(noteId: string): Promise<[boolean, string, string | null]> {
    let success = true;
    let msg = "成功";
    let videoAddr: string | null = null;
    try {
      const headers = buildPcNavigationHeaders(getCommonHeaders());
      const url = `https://www.xiaohongshu.com/explore/${noteId}`;
      const http = new PcHttpClient();
      const response = await http.get(url, { headers, timeout: REQUEST_TIMEOUT }).finally(() => {
        http.close();
      });
      const matches = response.text.match(/<meta name="og:video" content="(.*?)">/);
      if (!matches) throw new Error("og:video meta 未找到");
      videoAddr = matches[1];
    } catch (error) {
      success = false;
      msg = logApiError(error);
    }
    return [success, msg, videoAddr];
  }

  /**
   * 获取笔记无水印图片（对应 get_note_no_water_img）
   * @param imgUrl 你想要获取的图片的 url
   * 新版图片资源优先保留 notes_pre_post token，使用 ci.xiaohongshu.com 输出 JPEG。例：
   *   https://sns-webpic-qc.xhscdn.com/<time>/<hash>/notes_pre_post/<img_id>!nd_dft_wlteh_webp_3
   *   -> https://ci.xiaohongshu.com/notes_pre_post/<img_id>?imageView2/format/jpeg
   */
  static getNoteNoWaterImg(imgUrl: string): [boolean, string, string | null] {
    let success = true;
    let msg = "成功";
    let newUrl: string | null = null;
    try {
      let token: string;
      if (imgUrl.includes("notes_pre_post/")) {
        token = "notes_pre_post/" + imgUrl.split("notes_pre_post/", 2)[1].split("!", 1)[0].split("?", 1)[0];
      } else if (imgUrl.includes("spectrum")) {
        token = imgUrl.split("/").slice(-2).join("/").split("!", 1)[0].split("?", 1)[0];
      } else if (imgUrl.includes(".jpg")) {
        token = imgUrl.split("/").slice(-3).join("/").split("!", 1)[0].split("?", 1)[0];
      } else {
        token = imgUrl.split("/").at(-1)!.split("!", 1)[0].split("?", 1)[0];
      }
      newUrl = `https://ci.xiaohongshu.com/${token}?imageView2/format/jpeg`;
    } catch (error) {
      success = false;
      msg = logApiError(error);
    }
    return [success, msg, newUrl];
  }
}
