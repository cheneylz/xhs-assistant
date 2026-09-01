/**
 * 视频工具（对应原版 cv2.VideoCapture 的时长/FPS/抽帧封面，用 ffprobe/ffmpeg 替代）
 * 依赖系统 ffmpeg/ffprobe（未安装时相关函数返回 null / 抛错，不影响其余功能）
 */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { dirname } from "node:path";

export interface VideoMetadata {
  durationMs: number;
  width: number;
  height: number;
  fps: number;
  format: string;
  /** 视频编码（h264/hevc 等，转码判断用） */
  videoCodec: string;
  /** 音频编码（aac/mp3 等） */
  audioCodec: string;
  /** 文件大小（字节） */
  sizeBytes: number;
}

/** 小红书视频发布规范（视频工坊合规体检用） */
export const XHS_VIDEO_SPEC = {
  /** 普通账号时长上限 5 分钟 */
  maxDurationMs: 5 * 60 * 1000,
  /** 推荐时长区间 [5s, 3min] */
  recommendedDurationMs: [5 * 1000, 3 * 60 * 1000],
  /** 最低分辨率短边 720 */
  minShortSide: 720,
  /** 推荐封装格式 */
  formats: ["mp4", "mov"],
  /** 推荐视频编码 */
  videoCodec: "h264",
  /** 推荐音频编码 */
  audioCodec: "aac",
  /** 推荐比例（竖屏 9:16 首选，3:4/1:1/16:9 兼容） */
  ratios: [9 / 16, 3 / 4, 1, 16 / 9],
} as const;

/** 合规体检单条结果 */
export interface VideoComplianceItem {
  key: string;
  level: "error" | "warn";
  message: string;
}

/** 视频规格体检结果 */
export interface VideoCompliance {
  /** 是否通过（无 error 级别项） */
  passed: boolean;
  items: VideoComplianceItem[];
}

function run(args: string[], timeoutMs = 20000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(args[0], args.slice(1), { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim().slice(0, 500) || error.message));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

/** 取视频元数据（ffprobe JSON，对应 cv2.VideoCapture 时长/FPS） */
export async function getVideoMetadata(filePath: string): Promise<VideoMetadata | null> {
  try {
    const { stdout } = await run([
      "ffprobe", "-v", "quiet", "-print_format", "json",
      "-show_format", "-show_streams", filePath,
    ]);
    const info = JSON.parse(stdout) as {
      format?: { duration?: string; format_name?: string; size?: string };
      streams?: Array<{
        codec_type?: string;
        codec_name?: string;
        width?: number;
        height?: number;
        avg_frame_rate?: string;
        r_frame_rate?: string;
      }>;
    };
    const videoStream = info.streams?.find((s) => s.codec_type === "video");
    const audioStream = info.streams?.find((s) => s.codec_type === "audio");
    const durationMs = info.format?.duration ? Math.round(Number(info.format.duration) * 1000) : 0;
    const parseRate = (rate?: string): number => {
      if (!rate) return 0;
      const [num, den] = rate.split("/").map(Number);
      return num && den ? num / den : 0;
    };
    return {
      durationMs,
      width: videoStream?.width ?? 0,
      height: videoStream?.height ?? 0,
      fps: parseRate(videoStream?.avg_frame_rate || videoStream?.r_frame_rate),
      format: info.format?.format_name ?? "",
      videoCodec: videoStream?.codec_name ?? "",
      audioCodec: audioStream?.codec_name ?? "",
      sizeBytes: Number.parseInt(info.format?.size ?? "0", 10) || 0,
    };
  } catch {
    return null;
  }
}

/** 视频规格合规体检（对照小红书发布规范，视频工坊「体检卡」用） */
export function checkVideoCompliance(meta: VideoMetadata): VideoCompliance {
  const items: VideoComplianceItem[] = [];
  const shortSide = Math.min(meta.width, meta.height);
  const ratio = meta.height > 0 ? meta.width / meta.height : 0;

  // 时长：普通账号 5 秒 - 5 分钟
  if (meta.durationMs < XHS_VIDEO_SPEC.recommendedDurationMs[0]) {
    items.push({ key: "duration", level: "warn", message: "视频过短（不足 5 秒），平台可能无法生成封面" });
  } else if (meta.durationMs > XHS_VIDEO_SPEC.maxDurationMs) {
    items.push({ key: "duration", level: "error", message: "视频超过 5 分钟，普通账号无法发布（需视频号资质），建议截断" });
  }

  // 分辨率：短边 >= 720
  if (shortSide > 0 && shortSide < XHS_VIDEO_SPEC.minShortSide) {
    items.push({
      key: "resolution",
      level: "error",
      message: `分辨率低于 720p（当前 ${meta.width}x${meta.height}），建议转码提升画质`,
    });
  }

  // 封装格式
  if (meta.format && !XHS_VIDEO_SPEC.formats.some((f) => meta.format.includes(f))) {
    items.push({
      key: "format",
      level: "error",
      message: `封装格式（${meta.format}）非 MP4/MOV，需转码为 H.264 MP4`,
    });
  }

  // 视频编码
  if (meta.videoCodec && meta.videoCodec.toLowerCase() !== XHS_VIDEO_SPEC.videoCodec) {
    items.push({
      key: "videoCodec",
      level: "error",
      message: `视频编码（${meta.videoCodec}）非 H.264，需转码`,
    });
  }

  // 音频编码
  if (meta.audioCodec && meta.audioCodec.toLowerCase() !== XHS_VIDEO_SPEC.audioCodec) {
    items.push({
      key: "audioCodec",
      level: "warn",
      message: `音频编码（${meta.audioCodec}）非 AAC，建议转码`,
    });
  }

  // 画面比例：9:16 首选，3:4 / 1:1 / 16:9 兼容
  if (ratio > 0 && !XHS_VIDEO_SPEC.ratios.some((r) => Math.abs(ratio - r) < 0.02)) {
    items.push({
      key: "ratio",
      level: "warn",
      message: `画面比例（${(ratio * 100).toFixed(0)}:${100}）非平台推荐（9:16 首选，兼容 3:4 / 1:1 / 16:9）`,
    });
  }

  return { passed: !items.some((i) => i.level === "error"), items };
}

/** 抽取视频首帧作封面（ffmpeg，对应 cv2.VideoCapture 抽帧） */
export async function extractVideoCover(filePath: string, outputPath: string, positionMs = 0): Promise<boolean> {
  try {
    await fs.mkdir(dirname(outputPath), { recursive: true });
    await run([
      "ffmpeg", "-y", "-v", "quiet", "-ss", String(positionMs / 1000),
      "-i", filePath, "-frames:v", "1", "-q:v", "2", outputPath,
    ]);
    return true;
  } catch {
    return false;
  }
}

/** 转码为小红书发布规格 H.264 + AAC MP4（视频工坊转码适配；大文件耗时，默认超时 5 分钟） */
export async function transcodeToH264(
  inputPath: string,
  outputPath: string,
  timeoutMs = 300000,
): Promise<boolean> {
  try {
    await fs.mkdir(dirname(outputPath), { recursive: true });
    await run(
      [
        "ffmpeg", "-y", "-v", "error",
        "-i", inputPath,
        "-c:v", "libx264", "-preset", "medium", "-crf", "23",
        "-c:a", "aac", "-b:a", "128k",
        "-pix_fmt", "yuv420p", "-movflags", "+faststart",
        outputPath,
      ],
      timeoutMs,
    );
    return true;
  } catch {
    return false;
  }
}
