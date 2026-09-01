import { getCurrentUser } from "@/lib/server/core/auth";
import { getConfig } from "@/lib/server/core/config";
import { ApiError } from "@/lib/server/core/http-error";
import { handle, readJson } from "@/lib/server/core/route";
import { checkVideoCompliance, getVideoMetadata, transcodeToH264 } from "@/lib/server/media/video-util";
import { NextResponse } from "next/server";
import { z } from "zod";
import { generatedFileName, resolveUploadedVideoPath } from "../shared";

const VideoTranscodeSchema = z.object({
  file_name: z.string().min(1),
});

/** POST /api/xhs/video-studio/transcode 转码为小红书发布规格（H.264 + AAC MP4） */
export const POST = handle(async (req) => {
  const user = await getCurrentUser(req);
  const payload = await readJson(req, VideoTranscodeSchema);
  const filePath = resolveUploadedVideoPath(user.id, payload.file_name);
  const outputName = generatedFileName(user.id, "xhs-transcode", ".mp4");
  const outputPath = `${getConfig().storageDir}/media/${outputName}`;
  const ok = await transcodeToH264(filePath, outputPath);
  if (!ok) throw new ApiError(502, "转码失败，请确认 ffmpeg 已安装且文件有效");
  // 回读转码产物元数据，供前端展示转码后规格
  const meta = await getVideoMetadata(outputPath);
  return NextResponse.json({
    file_name: outputName,
    download_url: `/api/files/media/${outputName}`,
    metadata: meta,
    compliance: meta ? checkVideoCompliance(meta) : null,
  });
});
