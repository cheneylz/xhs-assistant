import { getCurrentUser } from "@/lib/server/core/auth";
import { getConfig } from "@/lib/server/core/config";
import { notFound } from "@/lib/server/core/http-error";
import { handle, readJson } from "@/lib/server/core/route";
import { composeCoverImage } from "@/lib/server/media/image-util";
import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { z } from "zod";

const ComposeImageSchema = z.object({
  title: z.string().min(1).max(120),
  body: z.string().max(800).default(""),
  width: z.number().int().min(320).max(2400).default(1080),
  height: z.number().int().min(320).max(3200).default(1440),
  background_color: z.string().max(16).default("#fafaf8"),
  accent_color: z.string().max(16).default("#111111"),
});

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

function mediaDir(): string {
  return `${getConfig().storageDir}/media`;
}

/** POST /api/files/images/compose 封面合成（对应原版 compose_image） */
export const POST = handle(async (req) => {
  const user = await getCurrentUser(req);
  const payload = await readJson(req, ComposeImageSchema);
  const fileName = `xhs-image-u${user.id}-${randomBytes(16).toString("hex")}.png`;
  await composeCoverImage({
    outputPath: `${mediaDir()}/${fileName}`,
    title: payload.title,
    body: payload.body,
    width: payload.width,
    height: payload.height,
    backgroundColor: payload.background_color,
    accentColor: payload.accent_color,
  });
  return NextResponse.json(serializeMediaFile(fileName, payload.width, payload.height));
});
