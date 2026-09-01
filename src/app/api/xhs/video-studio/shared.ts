import { getConfig } from "@/lib/server/core/config";
import { badRequest, notFound } from "@/lib/server/core/http-error";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";

/** 校验并解析上传的视频文件（防路径穿越 + 归属校验），返回本地绝对路径 */
export function resolveUploadedVideoPath(userId: number, fileName: string): string {
  if (!fileName || fileName.includes("/") || fileName.includes("\\") || fileName.includes("..")) {
    throw badRequest("非法的文件路径");
  }
  // 上传文件名统一为 xhs-upload-u{userId}-{hex}{ext}，校验归属防越权
  if (!fileName.startsWith(`xhs-upload-u${userId}-`)) {
    throw notFound("文件不存在");
  }
  const filePath = `${getConfig().storageDir}/media/${fileName}`;
  if (!existsSync(filePath)) throw notFound("文件不存在");
  return filePath;
}

/** 生成视频工坊产物文件名（封面 jpg / 转码 mp4） */
export function generatedFileName(userId: number, prefix: string, ext: string): string {
  return `${prefix}-u${userId}-${randomBytes(16).toString("hex")}${ext}`;
}
