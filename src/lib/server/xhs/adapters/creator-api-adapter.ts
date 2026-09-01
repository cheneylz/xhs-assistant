/**
 * Creator API 适配器（对应原版 backend/app/adapters/xhs/creator_api_adapter.py）
 */
import { existsSync, readFileSync } from "node:fs";
import sharp from "sharp";
import { getConfig } from "../../core/config";
import { withDirectXhsRequestEnv } from "../request-env";
import { XHSCreatorAuth } from "../creator/auth";
import { XhsCreatorApis } from "../creator/api";
import { getPostNoteImageData, loadCreatorRapFingerprintHex } from "../creator/publish";
import { generateXRapParamValue } from "../pc/params";

export class XhsCreatorApiAdapter {
  cookies: string;

  constructor(cookies: string) {
    this.cookies = cookies;
  }

  private api(): XhsCreatorApis {
    const auth = XHSCreatorAuth.fromCookie(this.cookies);
    return new XhsCreatorApis(auth);
  }

  /** 话题搜索（对应 get_topic） */
  async getTopic(keyword: string): Promise<[boolean, string, Record<string, unknown> | null]> {
    return withDirectXhsRequestEnv(async () => {
      return this.api().getTopic(keyword) as Promise<[boolean, string, Record<string, unknown> | null]>;
    });
  }

  /** 地点搜索（对应 get_location_info） */
  async getLocationInfo(keyword: string): Promise<[boolean, string, Record<string, unknown> | null]> {
    return withDirectXhsRequestEnv(async () => {
      return this.api().getLocationInfo(keyword) as Promise<[boolean, string, Record<string, unknown> | null]>;
    });
  }

  /** 已发布笔记（对应 get_published_notes） */
  async getPublishedNotes(): Promise<[boolean, string, unknown]> {
    return withDirectXhsRequestEnv(async () => {
      return this.api().getAllPostedNotes();
    });
  }

  /** 上传媒体（对应 upload_media，返回 Creator 上传结果 dict） */
  async uploadMedia(filePath: string, mediaType: string): Promise<Record<string, unknown>> {
    const fileData = await this.resolveFileData(filePath);
    return withDirectXhsRequestEnv(async () => {
      const [success, message, payload] = await this.api().uploadMedia(fileData, mediaType);
      if (!success) throw new Error(message || "Creator media upload failed");
      return (payload ?? {}) as Record<string, unknown>;
    });
  }

  /** 发布笔记（对应 post_note，含已上传图片路径） */
  async postNote(noteInfo: Record<string, unknown>): Promise<Record<string, unknown>> {
    return withDirectXhsRequestEnv(async () => {
      if (noteInfo.media_type === "image" && noteInfo.image_file_infos) {
        return this.postUploadedImageNote(noteInfo);
      }
      const [success, message, payload] = await this.api().postNote(noteInfo as never);
      if (!success) throw new Error(message || "Creator note publish failed");
      return (payload ?? {}) as Record<string, unknown>;
    });
  }

  /** 已上传图片笔记发布（对应 _post_uploaded_image_note） */
  private async postUploadedImageNote(noteInfo: Record<string, unknown>): Promise<Record<string, unknown>> {
    const api = this.api();
    const postApi = "/web_api/sns/v2/note";
    let postLoc: Record<string, unknown> = {};
    const location = noteInfo.location;
    if (location && typeof location === "object" && !Array.isArray(location)) {
      postLoc = location as Record<string, unknown>;
    } else if (typeof location === "string" && location.trim()) {
      const [success, message, locationInfo] = await api.getLocationInfo(location.trim());
      if (!success) throw new Error(message || "Creator location lookup failed");
      const dataObj = ((locationInfo ?? {}) as Record<string, unknown>).data;
      const data = dataObj && typeof dataObj === "object" ? (dataObj as Record<string, unknown>) : {};
      const poiList = Array.isArray(data.poi_list) ? data.poi_list : [];
      if (!poiList.length) throw new Error("未找到该地点");
      const poi = poiList[0] as Record<string, unknown>;
      postLoc = {
        name: poi.name,
        subname: poi.full_address,
        poi_id: poi.poi_id,
        poi_type: poi.poi_type,
      };
    }
    const data = getPostNoteImageData(
      String(noteInfo.title ?? ""),
      String(noteInfo.desc ?? ""),
      noteInfo.postTime !== undefined && noteInfo.postTime !== null ? String(noteInfo.postTime) : null,
      postLoc,
      String(noteInfo.type ?? 1),
      ((noteInfo.image_file_infos as unknown) ?? []) as never,
    );
    // 浏览器实抓：未选地点时省略 post_loc 键
    if (!Object.keys(postLoc).length) {
      delete (data.common as Record<string, unknown>).post_loc;
    }
    for (const topic of Array.isArray(noteInfo.topics) ? noteInfo.topics : []) {
      if (typeof topic !== "string" || !topic.trim()) continue;
      const [success, message, topicPayload] = await api.getTopic(topic.trim());
      if (!success) throw new Error(message || "Creator topic lookup failed");
      const dataObj = ((topicPayload ?? {}) as Record<string, unknown>).data;
      const topicData = dataObj && typeof dataObj === "object" ? (dataObj as Record<string, unknown>) : {};
      const topicItems = Array.isArray(topicData.topic_info_dtos) ? topicData.topic_info_dtos : [];
      if (!topicItems.length) throw new Error(`未找到话题${topic}`);
      const item = topicItems[0] as Record<string, unknown>;
      const insertTopic = {
        id: item.id,
        link: String(item.link ?? ""),
        name: item.name,
        type: "topic",
      };
      const common = data.common as Record<string, unknown>;
      common.hash_tag = [...(((common.hash_tag as unknown[]) ?? [])), insertTopic];
      common.desc = String(common.desc) + ` #${insertTopic.name}[话题]# `;
    }
    const [headers, cookies, body] = await api.requestParams(postApi, data, "POST", {
      referer: `${api.baseUrl}/`,
      targetOrigin: api.edithUrl,
      orderWireHeaders: false,
    });
    headers["x-rap-param"] = generateXRapParamValue(postApi, body, null, loadCreatorRapFingerprintHex());
    const response = await api.http.post(api.edithUrl + postApi, {
      headers,
      data: Buffer.from(body, "utf-8"),
      cookies,
      timeout: 15000,
    });
    const payload = response.json<Record<string, unknown>>();
    if (!payload.success) {
      throw new Error(String(payload.msg ?? payload.message ?? "Creator note publish failed"));
    }
    return payload;
  }

  /** 解析素材文件数据（对应 _resolve_file_data，webp 转 jpeg quality 92） */
  private async resolveFileData(filePath: string): Promise<Buffer> {
    let rawBytes: Buffer | null = null;
    if (filePath.startsWith("http://") || filePath.startsWith("https://")) {
      // 网络 URL 由调用方保证可下载（同步适配器不发起网络下载）
      throw new Error(`网络素材需先下载到本地: ${filePath}`);
    }
    if (filePath.startsWith("/api/files/media/")) {
      const fileName = filePath.split("/").pop() ?? "";
      const local = `${getConfig().storageDir}/media/${fileName}`;
      if (existsSync(local)) rawBytes = readFileSync(local);
    } else if (existsSync(filePath)) {
      rawBytes = readFileSync(filePath);
    }
    if (!rawBytes) throw new Error(`素材文件不存在: ${filePath}`);
    const lower = filePath.toLowerCase();
    if (lower.endsWith(".webp") || (rawBytes.length > 4 && rawBytes.subarray(0, 4).toString("latin1") === "RIFF")) {
      try {
        return await sharp(rawBytes).rotate().jpeg({ quality: 92 }).toBuffer();
      } catch {
        // 转换失败保留原字节
      }
    }
    return rawBytes;
  }
}
