import { getCurrentUser } from "@/lib/server/core/auth";
import { badRequest } from "@/lib/server/core/http-error";
import { handle, readJson } from "@/lib/server/core/route";
import { checkVideoCompliance, getVideoMetadata } from "@/lib/server/media/video-util";
import { NextResponse } from "next/server";
import { z } from "zod";
import { resolveUploadedVideoPath } from "../shared";

const VideoDetectSchema = z.object({
  file_name: z.string().min(1),
});

/** POST /api/xhs/video-studio/detect 视频规格检测（ffprobe 元数据 + 小红书合规体检） */
export const POST = handle(async (req) => {
  const user = await getCurrentUser(req);
  const payload = await readJson(req, VideoDetectSchema);
  const filePath = resolveUploadedVideoPath(user.id, payload.file_name);
  const meta = await getVideoMetadata(filePath);
  if (!meta) throw badRequest("视频解析失败，请确认文件为有效视频且本机已安装 ffmpeg");
  return NextResponse.json({ ...meta, compliance: checkVideoCompliance(meta) });
});
