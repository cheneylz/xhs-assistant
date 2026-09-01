import { getCurrentUser } from "@/lib/server/core/auth";
import { getConfig } from "@/lib/server/core/config";
import { badRequest, notFound } from "@/lib/server/core/http-error";
import { handle } from "@/lib/server/core/route";
import { NextResponse } from "next/server";
import { readFileSync, existsSync, rmSync } from "node:fs";

function mediaDir(): string {
  return `${getConfig().storageDir}/media`;
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

/** 校验媒体文件名（防路径穿越） */
function resolveMediaFile(fileName: string): string {
  if (fileName.split("/").pop() !== fileName || fileName.includes("..")) {
    throw notFound("Media file not found");
  }
  const filePath = `${mediaDir()}/${fileName}`;
  if (!existsSync(filePath)) throw notFound("Media file not found");
  return filePath;
}

/** GET /api/files/media/{file_name} 媒体文件下载（对应原版 download_media） */
export const GET = handle(async (_req, { params }) => {
  const filePath = resolveMediaFile(params.fileName);
  const body = readFileSync(filePath);
  return new NextResponse(new Uint8Array(body), {
    headers: {
      "Content-Type": mediaType(params.fileName),
      "Content-Disposition": `inline; filename="${params.fileName}"`,
      "Content-Length": String(body.length),
    },
  });
});

/** DELETE /api/files/media/{file_name} 删除自己的媒体文件（上传/转码/封面产物，防越权） */
export const DELETE = handle(async (req, { params }) => {
  const user = await getCurrentUser(req);
  const fileName = params.fileName;
  const prefixes = [`xhs-upload-u${user.id}-`, `xhs-transcode-u${user.id}-`, `xhs-cover-u${user.id}-`];
  if (!prefixes.some((p) => fileName.startsWith(p))) {
    throw badRequest("只能删除自己的媒体文件");
  }
  const filePath = resolveMediaFile(fileName);
  rmSync(filePath);
  return NextResponse.json({ ok: true });
});
