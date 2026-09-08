import type { Prisma } from "@prisma/client";
import { getCurrentUser } from "@/lib/server/core/auth";
import { prisma } from "@/lib/server/core/db";
import { ApiError, badRequest, notFound } from "@/lib/server/core/http-error";
import { handle } from "@/lib/server/core/route";
import { decryptText } from "@/lib/server/core/security";
import { formatDateTime, shanghaiNow } from "@/lib/server/core/time";
import { OpenAICompatibleTextClient } from "@/lib/server/services/ai-service";
import { dataItems, normalizeSearchItem } from "@/lib/server/services/crawl-normalizers";
import { renderPrompt } from "@/prompts/loader";
import { calculateNextRunAt } from "@/lib/server/services/scheduler-service";
import { NextResponse } from "next/server";
import { serializeAutoTask, verifyAccountOwnership } from "../../shared";

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

async function getOwnedTask(userId: number, taskId: number) {
  const task = await prisma.autoTask.findFirst({ where: { id: taskId, userId } });
  if (!task) throw notFound("Auto task not found");
  return task;
}

/** POST /api/auto-tasks/{taskId}/run 手动执行自动运营（对应原版 run_auto_task） */
export const POST = handle(async (req, { params }) => {
  const user = await getCurrentUser(req);
  const taskId = Number.parseInt(params.taskId, 10);
  const autoTask = await getOwnedTask(user.id, taskId);

  await verifyAccountOwnership(user.id, autoTask.pcAccountId, "pc");
  await verifyAccountOwnership(user.id, autoTask.creatorAccountId, "creator");

  const trackingTask = await prisma.task.create({
    data: {
      userId: user.id,
      platform: "xhs",
      taskType: "auto_ops_run",
      status: "running",
      progress: 10,
      payload: { auto_task_id: autoTask.id, auto_task_name: autoTask.name },
      createdAt: shanghaiNow(),
    },
  });

  const failTracking = async (error: string) => {
    await prisma.task.update({
      where: { id: trackingTask.id },
      data: { status: "failed", progress: 100, payload: { ...(trackingTask.payload as Record<string, unknown>), error } },
    });
  };

  // 1. 随机关键词
  const keywords = Array.isArray(autoTask.keywords) ? (autoTask.keywords as unknown[]).filter((k): k is string => typeof k === "string") : [];
  if (!keywords.length) {
    await failTracking("No keywords configured");
    throw badRequest("No keywords configured");
  }
  const keyword = keywords[Math.floor(Math.random() * keywords.length)];
  await prisma.task.update({
    where: { id: trackingTask.id },
    data: { payload: { ...(trackingTask.payload as Record<string, unknown>), keyword } },
  });

  // 2. PC 搜索
  const pcCookieVersion = await prisma.accountCookieVersion.findFirst({
    where: { platformAccountId: autoTask.pcAccountId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  if (!pcCookieVersion) {
    await failTracking("Account has no cookies");
    throw badRequest("Account has no cookies");
  }
  const pcCookies = cookiesToString(decryptText(pcCookieVersion.encryptedCookies));
  const { XhsPcApiAdapter } = await import("@/lib/server/xhs/adapters/pc-api-adapter");
  const adapter = new XhsPcApiAdapter(pcCookies);
  const [success, message, rawPayload] = await adapter.searchNote(keyword, 1);
  if (!success) {
    await failTracking(message || "Search failed");
    throw new ApiError(502, message || "XHS search failed");
  }
  await prisma.task.update({ where: { id: trackingTask.id }, data: { progress: 30 } });

  // 3. 规范化并选高互动笔记
  const items = dataItems(rawPayload);
  const normalizedItems = items.map(normalizeSearchItem);
  if (!normalizedItems.length) {
    await failTracking("No notes found for keyword");
    throw notFound("No notes found for keyword");
  }
  const candidates = normalizedItems.slice(0, 10);
  const bestNote = [...candidates].sort(
    (a, b) =>
      Number(b.likes ?? 0) + Number(b.collects ?? 0) + Number(b.comments ?? 0) + Number(b.shares ?? 0) -
      (Number(a.likes ?? 0) + Number(a.collects ?? 0) + Number(a.comments ?? 0) + Number(a.shares ?? 0)),
  )[0];

  const step3Payload: Record<string, unknown> = {
    ...(trackingTask.payload as Record<string, unknown>),
    source_note_id: bestNote.note_id,
    source_title: bestNote.title,
    candidates_count: candidates.length,
  };
  await prisma.task.update({
    where: { id: trackingTask.id },
    data: { progress: 50, payload: step3Payload as Prisma.InputJsonValue },
  });

  // 4. 建草稿
  const draft = await prisma.aiDraft.create({
    data: {
      userId: user.id,
      platform: "xhs",
      title: String(bestNote.title ?? ""),
      body: String(bestNote.content ?? ""),
      createdAt: shanghaiNow(),
    },
  });
  await prisma.task.update({
    where: { id: trackingTask.id },
    data: { progress: 60, payload: { ...(trackingTask.payload as Record<string, unknown>), draft_id: draft.id } },
  });

  // 5. AI 改写（失败即终止）
  const modelConfig = await prisma.modelConfig.findFirst({
    where: { userId: user.id, modelType: "text", isDefault: true },
  });
  if (!modelConfig) {
    await failTracking("Default text model not configured");
    throw badRequest("Default text model is not configured");
  }
  const apiKey = modelConfig.encryptedApiKey ? decryptText(modelConfig.encryptedApiKey) : "";
  const textClient = new OpenAICompatibleTextClient();
  let rewrittenBody: string;
  try {
    rewrittenBody = await textClient.rewriteNote({
      modelConfig,
      apiKey,
      title: draft.title,
      body: draft.body,
      instruction: autoTask.aiInstruction || "改写为原创小红书笔记，保持核心信息，提升表达和语感",
    });
  } catch (error) {
    await failTracking(`AI rewrite failed: ${(error as Error).message}`);
    throw new ApiError(502, `AI rewrite failed: ${(error as Error).message}`);
  }

  // 5b. 标题改写（非致命）
  let finalTitle = draft.title;
  try {
    const rewrittenTitle = await textClient.complete({
      modelConfig,
      apiKey,
      systemPrompt: renderPrompt("auto-tasks.md", "title-rewrite"),
      userPrompt: `为以下小红书笔记改写一个吸引人的标题（15字以内）：\n\n原标题：${draft.title}\n\n正文：${rewrittenBody.slice(0, 200)}`,
      temperature: 0.8,
    });
    finalTitle = rewrittenTitle.trim().replace(/^["'《》]+|["'《》]+$/g, "");
  } catch {
    // 标题改写失败不致命
  }
  await prisma.task.update({ where: { id: trackingTask.id }, data: { progress: 80 } });

  // 6. 建发布任务（Creator 账号）
  const publishJob = await prisma.publishJob.create({
    data: {
      userId: user.id,
      platformAccountId: autoTask.creatorAccountId,
      sourceDraftId: draft.id,
      platform: "xhs",
      title: finalTitle,
      body: rewrittenBody,
      publishMode: "immediate",
      status: "pending",
      createdAt: shanghaiNow(),
    },
  });

  // 6b. 拷贝源笔记图片素材
  const imageUrls = Array.isArray(bestNote.image_urls) ? (bestNote.image_urls as unknown[]).filter((u): u is string => typeof u === "string" && u.length > 0) : [];
  if (imageUrls.length) {
    await prisma.publishAsset.createMany({
      data: imageUrls.slice(0, 9).map((url) => ({
        publishJobId: publishJob.id,
        assetType: "image",
        filePath: url,
        uploadStatus: "pending",
      })),
    });
  }

  // 7. 更新任务计数
  const nextRunAt = calculateNextRunAt({
    scheduleType: autoTask.scheduleType,
    scheduleTime: autoTask.scheduleTime,
    scheduleDays: autoTask.scheduleDays,
    scheduleIntervalHours: autoTask.scheduleIntervalHours,
  });
  const updatedAutoTask = await prisma.autoTask.update({
    where: { id: autoTask.id },
    data: { totalPublished: (autoTask.totalPublished ?? 0) + 1, lastRunAt: shanghaiNow(), nextRunAt },
  });

  await prisma.task.update({
    where: { id: trackingTask.id },
    data: {
      status: "completed",
      progress: 100,
      payload: {
        ...(trackingTask.payload as Record<string, unknown>),
        publish_job_id: publishJob.id,
        rewritten_length: rewrittenBody.length,
      },
    },
  });

  const updatedDraft = await prisma.aiDraft.findUnique({ where: { id: draft.id } });
  return NextResponse.json({
    auto_task: serializeAutoTask(updatedAutoTask),
    keyword,
    source_note: {
      note_id: bestNote.note_id,
      title: bestNote.title,
      likes: bestNote.likes ?? 0,
      collects: bestNote.collects ?? 0,
      comments: bestNote.comments ?? 0,
    },
    draft: {
      id: draft.id,
      title: finalTitle,
      body: rewrittenBody,
      created_at: formatDateTime(updatedDraft?.createdAt ?? new Date()),
    },
    publish_job: {
      id: publishJob.id,
      status: publishJob.status,
      platform_account_id: publishJob.platformAccountId,
    },
  });
});
