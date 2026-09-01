/**
 * Creator 发布 / 上传负载构造（对应原版 xhs_creator_util.py）
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const creatorRapTemplate = require("../js/creator/rap_fingerprint_creator.json") as { bodyUnmaskedHex: string };

const ALPHABET36 = "0123456789abcdefghijklmnopqrstuvwxyz";

/** 加载 Creator 发布接口的 rap 指纹模板（03ea 段 16 字符会话 Uuid 每次随机化） */
export function loadCreatorRapFingerprintHex(): string {
  const raw = Buffer.from(creatorRapTemplate.bodyUnmaskedHex, "hex");
  if (raw.subarray(0, 6).toString("hex") !== "03ea00000010") {
    throw new Error("creator rap fingerprint template 03ea Uuid section not found");
  }
  let uuid = "";
  for (let i = 0; i < 16; i++) {
    uuid += ALPHABET36[Math.floor(Math.random() * ALPHABET36.length)];
  }
  Buffer.from(uuid, "ascii").copy(raw, 6);
  return raw.toString("hex");
}

/** Creator 上传签名（getSignature：HmacSHA1 三段式，对应 xhs_creator_signature.js） */
export function getUploadSignature(message: string, fileId: string, contentLength: number, host = "ros-upload.xiaohongshu.com"): string {
  const modulePath = join(dirname(fileURLToPath(import.meta.url)), "..", "js", "creator", "xhs_creator_signature.js");
  // 原文件无 module.exports，加载后追加导出
  const { readFileSync } = require("node:fs");
  const source = readFileSync(modulePath, "utf-8") + "\n;module.exports = { getSignature };";
  const mod = { exports: {} as Record<string, unknown> };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const fn = new Function("module", "exports", "require", source) as (m: unknown, e: unknown, r: unknown) => void;
  fn(mod, mod.exports, require);
  const getSignature = mod.exports.getSignature as (message: string, fileId: string, contentLength: number, host?: string) => string;
  return getSignature(message, fileId, contentLength, host);
}

/** 上传场景参数（对应 get_fileIds_params） */
export function getFileIdsParams(scene: string): Record<string, string> {
  return {
    biz_name: "spectrum",
    scene,
    file_count: "1",
    version: "1",
    source: "web",
  };
}

/** 上传媒体请求头（对应 get_upload_media_headers） */
export function getUploadMediaHeaders(
  message: string,
  signature: string,
  token: string,
  options: { userAgent: string; uploadHost?: string },
): Record<string, string> {
  const secFetchSite = String(options.uploadHost ?? "").includes("xhscdn.com") ? "cross-site" : "same-site";
  return {
    accept: "*/*",
    "accept-encoding": "gzip, deflate, br, zstd",
    "accept-language": "zh-CN,zh;q=0.9,en;q=0.8,zh-TW;q=0.7,ja;q=0.6",
    authorization: `q-sign-algorithm=sha1&q-ak=null&q-sign-time=${message}&q-key-time=${message}&q-header-list=content-length;host&q-url-param-list=&q-signature=${signature}`,
    "cache-control": "",
    "content-type": "",
    origin: "https://creator.xiaohongshu.com",
    referer: "https://creator.xiaohongshu.com/",
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": secFetchSite,
    "user-agent": options.userAgent,
    "x-cos-security-token": token,
  };
}

interface FileInfo {
  fileIds: string;
  width?: number;
  height?: number;
  mime_type?: string;
  file_size?: number;
}

/** 图集发布数据（对应 get_post_note_image_data） */
export function getPostNoteImageData(
  title: string,
  desc: string,
  postTime: string | null,
  postLoc: unknown,
  privacyType: string,
  fileInfos: FileInfo[],
): Record<string, unknown> {
  const businessBinds = postTime === null || postTime === undefined
    ? '{"version":1,"noteId":0,"bizType":0,"noteOrderBind":{},"notePostTiming":{},"noteCollectionBind":{"id":""},"noteSketchCollectionBind":{"id":""},"coProduceBind":{"enable":true},"noteCopyBind":{"copyable":true},"interactionPermissionBind":{"commentPermission":0},"optionRelationList":[]}'
    : `{"version":1,"noteId":0,"bizType":13,"noteOrderBind":{},"notePostTiming":{"postTime":"${postTime}"},"noteCollectionBind":{"id":""}}`;
  const images = fileInfos.map((fileInfo) => ({
    file_id: `spectrum/${fileInfo.fileIds}`,
    width: fileInfo.width ?? 0,
    height: fileInfo.height ?? 0,
    metadata: { source: -1 },
    stickers: { version: 2, floating: [] },
    extra_info_json: JSON.stringify({
      mimeType: fileInfo.mime_type ?? "image/png",
      image_metadata: {
        bg_color: "",
        origin_size: (fileInfo.file_size ?? 0) / 1024,
      },
    }),
  }));
  const contextJson = JSON.stringify({
    recommend_title: { recommend_title_id: "", is_use: 3, used_index: -1 },
    recommendTitle: [],
    recommend_topics: { used: [] },
  });
  return {
    common: {
      type: "normal",
      title,
      note_id: "",
      desc,
      source: '{"type":"web","ids":"","extraInfo":"{\\"subType\\":\\"official\\",\\"systemId\\":\\"web\\"}"}',
      business_binds: businessBinds,
      ats: [],
      hash_tag: [],
      post_loc: postLoc,
      privacy_info: { op_type: 1, type: privacyType, user_ids: [] },
      goods_info: {},
      biz_relations: [],
      capa_trace_info: { contextJson },
    },
    image_info: { images },
    video_info: null,
  };
}

/** 地点搜索数据（对应 get_loc_data） */
export function getLocData(keyword: string): Record<string, unknown> {
  return {
    latitude: 31.161327166987615,
    longitude: 121.45301809352632,
    keyword,
    page: 1,
    size: 50,
    source: "WEB",
    type: 3,
  };
}

/** 视频发布数据（对应 get_post_note_video_data） */
export function getPostNoteVideoData(
  title: string,
  desc: string,
  postTime: string | null,
  postLoc: unknown,
  privacyType: string,
  fileInfo: FileInfo,
  coverInfo: FileInfo,
  metadata?: Record<string, unknown> | null,
): Record<string, unknown> {
  const businessBinds = postTime === null || postTime === undefined
    ? '{"version":1,"noteId":0,"bizType":0,"noteOrderBind":{},"notePostTiming":{},"noteCollectionBind":{"id":""},"noteSketchCollectionBind":{"id":""},"coProduceBind":{"enable":true},"noteCopyBind":{"copyable":true},"interactionPermissionBind":{"commentPermission":0},"optionRelationList":[]}'
    : `{"version":1,"noteId":0,"bizType":13,"noteOrderBind":{},"notePostTiming":{"postTime":"${postTime}"},"noteCollectionBind":{"id":""}}`;
  const meta = metadata ?? {};
  const videoMeta: Record<string, unknown> = (meta.video as Record<string, unknown>) ?? {
    bitrate: null,
    colour_primaries: "BT.709",
    duration: 0,
    format: "AVC",
    frame_rate: 0,
    height: fileInfo.height ?? 0,
    matrix_coefficients: "BT.709",
    rotation: 0,
    transfer_characteristics: "BT.709",
    width: fileInfo.width ?? 0,
  };
  const audioMeta: Record<string, unknown> = (meta.audio as Record<string, unknown>) ?? {
    bitrate: null,
    channels: 2,
    duration: videoMeta.duration ?? 0,
    format: "AAC",
    sampling_rate: 48000,
  };
  const durationSeconds = Math.round(Number(videoMeta.duration ?? 0) / 1000 * 1000) / 1000;
  const videoFileId = `spectrum/${fileInfo.fileIds}`;
  const coverFileId = `spectrum/${coverInfo.fileIds}`;
  return {
    common: {
      type: "video",
      title,
      note_id: "",
      desc,
      source: '{"type":"web","ids":"","extraInfo":"{\\"subType\\":\\"official\\",\\"systemId\\":\\"web\\"}"}',
      business_binds: businessBinds,
      ats: [],
      hash_tag: [],
      post_loc: postLoc,
      privacy_info: { op_type: 1, type: privacyType, user_ids: [] },
      goods_info: {},
      biz_relations: [],
      capa_trace_info: {
        contextJson: '{"recommend_title":{"recommend_title_id":"","is_use":3,"used_index":-1},"recommendTitle":[],"recommend_topics":{"used":[]}}',
      },
    },
    image_info: null,
    video_info: {
      fileid: videoFileId,
      file_id: videoFileId,
      format_width: videoMeta.width ?? fileInfo.width ?? 0,
      format_height: videoMeta.height ?? fileInfo.height ?? 0,
      video_preview_type: "",
      composite_metadata: { video: videoMeta, audio: audioMeta },
      timelines: [],
      cover: {
        fileid: coverFileId,
        file_id: coverFileId,
        height: coverInfo.height ?? videoMeta.height ?? 0,
        width: coverInfo.width ?? videoMeta.width ?? 0,
        frame: { ts: 0, is_user_select: false, is_upload: false },
        stickers: { version: 2, neptune: [] },
        fonts: [],
        extra_info_json: "{}",
      },
      chapters: [],
      chapter_sync_text: false,
      segments: {
        count: 1,
        need_slice: false,
        items: [
          {
            mute: 0,
            speed: 1,
            start: 0,
            duration: durationSeconds,
            transcoded: 0,
            media_source: 1,
            original_metadata: { video: videoMeta, audio: audioMeta },
          },
        ],
      },
      entrance: "web",
    },
  };
}
