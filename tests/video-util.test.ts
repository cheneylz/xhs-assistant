/**
 * 视频工具测试（ffprobe 元数据 / 合规体检 / 封面抽帧 / H.264 转码）
 * - 合规体检为纯函数，无外部依赖，始终可测
 * - 真实 ffmpeg 用例用 lavfi 动态生成测试视频；本机未安装 ffmpeg 时自动跳过
 */
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  checkVideoCompliance,
  extractVideoCover,
  getVideoMetadata,
  transcodeToH264,
  type VideoMetadata,
} from "../src/lib/server/media/video-util";

/** 检测 ffmpeg 是否可用（不可用时跳过真实 ffmpeg 用例） */
function ffmpegAvailable(): boolean {
  try {
    execFileSync("ffmpeg", ["-version"], { timeout: 5000, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const HAS_FFMPEG = ffmpegAvailable();
const tempDir = mkdtempSync(join(tmpdir(), "xhs-video-test-"));
const testVideoPath = join(tempDir, "input.mp4");
const coverPath = join(tempDir, "cover.jpg");
const transcodePath = join(tempDir, "output.mp4");

beforeAll(async () => {
  if (!HAS_FFMPEG) return;
  // 生成 2 秒 1280x720 测试视频（H.264 + AAC）
  await new Promise<void>((resolve, reject) => {
    execFile(
      "ffmpeg",
      [
        "-y", "-v", "error",
        "-f", "lavfi", "-i", "testsrc=duration=2:size=1280x720:rate=30",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
        "-c:v", "libx264", "-c:a", "aac", "-pix_fmt", "yuv420p",
        testVideoPath,
      ],
      { timeout: 60000 },
      (error) => (error ? reject(error) : resolve()),
    );
  });
}, 60000);

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("checkVideoCompliance（纯函数，小红书发布规范体检）", () => {
  const baseMeta: VideoMetadata = {
    durationMs: 60_000,
    width: 1080,
    height: 1920,
    fps: 30,
    format: "mp4",
    videoCodec: "h264",
    audioCodec: "aac",
    sizeBytes: 10_000_000,
  };

  it("合规视频全部通过", () => {
    const result = checkVideoCompliance(baseMeta);
    expect(result.passed).toBe(true);
    expect(result.items).toHaveLength(0);
  });

  it("超过 5 分钟报 error（普通账号限制）", () => {
    const result = checkVideoCompliance({ ...baseMeta, durationMs: 6 * 60_000 });
    expect(result.passed).toBe(false);
    expect(result.items.find((i) => i.key === "duration")?.level).toBe("error");
  });

  it("低于 5 秒报 warn", () => {
    const result = checkVideoCompliance({ ...baseMeta, durationMs: 3000 });
    expect(result.items.find((i) => i.key === "duration")?.level).toBe("warn");
  });

  it("分辨率低于 720p 报 error", () => {
    const result = checkVideoCompliance({ ...baseMeta, width: 640, height: 640 });
    expect(result.passed).toBe(false);
    expect(result.items.find((i) => i.key === "resolution")?.level).toBe("error");
  });

  it("非 MP4 封装报 error", () => {
    const result = checkVideoCompliance({ ...baseMeta, format: "avi" });
    expect(result.items.find((i) => i.key === "format")?.level).toBe("error");
  });

  it("非 H.264 编码报 error", () => {
    const result = checkVideoCompliance({ ...baseMeta, videoCodec: "hevc" });
    expect(result.passed).toBe(false);
    expect(result.items.find((i) => i.key === "videoCodec")?.level).toBe("error");
  });

  it("非 AAC 音频报 warn（不阻断发布）", () => {
    const result = checkVideoCompliance({ ...baseMeta, audioCodec: "mp3" });
    expect(result.passed).toBe(true);
    expect(result.items.find((i) => i.key === "audioCodec")?.level).toBe("warn");
  });

  it("非常用比例（如 5:4）报 warn，1:1 兼容不报", () => {
    const result = checkVideoCompliance({ ...baseMeta, width: 1000, height: 800 });
    expect(result.items.find((i) => i.key === "ratio")?.level).toBe("warn");
    const square = checkVideoCompliance({ ...baseMeta, width: 1000, height: 1000 });
    expect(square.items.find((i) => i.key === "ratio")).toBeUndefined();
  });
});

describe.skipIf(!HAS_FFMPEG)("ffprobe/ffmpeg 真实能力", () => {
  it("getVideoMetadata 解析测试视频（时长/分辨率/fps/编码）", async () => {
    const meta = await getVideoMetadata(testVideoPath);
    expect(meta).not.toBeNull();
    expect(meta!.width).toBe(1280);
    expect(meta!.height).toBe(720);
    expect(meta!.durationMs).toBeGreaterThan(1500);
    expect(meta!.durationMs).toBeLessThan(2500);
    expect(meta!.videoCodec).toBe("h264");
    expect(meta!.audioCodec).toBe("aac");
    expect(meta!.sizeBytes).toBeGreaterThan(0);
  });

  it("getVideoMetadata 对不存在文件返回 null", async () => {
    const meta = await getVideoMetadata(join(tempDir, "missing.mp4"));
    expect(meta).toBeNull();
  });

  it("extractVideoCover 抽取首帧封面", async () => {
    const ok = await extractVideoCover(testVideoPath, coverPath);
    expect(ok).toBe(true);
    expect(existsSync(coverPath)).toBe(true);
  });

  it("transcodeToH264 转码产物可解析且编码正确", async () => {
    const ok = await transcodeToH264(testVideoPath, transcodePath);
    expect(ok).toBe(true);
    const meta = await getVideoMetadata(transcodePath);
    expect(meta).not.toBeNull();
    expect(meta!.videoCodec).toBe("h264");
    expect(meta!.width).toBe(1280);
  });
});
