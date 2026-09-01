/**
 * 素材本地下载（对应原版 backend/app/services/asset_downloader.py）
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { getConfig } from "../core/config";

function guessExtension(url: string, contentType: string, assetType: string): string {
  const ct = contentType.toLowerCase();
  if (ct.includes("jpeg") || ct.includes("jpg")) return ".jpg";
  if (ct.includes("png")) return ".png";
  if (ct.includes("gif")) return ".gif";
  if (ct.includes("webp")) return ".webp";
  if (ct.includes("mp4")) return ".mp4";
  if (ct.includes("quicktime") || ct.includes("mov")) return ".mov";
  const lowerUrl = url.toLowerCase().split("?")[0];
  for (const ext of [".jpg", ".jpeg", ".png", ".gif", ".webp", ".mp4", ".mov"]) {
    if (lowerUrl.endsWith(ext)) return ext;
  }
  return assetType === "video" ? ".mp4" : ".jpg";
}

/** 下载素材到本地 media 目录，返回文件名（失败返回 null） */
export async function downloadAssetToLocal(url: string, userId: number, assetType: string): Promise<string | null> {
  if (!url || !url.startsWith("http")) return null;
  try {
    const response = await fetch(url, {
      headers: { Referer: "" },
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) return null;
    const content = Buffer.from(await response.arrayBuffer());
    if (content.length < 100) return null;
    const ext = guessExtension(url, response.headers.get("content-type") ?? "", assetType);
    const fileName = `xhs-asset-u${userId}-${randomUUID().replace(/-/g, "")}${ext}`;
    const mediaDir = `${getConfig().storageDir}/media`;
    mkdirSync(mediaDir, { recursive: true });
    writeFileSync(`${mediaDir}/${fileName}`, content);
    return fileName;
  } catch (error) {
    console.warn(`Asset download failed for ${url.slice(0, 80)}: ${(error as Error).message}`);
    return null;
  }
}
