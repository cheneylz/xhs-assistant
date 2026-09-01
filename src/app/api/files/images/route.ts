import { getCurrentUser } from "@/lib/server/core/auth";
import { getConfig } from "@/lib/server/core/config";
import { handle } from "@/lib/server/core/route";
import { NextResponse } from "next/server";
import { readdirSync, statSync } from "node:fs";

/** 用户图片目录 */
function mediaDir(): string {
  return `${getConfig().storageDir}/media`;
}

/** GET /api/files/images 用户上传图片列表（对应原版 list_user_images） */
export const GET = handle(async (req) => {
  const user = await getCurrentUser(req);
  const prefix = `xhs-upload-u${user.id}-`;
  const imageExts = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);
  const files: Array<Record<string, unknown>> = [];
  const dir = mediaDir();
  try {
    const entries = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => name.startsWith(prefix) && imageExts.has(name.slice(name.lastIndexOf(".")).toLowerCase()))
      .sort((a, b) => statSync(`${dir}/${b}`).mtimeMs - statSync(`${dir}/${a}`).mtimeMs);
    for (const name of entries) {
      files.push({ file_name: name, url: `/api/files/media/${name}`, size: statSync(`${dir}/${name}`).size });
    }
  } catch {
    // 目录不存在视为空
  }
  return NextResponse.json({ items: files });
});
