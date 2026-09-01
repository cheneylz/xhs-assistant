/**
 * Creator（创作者中心）API（对应原版 XHS_ALL_IN_ONE/apis/xhs_creator_apis.py）
 *
 * 鉴权和动态签名材料只从 XHSCreatorAuth 获取：
 *   - XHSCreatorAuth.fromCookie(完整 Creator Cookie)
 *   - XHSCreatorAuth.fromQrcodeLogin()
 *   - XHSCreatorAuth.fromPhoneLogin()
 *
 * 业务方法不再散传 Cookie、a1、b1、dsl。b1、MNS、X-s、X-t、
 * X-S-Common、trace id 和 Cookie 生命周期均由 Auth 内部维护。
 *
 * 图片尺寸 / 视频元数据 / 视频封面抽取按重构文档 §5.4 用 sharp + ffprobe/ffmpeg
 * 替代 opencv（见 src/lib/server/media/）。
 */
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { orderedWireHeaders } from "../core/http";
import { creatorUrlSing } from "../core/runtime";
import { extractVideoCover, getVideoMetadata } from "../../media/video-util";
import { generateXRapParamValue } from "../pc/params";
import { XHSCreatorAuth } from "./auth";
import { CREATOR_ACCEPT_ENCODING } from "./http";
import {
  buildCreatorBusinessHeaders,
  generateRequestParams,
  spliceStrCreator,
} from "./params";
import {
  getFileIdsParams,
  getLocData,
  getPostNoteImageData,
  getPostNoteVideoData,
  getUploadMediaHeaders,
  getUploadSignature,
  loadCreatorRapFingerprintHex,
} from "./publish";

const TRANSCODE_MAX_RETRIES = 20;
const TRANSCODE_RETRY_DELAY = 3;

const CREATOR_HOME_REFERER = "https://creator.xiaohongshu.com/new/home";
const CREATOR_NOTE_MANAGER_REFERER = "https://creator.xiaohongshu.com/new/note-manager";
const CREATOR_PUBLISH_REFERER =
  "https://creator.xiaohongshu.com/publish/publish?source=official&from=menu&target=image";

const CREATOR_NOTE_MANAGER_HEADER_ORDER = [
  "authorization",
  "referer",
  "x-xray-traceid",
  "x-t",
  "x-b3-traceid",
  "x-s-common",
  "user-agent",
  "accept",
  "x-s",
  "accept-encoding",
  "accept-language",
  "cookie",
  "priority",
  "sec-fetch-dest",
  "sec-fetch-mode",
  "sec-fetch-site",
];
const CREATOR_NOTE_MANAGER_USER_INFO_HEADER_ORDER = [
  "authorization",
  "referer",
  "x-xray-traceid",
  "x-t",
  "x-b3-traceid",
  "x-s-common",
  "user-agent",
  "accept",
  "x-s",
  "accept-encoding",
  "accept-language",
  "cache-control",
  "cookie",
  "pragma",
  "priority",
  "sec-fetch-dest",
  "sec-fetch-mode",
  "sec-fetch-site",
];

/** 请求超时（与原版 REQUEST_TIMEOUT=15 一致；本传输层按毫秒计） */
const REQUEST_TIMEOUT = 15 * 1000;

/** 通用 JSON 对象（对齐 Python dict 语义） */
export type JsonObject = Record<string, any>;

/** 代理配置（对齐 requests proxies 语义） */
type Proxies = Record<string, string> | null | undefined;

/** 等待指定秒数（对应 time.sleep） */
function sleep(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

/** 记录 API 请求异常（对应 _log_api_error） */
function logApiError(error: unknown): string {
  console.error(`XHS Creator API request failed: ${error instanceof Error ? error.message : String(error)}`);
  return error instanceof Error ? error.message : String(error);
}

/**
 * 组装 note-manager GET 请求的显式浏览器 wire 头（对应 _creator_note_manager_headers）。
 * curl-impersonate 只提供 Chrome TLS/HTTP2 指纹，默认不启用浏览器普通请求头，
 * 因此这里保留普通请求头顺序与精确 Cookie 串的唯一所有权。
 */
function creatorNoteManagerHeaders(
  headers: Record<string, string>,
  cookies: Record<string, string>,
  options: { userInfo?: boolean } = {},
): Record<string, string> {
  const order = options.userInfo ? CREATOR_NOTE_MANAGER_USER_INFO_HEADER_ORDER : CREATOR_NOTE_MANAGER_HEADER_ORDER;
  return orderedWireHeaders(headers, { order, cookies, acceptEncoding: CREATOR_ACCEPT_ENCODING });
}

/** 发布笔记参数（对齐 Python noteInfo dict） */
export interface NoteInfo {
  title?: string;
  desc?: string;
  postTime?: string | null;
  location?: string | null;
  /** 隐私类型（对应 noteInfo["type"]） */
  type?: string | number;
  /** 笔记类型：image 或 video */
  media_type?: string;
  /** 视频字节（video 类型必填） */
  video?: Buffer;
  /** 图片字节列表（image 类型必填） */
  images?: Buffer[];
  /** 话题列表 */
  topics?: string[];
}

/** 上传结果（对应 upload_media 的 res dict；width/height 初始为空串，上传后为数字） */
export interface UploadMediaResult {
  fileIds: string;
  width: any;
  height: any;
  video_id: string;
  file_size?: number;
  mime_type?: string;
}

export class XhsCreatorApis {
  auth: XHSCreatorAuth;
  http: XHSCreatorAuth["httpClient"];
  baseUrl: string;
  uploadUrl: string;
  edithUrl: string;
  xhsWebUrl: string;
  _noteManagerSigned = false;

  constructor(auth: XHSCreatorAuth) {
    if (!(auth instanceof XHSCreatorAuth)) {
      throw new TypeError("XhsCreatorApis 仅支持 XHSCreatorAuth；请使用 fromCookie()、fromQrcodeLogin() 或 fromPhoneLogin() 创建");
    }
    auth.validate(true);
    this.auth = auth;
    this.http = auth.httpClient;
    this.baseUrl = auth.origin("api");
    this.uploadUrl = auth.origin("upload");
    this.edithUrl = auth.origin("edith");
    this.xhsWebUrl = auth.origin("public_web");
  }

  _proxies(proxies: Proxies = null): Proxies {
    return proxies !== null && proxies !== undefined ? proxies : this.auth.proxies;
  }

  /**
   * 按 Creator 4.3.6 浏览器链路生成请求头、Cookie 和线上的紧凑 body（对应 _request_params）
   * @param orderWireHeaders 是否按业务头顺序重排（默认 true；post_note 关闭后自行补 x-rap-param）
   */
  async requestParams(
    api: string,
    data: unknown = "",
    method = "POST",
    options: {
      referer?: string | null;
      secFetchSite?: string;
      b1Profile?: string | null;
      mnsProfile?: string | null;
      targetOrigin?: string | null;
      orderWireHeaders?: boolean;
    } = {},
  ): Promise<[Record<string, string>, Record<string, string>, string]> {
    const webOrigin = this.auth.origin("web");
    const [headers, cookies, body] = await generateRequestParams(this.auth, api, data, method, {
      b1Profile: options.b1Profile ?? null,
      mnsProfile: options.mnsProfile ?? null,
      origin: webOrigin,
      referer: options.referer ?? `${webOrigin}/`,
      secFetchSite: options.secFetchSite ?? "same-site",
      // 浏览器 XHR 一律不带 sec-ch-ua*（2026-07-25 实证），仅导航请求保留
      includeClientHints: false,
    });
    const target = (options.targetOrigin ?? this.baseUrl) + api;
    const wireCookies = this.auth.cookiesForUrl(target, cookies);
    let resultHeaders = headers;
    if (options.orderWireHeaders ?? true) {
      resultHeaders = buildCreatorBusinessHeaders(headers, wireCookies, { method });
    }
    return [resultHeaders, wireCookies, body];
  }

  /** 调用浏览器同款 user/info 验收 Creator 登录态（对应 bootstrap） */
  async bootstrap(proxies: Proxies = null): Promise<this> {
    const [success, msg] = await this.getUserInfo(proxies);
    if (!success) throw new Error(`Creator bootstrap user/info failed: ${msg}`);
    return this;
  }

  /** 获取创作者个人信息（对应 get_user_info） */
  async getUserInfo(proxies: Proxies = null): Promise<[boolean, string, JsonObject | null]> {
    let resJson: JsonObject | null = null;
    let success = false;
    let msg = "";
    try {
      const api = "/api/galaxy/user/info";
      const [headers, cookies] = await this.requestParams(api, "", "GET", {
        referer: CREATOR_NOTE_MANAGER_REFERER,
        secFetchSite: "same-origin",
      });
      headers["cache-control"] = "no-cache";
      headers["pragma"] = "no-cache";
      const wireHeaders = creatorNoteManagerHeaders(headers, cookies, { userInfo: true });
      const response = await this.http.get(this.baseUrl + api, {
        headers: wireHeaders,
        proxies: this._proxies(proxies),
        timeout: REQUEST_TIMEOUT,
      });
      resJson = response.json<JsonObject>();
      success = Boolean(resJson["success"]);
      msg = String(resJson["msg"] || (success ? "成功" : "登录态无效"));
    } catch (error) {
      success = false;
      msg = logApiError(error);
    }
    return [success, msg, resJson];
  }

  /** 搜索话题（对应 get_topic） */
  async getTopic(keyword: string, proxies: Proxies = null): Promise<[boolean, string, JsonObject | null]> {
    let resJson: JsonObject | null = null;
    let success = false;
    let msg = "";
    try {
      const api = "/web_api/sns/v1/search/topic";
      const data = {
        keyword,
        suggest_topic_request: {
          title: "",
          desc: `#${keyword}`,
        },
        page: {
          page_size: 20,
          page: 1,
        },
      };
      const [headers, cookies, body] = await this.requestParams(api, data, "POST", {
        targetOrigin: this.edithUrl,
      });
      const response = await this.http.post(this.edithUrl + api, {
        headers,
        cookies,
        data: body,
        proxies: this._proxies(proxies),
        timeout: REQUEST_TIMEOUT,
      });
      resJson = response.json<JsonObject>();
      success = Boolean(resJson["success"]);
      msg = String(resJson["msg"]);
    } catch (error) {
      resJson = null;
      success = false;
      msg = logApiError(error);
    }
    return [success, msg, resJson];
  }

  /** 搜索地点（对应 get_location_info） */
  async getLocationInfo(keyword: string, proxies: Proxies = null): Promise<[boolean, string, JsonObject | null]> {
    let resJson: JsonObject | null = null;
    let success = false;
    let msg = "";
    try {
      const data = getLocData(keyword);
      const api = "/web_api/sns/v1/local/poi/creator/search";
      const [headers, cookies, body] = await this.requestParams(api, data, "POST", {
        targetOrigin: this.edithUrl,
      });
      const response = await this.http.post(this.edithUrl + api, {
        headers,
        cookies,
        data: body,
        proxies: this._proxies(proxies),
        timeout: REQUEST_TIMEOUT,
      });
      resJson = response.json<JsonObject>();
      success = Boolean(resJson["success"]);
      msg = String(resJson["msg"]);
    } catch (error) {
      resJson = null;
      success = false;
      msg = logApiError(error);
    }
    return [success, msg, resJson];
  }

  /**
   * 获取上传凭证（对应 get_fileIds，media_type: image 或 video）
   * 返回 (success, msg, (res_json, x-t))；失败时第三项为 (null, null)。
   */
  async getFileIds(mediaType: string, proxies: Proxies = null): Promise<[boolean, string, [JsonObject | null, string | null]]> {
    try {
      const api = "/api/media/v1/upload/creator/permit";
      const params = getFileIdsParams(mediaType);
      const spliceApi = spliceStrCreator(api, params);
      // 发布页导航后的首个业务请求发生在该页面 DS 程序安装之前：
      // permit 服务端只接受 note_manager 冷档位（MNS0101+nop，2026-07-25
      // 六组合矩阵实证）；a1 档（ready/steady）一律 HTTP 406。
      const [headers, cookies] = await this.requestParams(spliceApi, "", "GET", {
        referer: CREATOR_PUBLISH_REFERER,
        secFetchSite: "same-origin",
        b1Profile: "note_manager",
        mnsProfile: "note_manager",
      });
      const response = await this.http.get(this.baseUrl + spliceApi, {
        headers,
        cookies,
        proxies: this._proxies(proxies),
        timeout: REQUEST_TIMEOUT,
      });
      const resJson = response.json<JsonObject>();
      const success = Boolean(resJson["success"]);
      const msg = "获取fileIds成功";
      return [success, msg, [resJson, headers["x-t"] ?? null]];
    } catch (error) {
      return [false, logApiError(error), [null, null]];
    }
  }

  /** getFileIds 的 PEP 8 别名（对应 get_file_ids；camelCase 下与原方法重名，故单独命名） */
  getFileIdsAlias(mediaType: string, proxies: Proxies = null): Promise<[boolean, string, [JsonObject | null, string | null]]> {
    return this.getFileIds(mediaType, proxies);
  }

  /** 上传图片/视频到 ROS（对应 upload_media），返回 fileIds / 宽高 / video_id 等 */
  async uploadMedia(pathOrFile: Buffer, mediaType: string, proxies: Proxies = null): Promise<[boolean, string, UploadMediaResult | null]> {
    const res: UploadMediaResult = { fileIds: "", width: "", height: "", video_id: "" };
    try {
      const [success, msg, fileIdsResult] = await this.getFileIds(mediaType, proxies);
      if (!success) throw new Error(msg);
      const [permitData, xt] = fileIdsResult;
      const data = permitData!["data"]["uploadTempPermits"][0];
      const uploadHost = String(data["uploadAddr"] ?? "") || this.uploadUrl.replace("https://", "");
      const uploadUrl = uploadHost.startsWith("http") ? uploadHost : `https://${uploadHost}`;
      const fileIds = String(data["fileIds"][0]).split("/").at(-1)!;
      const expireTime = data["expireTime"];
      const token = data["token"];
      res.fileIds = fileIds;
      const xtText = String(xt).slice(0, 10);
      const expireText = String(expireTime).slice(0, 10);
      const message = `${xtText};${expireText}`;
      let file: Buffer;
      let fileSize: number;
      if (mediaType === "image") {
        const [width, height, imageFile, size] = await this.getFileInfo(pathOrFile, "image");
        res.width = width;
        res.height = height;
        res.file_size = size;
        res.mime_type = "image/png";
        file = imageFile;
        fileSize = size;
      } else {
        const [videoFile, size] = await this.getFileInfo(pathOrFile, "video");
        res.file_size = size;
        file = videoFile;
        fileSize = size;
      }
      const signature = getUploadSignature(message, fileIds, fileSize, uploadHost);
      const headers = getUploadMediaHeaders(message, signature, token, {
        userAgent: String(this.auth.profile.release["userAgent"] ?? ""),
        uploadHost,
      });
      const api = `/spectrum/${fileIds}`;
      // ROS 上传域名不会收到 creator.xiaohongshu.com 的登录 Cookie
      const response = await this.http.put(uploadUrl + api, {
        headers,
        data: file,
        proxies: this._proxies(proxies),
        timeout: REQUEST_TIMEOUT,
      });
      response.raiseForStatus();
      if (mediaType === "video") {
        res.video_id = response.headers.get("X-Ros-Video-Id") ?? "";
        if (!res.video_id) throw new Error("upload response missing X-Ros-Video-Id");
      }
    } catch (error) {
      return [false, logApiError(error), null];
    }
    return [true, "上传成功", res];
  }

  /**
   * 查询视频转码状态（对应 query_transcode）
   * 与 permit 同契约：发布页导航后首请求的冷档形状（2026-07-25 实证）。
   * 另需 www 侧 web_session（PC 登录签发），否则 401 无登录信息。
   */
  async queryTranscode(videoId: string | number, proxies: Proxies = null): Promise<[boolean, string, JsonObject | null]> {
    let resJson: JsonObject | null = null;
    let success = false;
    let msg = "";
    try {
      const api = "/web_api/sns/capa/postgw/query_transcode";
      const params = {
        video_id: String(videoId),
        need_transcode: "false",
        resource_type: "0",
      };
      const spliceApi = spliceStrCreator(api, params);
      const [headers, cookies] = await this.requestParams(spliceApi, "", "GET", {
        targetOrigin: this.edithUrl,
        b1Profile: "note_manager",
        mnsProfile: "note_manager",
      });
      const response = await this.http.get(this.edithUrl + spliceApi, {
        headers,
        cookies,
        proxies: this._proxies(proxies),
        timeout: REQUEST_TIMEOUT,
      });
      resJson = response.json<JsonObject>();
      success = Boolean(resJson["success"]);
      if ("msg" in resJson) msg = String(resJson["msg"]);
    } catch (error) {
      success = false;
      msg = logApiError(error);
    }
    return [success, msg, resJson];
  }

  /** 获取图片加密文件地址（对应 encryption），sign 走 xhs_creator_sign.js 的 urlSing */
  async encryption(fileId: string, proxies: Proxies = null): Promise<[boolean, string, JsonObject | null]> {
    let resJson: JsonObject | null = null;
    let success = false;
    let msg = "";
    try {
      const api = "/web_api/sns/v5/creator/file/encryption";
      const params = {
        file_id: fileId,
        type: "image",
        ts: String(Math.floor(Date.now())),
        sign: creatorUrlSing(fileId),
      };
      const spliceApi = spliceStrCreator(api, params);
      const [headers, cookies] = await this.requestParams(spliceApi, "", "GET", {
        targetOrigin: this.xhsWebUrl,
      });
      const response = await this.http.get(this.xhsWebUrl + spliceApi, {
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

  /** 发布图文或视频笔记（对应 post_note）；登录和签名参数由 this.auth 自动提供 */
  async postNote(noteInfo: NoteInfo, proxies: Proxies = null): Promise<[boolean, string, JsonObject | null]> {
    const postApi = "/web_api/sns/v2/note";
    const title = noteInfo.title !== undefined ? noteInfo.title : "";
    const desc = noteInfo.desc !== undefined ? noteInfo.desc : "";
    const postTime = noteInfo.postTime ?? null;
    const location = noteInfo.location ?? null;
    const privacyType = noteInfo.type !== undefined ? noteInfo.type : 1;
    const mediaType = noteInfo.media_type !== undefined ? noteInfo.media_type : "image";

    let postLoc: JsonObject = {};
    if (location !== null && location !== undefined) {
      const [success, msg, locationInfo] = await this.getLocationInfo(location, proxies);
      if (!success) throw new Error(msg);
      const poiList = ((locationInfo ?? {})["data"] ?? {})["poi_list"] ?? [];
      if (poiList.length === 0) throw new Error("未找到该地点");
      const poi = poiList[0];
      postLoc = {
        name: poi["name"],
        subname: poi["full_address"],
        poi_id: poi["poi_id"],
        poi_type: poi["poi_type"],
      };
    }

    let data: Record<string, any>;
    if (mediaType === "video") {
      const video = noteInfo.video;
      if (!video) throw new Error('video media requires noteInfo["video"]');
      const [cover, metadata] = await this.extractVideoCoverAndMetadata(video);
      const [ok1, msg1, fileInfo] = await this.uploadMedia(video, mediaType, proxies);
      if (!ok1) throw new Error(msg1);
      const [ok2, msg2, coverInfo] = await this.uploadMedia(cover, "image", proxies);
      if (!ok2) throw new Error(msg2);
      let transcodeReady = false;
      for (let i = 0; i < TRANSCODE_MAX_RETRIES; i++) {
        const [ok3, msg3, res] = await this.queryTranscode(fileInfo!.video_id, proxies);
        if (!ok3) {
          // query_transcode 需要 PC 侧 web_session（Creator 登录只发 creator 系
          // Cookie，401 无登录信息）。2026-07-25 实证跳过轮询直接发布可成功——
          // 服务端异步转码，等待仅为封面建议。
          console.warn(`转码查询不可用（${msg3}），跳过等待直接发布`);
          transcodeReady = true;
          break;
        }
        const dataInfo = (res ?? {})["data"] ?? {};
        if (
          dataInfo["hasFirstFrame"] === true ||
          dataInfo["has_first_frame"] === true ||
          dataInfo["firstFrameFileId"] ||
          dataInfo["first_frame_file_id"] ||
          [2, "success", "SUCCESS"].includes(dataInfo["status"]) ||
          !Object.keys(dataInfo).length
        ) {
          transcodeReady = true;
          break;
        }
        await sleep(TRANSCODE_RETRY_DELAY);
      }
      if (!transcodeReady) throw new Error("video transcode not ready after polling");
      data = getPostNoteVideoData(title, desc, postTime, postLoc, privacyType as string, fileInfo!, coverInfo!, metadata);
    } else {
      const images = noteInfo.images ?? [];
      if (!images.length) throw new Error('image media requires noteInfo["images"]');
      const fileInfos: UploadMediaResult[] = [];
      for (const image of images) {
        const [ok, msg, fileInfo] = await this.uploadMedia(image, mediaType, proxies);
        if (!ok) throw new Error(msg);
        fileInfos.push(fileInfo!);
      }
      data = getPostNoteImageData(title, desc, postTime, postLoc, privacyType as string, fileInfos);
    }

    // 浏览器实抓（2026-07-25 reqid=5609）：未选地点时 common 里不带 post_loc 键；
    // 发空对象 {} 会被服务端以 参数错误(result=-9059) 打回。
    if (!Object.keys(postLoc).length) {
      delete data["common"]["post_loc"];
    }

    const topics = noteInfo.topics ?? [];
    for (const topic of topics) {
      const [ok, msg, resJson] = await this.getTopic(topic, proxies);
      if (!ok) throw new Error(msg);
      if (resJson!["data"]["topic_info_dtos"].length === 0) throw new Error(`未找到话题${topic}`);
      const topicInfo = resJson!["data"]["topic_info_dtos"][0];
      const insertTopic = {
        id: topicInfo["id"],
        link: topicInfo["link"],
        name: topicInfo["name"],
        type: "topic",
      };
      data["common"]["hash_tag"].push(insertTopic);
      data["common"]["desc"] += ` #${insertTopic["name"]}[话题]# `;
    }

    // 浏览器实抓（2026-07-25 reqid=5609）：post_note 的 referer 是站点根路径
    // "https://creator.xiaohongshu.com/"，不是发布页完整 URL（fetch 封装层
    // 默认行为）；permit 请求才带发布页 URL。
    const [headers, cookies, body] = await this.requestParams(postApi, data, "POST", {
      referer: `${this.baseUrl}/`,
      targetOrigin: this.edithUrl,
      orderWireHeaders: false,
    });
    // x-rap-param：信封算法与 PC 相同（rap.js 已字节级验证），但 Creator
    // 发布接口的指纹模板不同（436B，含键盘遥测/特征位；从浏览器 post_note
    // 信封 AES 解密获得）。PC homefeed 的 219B 模板会被服务端以
    // 参数错误(result=-9059) 打回；Creator 模板 + 每次随机 Uuid。
    headers["x-rap-param"] = generateXRapParamValue(postApi, body, undefined, loadCreatorRapFingerprintHex());

    // 发布接口同样存在按请求的概率性边缘拒绝（code=-1）：同会话重发可过
    // （14:38 拒、14:40 同 Cookie 过，实证），做有限次重试；业务性错误
    // （如 -9059 参数错误）不重试。
    let resJson: JsonObject | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await this.http.post(this.edithUrl + postApi, {
        headers,
        data: body,
        cookies,
        proxies: this._proxies(proxies),
        timeout: REQUEST_TIMEOUT,
      });
      resJson = response.json<JsonObject>();
      if (resJson["success"]) break;
      if (resJson["code"] !== -1) break;
      console.warn(`发布被边缘拒绝（code=-1），重发 (${attempt + 1}/3)`);
    }
    // 成功响应为 {"result":0,"success":true,"msg":"",...}，部分响应缺 msg 字段
    const success = Boolean(resJson!["success"]);
    const msg = String(resJson!["msg"] || resJson!["message"] || (success ? "成功" : "发布失败"));
    return [success, msg, resJson];
  }

  /**
   * 取文件字节数与图片尺寸（对应 get_file_info；图片解码用 sharp 替代 cv2.imdecode，
   * 见重构文档 §5.4）
   * @returns image: [width, height, file, fileSize]；video: [file, fileSize]
   */
  async getFileInfo(file: Buffer, mediaType: "image"): Promise<[number, number, Buffer, number]>;
  async getFileInfo(file: Buffer, mediaType?: string): Promise<[Buffer, number]>;
  async getFileInfo(file: Buffer, mediaType = "image"): Promise<[number, number, Buffer, number] | [Buffer, number]> {
    const fileSize = file.length;
    if (mediaType === "image") {
      const metadata = await sharp(file, { failOn: "none" }).metadata();
      if (!metadata.width || !metadata.height) {
        throw new Error("image decode failed");
      }
      const width = metadata.width;
      let height = metadata.height;
      if (width > 2 * height) {
        height = Math.floor(width / 2);
      }
      return [width, height, file, fileSize];
    }
    return [file, fileSize];
  }

  /**
   * 抽取视频首帧封面与元数据（对应 extract_video_cover_and_metadata；
   * cv2.VideoCapture 由 ffprobe + ffmpeg 替代，见重构文档 §5.4）
   */
  async extractVideoCoverAndMetadata(video: Buffer): Promise<[Buffer, Record<string, unknown>]> {
    const tempDir = await mkdtemp(join(tmpdir(), "xhs-cover-"));
    const tempPath = join(tempDir, "input.mp4");
    const coverPath = join(tempDir, "cover.jpg");
    try {
      await writeFile(tempPath, video);
      const info = await getVideoMetadata(tempPath);
      if (!info) throw new Error("video decode failed");
      const fps = info.fps || 0;
      const durationMs = info.durationMs;
      const width = info.width || 0;
      const height = info.height || 0;
      const ok = await extractVideoCover(tempPath, coverPath);
      if (!ok) throw new Error("video cover frame decode failed");
      const encoded = await readFile(coverPath);
      const metadata: Record<string, unknown> = {
        video: {
          bitrate: null,
          colour_primaries: "BT.709",
          duration: durationMs,
          format: "AVC",
          frame_rate: fps ? Math.round(fps * 1000) / 1000 : 0,
          height,
          matrix_coefficients: "BT.709",
          rotation: 0,
          transfer_characteristics: "BT.709",
          width,
        },
        audio: {
          bitrate: null,
          channels: 2,
          duration: durationMs,
          format: "AAC",
          sampling_rate: 48000,
        },
      };
      return [encoded, metadata];
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  /**
   * 获取 Creator 笔记管理页的一页已发布作品（对应 get_posted_notes_page）
   * 当前页面首请求固定传 page=0；响应 data.page 是下一页游标，-1 表示结束。
   * 签名使用作品管理页对应的本地 b1 profile。
   */
  async getPostedNotesPage(page = 0, tab = 0, proxies: Proxies = null): Promise<[boolean, string, JsonObject | null]> {
    let resJson: JsonObject | null = null;
    let success = false;
    let msg = "";
    try {
      const api = "/api/galaxy/v2/creator/note/user/posted";
      const params = {
        tab: String(Math.floor(Number(tab))),
        page: String(Math.floor(Number(page ?? 0))),
      };
      const spliceApi = spliceStrCreator(api, params);
      const mnsProfile = this._noteManagerSigned ? "note_manager_steady" : "note_manager";
      const [headers, cookies] = await this.requestParams(spliceApi, "", "GET", {
        referer: CREATOR_NOTE_MANAGER_REFERER,
        secFetchSite: "same-origin",
        b1Profile: "note_manager",
        mnsProfile,
      });
      this._noteManagerSigned = true;
      const wireHeaders = creatorNoteManagerHeaders(headers, this.auth.cookiesForUrl(this.baseUrl + spliceApi, cookies));
      const response = await this.http.get(this.baseUrl + spliceApi, {
        headers: wireHeaders,
        proxies: this._proxies(proxies),
        timeout: REQUEST_TIMEOUT,
      });
      resJson = response.json<JsonObject>();
      success = Boolean(resJson["success"]);
      if (success) {
        msg = String(resJson["msg"] || "成功");
      } else {
        const code = resJson["code"] ?? "unknown";
        const status = response.statusCode;
        msg = String(resJson["msg"] || resJson["message"] || `获取作品列表失败 (HTTP ${status}, code=${code})`);
      }
    } catch (error) {
      success = false;
      msg = logApiError(error);
    }
    return [success, msg, resJson];
  }

  /** 兼容旧方法名（对应 get_publish_note_info）；等价于 getPostedNotesPage */
  async getPublishNoteInfo(page = 0, proxies: Proxies = null): Promise<[boolean, string, JsonObject | null]> {
    return this.getPostedNotesPage(page, 0, proxies);
  }

  /** 按服务端游标获取全部已发布作品，返回扁平 notes 列表（对应 get_all_posted_notes） */
  async getAllPostedNotes(tab = 0, proxies: Proxies = null): Promise<[boolean, string, JsonObject[]]> {
    let page = 0;
    const notes: JsonObject[] = [];
    const seenPages = new Set<number>();
    while (true) {
      if (seenPages.has(page)) {
        return [false, `作品列表返回重复分页游标: ${page}`, notes];
      }
      seenPages.add(page);
      const [success, msg, resJson] = await this.getPostedNotesPage(page, tab, proxies);
      if (!success) return [false, msg, notes];
      const data = (resJson ?? {})["data"] ?? {};
      const pageNotes = data["notes"] ?? [];
      if (!Array.isArray(pageNotes)) {
        return [false, "作品列表 data.notes 不是数组", notes];
      }
      notes.push(...pageNotes);
      const nextPage = data["page"] ?? -1;
      const parsedPage = Number(nextPage);
      if (Number.isNaN(parsedPage)) {
        return [false, `作品列表分页游标无效: ${JSON.stringify(nextPage)}`, notes];
      }
      page = parsedPage;
      if (page === -1) break;
    }
    return [true, "成功", notes];
  }

  /** 兼容旧方法名（对应 get_all_publish_note_info）；等价于 getAllPostedNotes */
  async getAllPublishNoteInfo(proxies: Proxies = null): Promise<[boolean, string, JsonObject[]]> {
    return this.getAllPostedNotes(0, proxies);
  }
}

/** 对齐原版模块尾部别名 XHSCreatorApis = XHS_Creator_Apis */
export { XhsCreatorApis as XHSCreatorApis };
