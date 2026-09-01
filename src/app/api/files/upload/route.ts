import { getCurrentUser } from "@/lib/server/core/auth";
import { getConfig } from "@/lib/server/core/config";
import { badRequest } from "@/lib/server/core/http-error";
import { handle, readFormData } from "@/lib/server/core/route";
import { NextResponse } from "next/server";
import { mkdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

const ALLOWED_UPLOAD_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".mp4", ".mov", ".avi", ".mkv"]);
// 上限 500MB，对齐小红书网页端上传规格（视频素材）
const MAX_UPLOAD_SIZE = 500 * 1024 * 1024;

/** POST /api/files/upload 文件上传（对应原版 upload_file） */
export const POST = handle(async (req) => {
  const user = await getCurrentUser(req);
  const form = await readFormData(req);
  const file = form.get("file");
  if (!(file instanceof File) || !file.name) {
    throw badRequest("文件名不能为空");
  }
  const ext = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
  if (!ALLOWED_UPLOAD_EXTENSIONS.has(ext)) {
    throw badRequest(`不支持的文件格式: ${ext}`);
  }
  const content = Buffer.from(await file.arrayBuffer());
  if (content.length > MAX_UPLOAD_SIZE) {
    throw badRequest("文件大小超过 500MB 限制");
  }
  const assetType = [".mp4", ".mov", ".avi", ".mkv"].includes(ext) ? "video" : "image";
  const fileName = `xhs-upload-u${user.id}-${randomBytes(16).toString("hex")}${ext}`;
  const mediaDir = `${getConfig().storageDir}/media`;
  mkdirSync(mediaDir, { recursive: true });
  writeFileSync(`${mediaDir}/${fileName}`, content);
  return NextResponse.json({
    file_name: fileName,
    file_path: `${mediaDir}/${fileName}`,
    download_url: `/api/files/media/${fileName}`,
    asset_type: assetType,
    size: content.length,
  });
});
