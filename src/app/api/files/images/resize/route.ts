import { getCurrentUser } from "@/lib/server/core/auth";
import { getConfig } from "@/lib/server/core/config";
import { notFound } from "@/lib/server/core/http-error";
import { handle, readJson } from "@/lib/server/core/route";
import { resizeImageFile } from "@/lib/server/media/image-util";
import { NextResponse } from "next/server";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { z } from "zod";

const ResizeImageSchema = z.object({
  source_file_name: z.string().min(1).max(180),
  width: z.number().int().min(128).max(2400).default(1080),
  height: z.number().int().min(128).max(3200).default(1440),
  mode: z.enum(["cover", "contain"]).default("cover"),
  format: z.enum(["png", "jpeg"]).default("png"),
  quality: z.number().int().min(40).max(100).default(90),
});

function mediaDir(): string {
  return `${getConfig().storageDir}/media`;
}

function ownerMediaPrefix(userId: number): string {
  return `xhs-image-u${userId}-`;
}

function mediaType(fileName: string): string {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".mp4")) return "video/mp4";
  if (lower.endsWith(".mov")) return "video/quicktime";
  return "image/png";
}

function serializeMediaFile(fileName: string, width: number, height: number): Record<string, unknown> {
  return {
    file_name: fileName,
    file_path: `${mediaDir()}/${fileName}`,
    download_url: `/api/files/media/${fileName}`,
    width,
    height,
    media_type: mediaType(fileName),
  };
}

function validateOwnerMediaName(fileName: string, userId: number): string {
  if (fileName.split("/").pop() !== fileName || fileName.includes("..")) {
    throw notFound("Media file not found");
  }
  const validPrefixes = [ownerMediaPrefix(userId), `xhs-asset-u${userId}-`, `xhs-upload-u${userId}-`];
  if (!validPrefixes.some((prefix) => fileName.startsWith(prefix))) {
    throw notFound("Media file not found");
  }
  return fileName;
}

/** POST /api/files/images/resize 图片缩放（对应原版 resize_image） */
export const POST = handle(async (req) => {
  const user = await getCurrentUser(req);
  const payload = await readJson(req, ResizeImageSchema);
  const sourceFileName = validateOwnerMediaName(payload.source_file_name, user.id);
  const sourcePath = `${mediaDir()}/${sourceFileName}`;
  if (!existsSync(sourcePath)) throw notFound("Media file not found");

  const extension = payload.format === "jpeg" ? "jpg" : "png";
  const fileName = `${ownerMediaPrefix(user.id)}${randomBytes(16).toString("hex")}.${extension}`;
  await resizeImageFile({
    sourcePath,
    outputPath: `${mediaDir()}/${fileName}`,
    width: payload.width,
    height: payload.height,
    mode: payload.mode,
    imageFormat: payload.format,
    quality: payload.quality,
  });
  return NextResponse.json(serializeMediaFile(fileName, payload.width, payload.height));
});
