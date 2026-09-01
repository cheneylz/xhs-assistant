import { getCurrentUser } from "@/lib/server/core/auth";
import { getConfig } from "@/lib/server/core/config";
import { handle } from "@/lib/server/core/route";
import { NextResponse } from "next/server";
import { readdirSync, statSync } from "node:fs";

/** 用户媒体目录 */
function mediaDir(): string {
  return `${getConfig().storageDir}/media`;
}

/** GET /api/files/videos 用户视频文件列表（上传素材 + 转码产物） */
export const GET = handle(async (req) => {
  const user = await getCurrentUser(req);
  const uploadPrefix = `xhs-upload-u${user.id}-`;
  const transcodePrefix = `xhs-transcode-u${user.id}-`;
  const videoExts = new Set([".mp4", ".mov", ".avi", ".mkv"]);
  const dir = mediaDir();
  const files: Array<Record<string, unknown>> = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => {
        const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
        if (!videoExts.has(ext)) return false;
        return name.startsWith(uploadPrefix) || name.startsWith(transcodePrefix);
      })
      .sort((a, b) => statSync(`${dir}/${b}`).mtimeMs - statSync(`${dir}/${a}`).mtimeMs);
    for (const name of entries) {
      files.push({
        file_name: name,
        url: `/api/files/media/${name}`,
        size: statSync(`${dir}/${name}`).size,
        source: name.startsWith(transcodePrefix) ? "transcode" : "upload",
      });
    }
  } catch {
    // 目录不存在视为空
  }
  return NextResponse.json({ items: files });
});
