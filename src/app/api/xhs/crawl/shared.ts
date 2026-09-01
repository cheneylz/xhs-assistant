/**
 * 爬取路由共享工具（对应原版 crawl.py 的纯函数）
 */
import { prisma } from "@/lib/server/core/db";
import { badRequest, notFound } from "@/lib/server/core/http-error";
import { decryptText } from "@/lib/server/core/security";
import { formatDateTime, shanghaiNow } from "@/lib/server/core/time";
import { downloadAssetToLocal } from "@/lib/server/services/asset-downloader";
import type { Note, Prisma } from "@prisma/client";

function cookiesToString(value: string): string {
  const stripped = value.trim();
  if (!stripped) return stripped;
  if (stripped.startsWith("{")) {
    try {
      const cookies = JSON.parse(stripped) as Record<string, unknown>;
      return Object.entries(cookies)
        .map(([k, v]) => `${k}=${v}`)
        .join("; ");
    } catch {
      return stripped;
    }
  }
  return stripped;
}

/** 取归属当前用户的 PC 账号（对应 _owned_pc_account） */
export async function getOwnedPcAccount(userId: number, accountId: number) {
  const account = await prisma.platformAccount.findUnique({ where: { id: accountId } });
  if (!account || account.userId !== userId || account.platform !== "xhs" || account.subType !== "pc") {
    throw notFound("Account not found");
  }
  return account;
}

/** 取账号 Cookie（对应 crawl.py 内联逻辑） */
export async function getPcCookies(accountId: number): Promise<string> {
  const cookieVersion = await prisma.accountCookieVersion.findFirst({
    where: { platformAccountId: accountId },
    orderBy: { createdAt: "desc" },
  });
  if (!cookieVersion) throw badRequest("Account has no cookies");
  return cookiesToString(decryptText(cookieVersion.encryptedCookies));
}

export function serializeNote(note: {
  id: number;
  platform: string;
  platformAccountId: number;
  noteId: string;
  title: string;
  content: string;
  authorName: string;
  rawJson: unknown;
  createdAt: Date;
}): Record<string, unknown> {
  return {
    id: note.id,
    platform: note.platform,
    platform_account_id: note.platformAccountId,
    note_id: note.noteId,
    title: note.title,
    content: note.content,
    author_name: note.authorName,
    raw_json: note.rawJson,
    created_at: formatDateTime(note.createdAt),
  };
}

/** 创建爬取任务（对应 _create_crawl_task） */
export async function createCrawlTask(userId: number, crawlType: string, payload: Record<string, unknown>) {
  return prisma.task.create({
    data: {
      userId,
      platform: "xhs",
      taskType: "crawl",
      status: "running",
      progress: 10,
      payload: { crawl_type: crawlType, ...payload },
      createdAt: shanghaiNow(),
    },
  });
}

/** 完成任务（对应 _complete_task） */
export async function completeTask(taskId: number, payload: Record<string, unknown>) {
  const task = await prisma.task.findUnique({ where: { id: taskId } });
  if (!task) return;
  const merged: Record<string, unknown> = { ...((task.payload as Record<string, unknown>) ?? {}), ...payload };
  await prisma.task.update({
    where: { id: taskId },
    data: { status: "completed", progress: 100, payload: merged as Prisma.InputJsonValue },
  });
}

/** 失败任务（对应 _fail_task） */
export async function failTask(taskId: number, error: string) {
  const task = await prisma.task.findUnique({ where: { id: taskId } });
  if (!task) return;
  const merged: Record<string, unknown> = { ...((task.payload as Record<string, unknown>) ?? {}), error };
  await prisma.task.update({
    where: { id: taskId },
    data: { status: "failed", progress: 100, payload: merged as Prisma.InputJsonValue },
  });
}

/** 保存规范化笔记（对应 _save_normalized_notes） */
export async function saveNormalizedNotes(
  account: { id: number; userId: number; platform: string },
  normalizedItems: Array<Record<string, unknown>>,
): Promise<Note[]> {
  const saved: Note[] = [];
  for (const normalized of normalizedItems) {
    const noteId = String(normalized.note_id ?? "").trim();
    if (!noteId) continue;
    let note = await prisma.note.findFirst({ where: { userId: account.userId, noteId } });
    if (!note) {
      note = await prisma.note.create({
        data: {
          userId: account.userId,
          platformAccountId: account.id,
          platform: account.platform,
          noteId,
          createdAt: shanghaiNow(),
        },
      });
    }
    const rawWithMetrics = rawWithMetricsValue(normalized);
    note = await prisma.note.update({
      where: { id: note.id },
      data: {
        title: String(normalized.title ?? ""),
        content: String(normalized.content ?? ""),
        authorName: String(normalized.author_name ?? ""),
        rawJson: rawWithMetrics as Prisma.InputJsonValue,
      },
    });
    await prisma.noteAsset.deleteMany({ where: { noteId: note.id } });
    for (const url of imageUrls(normalized)) {
      const localName = await downloadAssetToLocal(url, account.userId, "image");
      await prisma.noteAsset.create({
        data: { noteId: note.id, assetType: "image", url, localPath: localName ?? "" },
      });
    }
    const video = videoUrlValue(normalized);
    if (video) {
      const localName = await downloadAssetToLocal(video, account.userId, "video");
      await prisma.noteAsset.create({
        data: { noteId: note.id, assetType: "video", url: video, localPath: localName ?? "" },
      });
    }
    saved.push(note);
  }
  return saved;
}

function rawWithMetricsValue(normalized: Record<string, unknown>): Record<string, unknown> {
  const raw = normalized.raw && typeof normalized.raw === "object" && !Array.isArray(normalized.raw)
    ? (normalized.raw as Record<string, unknown>)
    : {};
  return {
    ...raw,
    note_url: normalized.note_url ?? "",
    tags: normalized.tags ?? [],
    likes: normalized.likes ?? 0,
    collects: normalized.collects ?? 0,
    comments: normalized.comments ?? 0,
    shares: normalized.shares ?? 0,
  };
}

function imageUrls(normalized: Record<string, unknown>): string[] {
  const urls = normalized.image_urls;
  if (Array.isArray(urls) && urls.length) {
    return urls.filter((url): url is string => typeof url === "string" && url.length > 0).map(String);
  }
  const coverUrl = normalized.cover_url;
  return coverUrl ? [String(coverUrl)] : [];
}

function videoUrlValue(normalized: Record<string, unknown>): string {
  return String(normalized.video_url ?? normalized.video_addr ?? "");
}

/** 爬取数据项（对应 _crawl_data_item） */
export function crawlDataItem(options: {
  source: string;
  status: string;
  note?: Record<string, unknown> | null;
  comments?: Array<Record<string, unknown>> | null;
  error?: string;
}): Record<string, unknown> {
  const comments = options.comments ?? [];
  return {
    source: options.source,
    status: options.status,
    error: options.error ?? "",
    note: options.note ?? null,
    comments,
    comment_count: comments.length,
  };
}

/** SSE 事件格式化（对应 _sse_event） */
export function sseEvent(data: Record<string, unknown>): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

/** 请求间隔（对应 _sleep_between_requests） */
export function sleepBetweenRequests(seconds: number): Promise<void> {
  if (seconds <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, Math.min(seconds, 60) * 1000));
}
