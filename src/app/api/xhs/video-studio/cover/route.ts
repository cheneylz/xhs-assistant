import { getCurrentUser } from "@/lib/server/core/auth";
import { getConfig } from "@/lib/server/core/config";
import { ApiError } from "@/lib/server/core/http-error";
import { handle, readJson } from "@/lib/server/core/route";
import { extractVideoCover } from "@/lib/server/media/video-util";
import { NextResponse } from "next/server";
import { z } from "zod";
import { generatedFileName, resolveUploadedVideoPath } from "../shared";

const VideoCoverSchema = z.object({
  file_name: z.string().min(1),
  /** 抽帧时间点（毫秒），默认首帧 */
  position_ms: z.number().int().min(0).max(10 * 60 * 1000).default(0),
});

/** POST /api/xhs/video-studio/cover 抽取视频封面帧（ffmpeg，输出 jpg 存入素材目录） */
export const POST = handle(async (req) => {
  const user = await getCurrentUser(req);
  const payload = await readJson(req, VideoCoverSchema);
  const filePath = resolveUploadedVideoPath(user.id, payload.file_name);
  const outputName = generatedFileName(user.id, "xhs-cover", ".jpg");
  const outputPath = `${getConfig().storageDir}/media/${outputName}`;
  const ok = await extractVideoCover(filePath, outputPath, payload.position_ms);
  if (!ok) throw new ApiError(502, "封面提取失败，请确认 ffmpeg 已安装且文件有效");
  return NextResponse.json({
    file_name: outputName,
    download_url: `/api/files/media/${outputName}`,
  });
});
