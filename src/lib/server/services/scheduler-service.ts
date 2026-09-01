/**
 * 调度服务（对应原版 backend/app/services/scheduler_service.py）
 * 包含：定时发布执行、监控刷新、自动运营执行、Cookie 健康巡检
 * 4 个任务由独立 worker 进程（src/worker/）以 node-cron 驱动，互斥锁防重叠
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "../core/db";
import { decryptText } from "../core/security";
import { formatDateTime, shanghaiNow } from "../core/time";
import { notifyAccountExpired, notifyPublishApprovalNeeded, notifyPublishFailed } from "./notification-service";
import type { ModelConfigLike } from "./ai-service";
import { computeReviewStatus, runReview, type TextClientLike } from "./review-service";
import { normalizeSearchItem, dataItems, imageUrls } from "./crawl-normalizers";

/** 门禁现场审查上下文（worker/路由注入，无模型时返回 null 走仅规则层） */
export interface GateReviewerContext {
  textClient: TextClientLike;
  modelConfig: ModelConfigLike;
  apiKey: string;
}

/** 门禁审查器：按用户返回其文本模型上下文（AI Agent 平台 R-06 三道门禁） */
export type GateReviewer = (userId: number) => Promise<GateReviewerContext | null>;

export function cookiesToSchedulerString(value: string): string {
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

export async function latestAccountCookies(accountId: number): Promise<string> {
  const cookieVersion = await prisma.accountCookieVersion.findFirst({
    where: { platformAccountId: accountId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  if (!cookieVersion) throw new Error("Account has no cookies");
  return cookiesToSchedulerString(decryptText(cookieVersion.encryptedCookies));
}

export function assetUploadInfo(asset: { creatorUploadInfo: string }): Record<string, unknown> {
  let payload: unknown = {};
  try {
    payload = JSON.parse(asset.creatorUploadInfo || "{}");
  } catch {
    throw new Error("Uploaded asset metadata is invalid");
  }
  if (!(payload as Record<string, unknown>).fileIds) {
    throw new Error("Uploaded asset is missing Creator upload info");
  }
  return payload as Record<string, unknown>;
}

export function externalNoteId(payload: Record<string, unknown>): string {
  for (const key of ["note_id", "noteId", "id"]) {
    const value = payload[key];
    if (value) return String(value);
  }
  const data = payload.data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    return externalNoteId(data as Record<string, unknown>);
  }
  return "";
}

export function serializePublishJob(job: {
  id: number;
  platformAccountId: number | null;
  sourceDraftId: number | null;
  platform: string;
  title: string;
  body: string;
  publishMode: string;
  status: string;
  gateStatus: string;
  scheduledAt: Date | null;
  externalNoteId: string;
  publishError: string;
  publishedAt: Date | null;
  createdAt: Date;
}): Record<string, unknown> {
  return {
    id: job.id,
    platform_account_id: job.platformAccountId,
    source_draft_id: job.sourceDraftId,
    platform: job.platform,
    title: job.title,
    body: job.body,
    publish_mode: job.publishMode,
    status: job.status,
    gate_status: job.gateStatus,
    scheduled_at: job.scheduledAt ? formatDateTime(job.scheduledAt) : null,
    external_note_id: job.externalNoteId,
    publish_error: job.publishError,
    published_at: job.publishedAt ? formatDateTime(job.publishedAt) : null,
    created_at: formatDateTime(job.createdAt),
  };
}

export function loadPublishOptions(job: { publishOptions: string }): Record<string, unknown> {
  try {
    const options = JSON.parse(job.publishOptions || "{}");
    return options && typeof options === "object" && !Array.isArray(options) ? options : {};
  } catch {
    return {};
  }
}

function cleanTopics(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((topic): topic is string => typeof topic === "string" && topic.trim().length > 0).map((t) => t.trim());
}

function applyPublishOptions(noteInfo: Record<string, unknown>, options: Record<string, unknown>): void {
  const topics = cleanTopics(options.topics);
  if (topics.length) noteInfo.topics = topics;
  const location = options.location;
  if (typeof location === "string" && location.trim()) noteInfo.location = location.trim();
  if (options.privacy_type === 0 || options.privacy_type === 1) {
    noteInfo.type = options.privacy_type;
  }
}

export interface PublishAdapter {
  postNote: (noteInfo: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

/**
 * 三道门禁检查（R-06）：pending 时现场执行（LLM 可用则双层，否则仅规则层），
 * blocked 直接失败。通过（passed/warning）返回 true
 */
export async function ensureJobGatesPassed(options: {
  userId: number;
  job: { id: number; title: string; body: string; gateStatus: string };
  gateReviewer?: GateReviewer | null;
}): Promise<boolean> {
  const { userId, job, gateReviewer } = options;
  if (job.gateStatus === "passed" || job.gateStatus === "warning") return true;
  if (job.gateStatus === "blocked") return false;
  const context = gateReviewer ? await gateReviewer(userId) : null;
  const findings = await runReview({
    userId,
    title: job.title,
    body: job.body,
    textClient: context?.textClient ?? null,
    modelConfig: context?.modelConfig ?? null,
    apiKey: context?.apiKey ?? null,
  });
  const { gateStatus } = computeReviewStatus(findings);
  await prisma.publishJob.update({ where: { id: job.id }, data: { gateStatus } });
  return gateStatus !== "blocked";
}

/** 执行单个到期发布任务（对应 _run_one_due_publish_job） */
export async function runOneDuePublishJob(options: {
  userId: number;
  jobId: number;
  adapterFactory: (cookies: string) => PublishAdapter;
  gateReviewer?: GateReviewer | null;
}): Promise<[boolean, Record<string, unknown>]> {
  const { userId, jobId, adapterFactory, gateReviewer } = options;
  const job = await prisma.publishJob.findUnique({ where: { id: jobId } });
  if (!job) throw new Error("Publish job not found");

  // 三道门禁（R-06）：未审校现场执行，阻断 error 级风险零发布
  const gatesPassed = await ensureJobGatesPassed({ userId, job, gateReviewer });
  if (!gatesPassed) {
    const updated = await prisma.publishJob.update({
      where: { id: job.id },
      data: { status: "failed", publishError: "三道门禁未通过，已阻断发布（请先在审校工作台处理）" },
    });
    notifyPublishFailed(userId, job.title, job.id);
    return [false, serializePublishJob(updated)];
  }

  const account = job.platformAccountId ? await prisma.platformAccount.findUnique({ where: { id: job.platformAccountId } }) : null;
  if (!account || account.userId !== userId) throw new Error("Account not found");
  if (account.platform !== "xhs" || account.subType !== "creator") throw new Error("Creator account required");

  const task = await prisma.task.create({
    data: {
      userId,
      platform: job.platform,
      taskType: "creator_publish_scheduler",
      status: "running",
      progress: 20,
      payload: {
        publish_job_id: job.id,
        platform_account_id: account.id,
        scheduled_at: job.scheduledAt ? formatDateTime(job.scheduledAt) : null,
      },
      createdAt: shanghaiNow(),
    },
  });
  await prisma.publishJob.update({ where: { id: job.id }, data: { status: "publishing", publishError: "" } });

  try {
    const assets = await prisma.publishAsset.findMany({
      where: { publishJobId: job.id },
      orderBy: { id: "asc" },
    });
    if (assets.some((asset) => asset.assetType !== "image")) {
      throw new Error("Only image publish is supported");
    }
    const uploadedAssets = assets.filter((asset) => asset.uploadStatus === "uploaded");
    if (!uploadedAssets.length) throw new Error("At least one uploaded image asset is required");

    const noteInfo: Record<string, unknown> = {
      title: job.title,
      desc: job.body,
      media_type: "image",
      image_file_infos: uploadedAssets.map(assetUploadInfo),
      type: 1,
      postTime: null,
    };
    applyPublishOptions(noteInfo, loadPublishOptions(job));
    const payload = await adapterFactory(await latestAccountCookies(account.id)).postNote(noteInfo);
    const externalId = externalNoteId(payload);
    const publishedAt = shanghaiNow();
    const updated = await prisma.publishJob.update({
      where: { id: job.id },
      data: {
        status: "published",
        externalNoteId: externalId,
        publishError: "",
        publishedAt,
      },
    });
    await prisma.task.update({
      where: { id: task.id },
      data: {
        status: "completed",
        progress: 100,
        payload: { ...(task.payload as Record<string, unknown>), external_note_id: externalId, published_at: formatDateTime(publishedAt) },
      },
    });
    return [true, serializePublishJob(updated)];
  } catch (error) {
    const message = (error as Error).message;
    const updated = await prisma.publishJob.update({
      where: { id: job.id },
      data: { status: "failed", publishError: message },
    });
    await prisma.task.update({
      where: { id: task.id },
      data: { status: "failed", progress: 100, payload: { ...(task.payload as Record<string, unknown>), error: message } },
    });
    return [false, serializePublishJob(updated)];
  }
}

/** 执行某用户全部到期发布（对应 run_due_publish_jobs） */
export async function runDuePublishJobs(options: {
  userId: number;
  now?: Date;
  platform: string;
  adapterFactory: (cookies: string) => PublishAdapter;
  gateReviewer?: GateReviewer | null;
}): Promise<{ executed_count: number; failed_count: number; pending_approval_count: number; items: Record<string, unknown>[] }> {
  const now = options.now ?? shanghaiNow();
  const dueJobs = await prisma.publishJob.findMany({
    where: {
      platform: options.platform,
      publishMode: "scheduled",
      status: "pending",
      scheduledAt: { not: null, lte: now },
      account: { userId: options.userId },
    },
    orderBy: [{ scheduledAt: "asc" }, { id: "asc" }],
  });
  const items: Record<string, unknown>[] = [];
  let failedCount = 0;
  let pendingApprovalCount = 0;
  for (const job of dueJobs) {
    const optionsObj = loadPublishOptions(job);
    // D-02 显式批准：默认到点置为 pending_approval 通知用户；auto_approve 任务直接发布
    if (optionsObj.auto_approve !== true) {
      const gatesPassed = await ensureJobGatesPassed({ userId: options.userId, job, gateReviewer: options.gateReviewer });
      if (!gatesPassed) {
        const updated = await prisma.publishJob.update({
          where: { id: job.id },
          data: { status: "failed", publishError: "三道门禁未通过，已阻断发布（请先在审校工作台处理）" },
        });
        notifyPublishFailed(options.userId, job.title, job.id);
        items.push(serializePublishJob(updated));
        failedCount += 1;
        continue;
      }
      const updated = await prisma.publishJob.update({ where: { id: job.id }, data: { status: "pending_approval" } });
      notifyPublishApprovalNeeded(options.userId, job.title, job.id);
      items.push(serializePublishJob(updated));
      pendingApprovalCount += 1;
      continue;
    }
    const [succeeded, item] = await runOneDuePublishJob({
      userId: options.userId,
      jobId: job.id,
      adapterFactory: options.adapterFactory,
      gateReviewer: options.gateReviewer,
    });
    items.push(item);
    if (!succeeded) failedCount += 1;
  }
  return { executed_count: items.length, failed_count: failedCount, pending_approval_count: pendingApprovalCount, items };
}

/** 执行全部用户到期发布（对应 run_due_publish_jobs_for_all_users） */
export async function runDuePublishJobsForAllUsers(options: {
  now?: Date;
  platform: string;
  adapterFactory: (cookies: string) => PublishAdapter;
  gateReviewer?: GateReviewer | null;
}): Promise<{ executed_count: number; failed_count: number; pending_approval_count: number; items: Record<string, unknown>[] }> {
  const now = options.now ?? shanghaiNow();
  // 通过有到期发布任务的账号反查用户（对应原版 User join 查询）
  const accounts = await prisma.platformAccount.findMany({
    where: {
      publishJobs: {
        some: {
          platform: options.platform,
          publishMode: "scheduled",
          status: "pending",
          scheduledAt: { not: null, lte: now },
        },
      },
    },
    select: { userId: true },
    distinct: ["userId"],
    orderBy: { userId: "asc" },
  });
  const userIds = accounts.map((account) => account.userId);
  const users = await prisma.user.findMany({ where: { id: { in: userIds } }, orderBy: { id: "asc" } });
  const items: Record<string, unknown>[] = [];
  let failedCount = 0;
  let pendingApprovalCount = 0;
  for (const user of users) {
    const result = await runDuePublishJobs({
      userId: user.id,
      now,
      platform: options.platform,
      adapterFactory: options.adapterFactory,
      gateReviewer: options.gateReviewer,
    });
    items.push(...result.items);
    failedCount += result.failed_count;
    pendingApprovalCount += result.pending_approval_count;
  }
  return { executed_count: items.length, failed_count: failedCount, pending_approval_count: pendingApprovalCount, items };
}

// ---------------- 监控刷新 ----------------

function asInt(value: unknown): number {
  if (typeof value === "boolean") return 0;
  if (typeof value === "number") return Math.floor(value);
  if (typeof value === "string") {
    const cleaned = value.replace(/,/g, "").trim();
    if (/^\d+$/.test(cleaned)) return Number.parseInt(cleaned, 10);
  }
  return 0;
}

function firstMetric(raw: Record<string, unknown>, keys: string[]): number {
  for (const key of keys) {
    if (key in raw) return asInt(raw[key]);
  }
  return 0;
}

export function noteMetrics(note: { rawJson: unknown }): Record<string, number> {
  const raw = (note.rawJson ?? {}) as Record<string, unknown>;
  const interaction = raw.interact_info && typeof raw.interact_info === "object" ? (raw.interact_info as Record<string, unknown>) : {};
  const merged = { ...raw, ...interaction };
  const likes = firstMetric(merged, ["likes", "liked_count", "like_count", "likedCount"]);
  const collects = firstMetric(merged, ["collects", "collected_count", "collect_count", "collectedCount"]);
  const comments = firstMetric(merged, ["comments", "comment_count", "commentCount"]);
  const shares = firstMetric(merged, ["shares", "share_count", "shareCount"]);
  return { likes, collects, comments, shares, engagement: likes + collects + comments + shares };
}

export function serializeMonitoringNote(note: { id: number; noteId: string; title: string; authorName: string; createdAt: Date; rawJson: unknown }): Record<string, unknown> {
  return {
    id: note.id,
    note_id: note.noteId,
    title: note.title,
    author_name: note.authorName,
    created_at: formatDateTime(note.createdAt),
    ...noteMetrics(note),
  };
}

function noteHaystack(note: { noteId: string; title: string; content: string; authorName: string; rawJson: unknown }): string {
  const rawText = JSON.stringify(note.rawJson ?? {});
  return [note.noteId, note.title, note.content, note.authorName, rawText].join("\n").toLowerCase();
}

function noteMatchesTarget(note: { noteId: string; title: string; content: string; authorName: string; rawJson: unknown }, needle: string): boolean {
  if (!needle) return false;
  return noteHaystack(note).includes(needle);
}

async function matchingNotesForTarget(targetId: number, userId: number, platform: string): Promise<NoteLike[]> {
  const notes = await prisma.note.findMany({
    where: { userId, platform },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  const target = await prisma.monitoringTarget.findUnique({ where: { id: targetId } });
  if (!target) return [];
  const needle = target.value.trim().toLowerCase();
  const matched = notes.filter((note) => noteMatchesTarget(note, needle));
  return matched
    .map((note) => ({
      note,
      engagement: noteMetrics(note).engagement,
    }))
    .sort((a, b) => b.engagement - a.engagement)
    .map(({ note }) => note);
}

/** 监控用的笔记形态（Prisma Note 的子集） */
type NoteLike = {
  id: number;
  noteId: string;
  title: string;
  content: string;
  authorName: string;
  createdAt: Date;
  rawJson: unknown;
};

/** 刷新单个监控目标（对应 _refresh_monitoring_target） */
export async function refreshMonitoringTarget(options: { targetId: number; now?: Date; platform: string }): Promise<Record<string, unknown>> {
  const now = options.now ?? shanghaiNow();
  const target = await prisma.monitoringTarget.findUnique({ where: { id: options.targetId } });
  if (!target) throw new Error("Monitoring target not found");
  const matchedNotes = await matchingNotesForTarget(target.id, target.userId, options.platform);
  const snapshotPayload: Record<string, unknown> = {
    matched_count: matchedNotes.length,
    total_engagement: matchedNotes.reduce((sum, note) => sum + noteMetrics(note).engagement, 0),
    top_notes: matchedNotes.slice(0, 10).map(serializeMonitoringNote),
  };
  const snapshot = await prisma.monitoringSnapshot.create({
    data: { targetId: target.id, payload: snapshotPayload as Prisma.InputJsonValue, createdAt: now },
  });
  await prisma.monitoringTarget.update({
    where: { id: target.id },
    data: { lastRefreshedAt: now, updatedAt: now },
  });
  const taskPayload: Record<string, unknown> = {
    target_id: target.id,
    target_type: target.targetType,
    value: target.value,
    snapshot_id: snapshot.id,
    matched_count: snapshotPayload.matched_count,
    scheduler: true,
  };
  await prisma.task.create({
    data: {
      userId: target.userId,
      platform: options.platform,
      taskType: "monitoring_refresh",
      status: "completed",
      progress: 100,
      payload: taskPayload as Prisma.InputJsonValue,
      createdAt: now,
    },
  });
  return {
    target_id: target.id,
    snapshot_id: snapshot.id,
    matched_count: snapshotPayload.matched_count,
    total_engagement: snapshotPayload.total_engagement,
  };
}

/** 刷新全部监控目标（对应 run_monitoring_refresh_for_all_users） */
export async function runMonitoringRefreshForAllUsers(options: { now?: Date; platform: string }): Promise<{ refreshed_count: number; items: Record<string, unknown>[] }> {
  const now = options.now ?? shanghaiNow();
  const targets = await prisma.monitoringTarget.findMany({
    where: { platform: options.platform, status: "active" },
    orderBy: { id: "asc" },
  });
  const items: Record<string, unknown>[] = [];
  for (const target of targets) {
    items.push(await refreshMonitoringTarget({ targetId: target.id, now, platform: options.platform }));
  }
  return { refreshed_count: items.length, items };
}

// ---------------- 自动运营 ----------------

/** 计算下次运行时间（对应 api/auto_tasks.py _calculate_next_run_at） */
export function calculateNextRunAt(task: { scheduleType: string; scheduleTime: string; scheduleDays: string; scheduleIntervalHours: number }): Date | null {
  const now = shanghaiNow();
  if (task.scheduleType === "manual") return null;
  if (task.scheduleType === "daily") {
    const [h, m] = (task.scheduleTime || "09:00").split(":").map(Number);
    const nextTime = new Date(now);
    nextTime.setUTCHours(h, m, 0, 0);
    if (nextTime.getTime() <= now.getTime()) nextTime.setUTCDate(nextTime.getUTCDate() + 1);
    return nextTime;
  }
  if (task.scheduleType === "weekly") {
    const [h, m] = (task.scheduleTime || "09:00").split(":").map(Number);
    const days = (task.scheduleDays || "")
      .split(",")
      .map((d) => d.trim())
      .filter((d) => /^\d+$/.test(d))
      .map(Number);
    if (!days.length) return null;
    for (let offset = 1; offset <= 7; offset++) {
      const candidate = new Date(now);
      candidate.setUTCDate(candidate.getUTCDate() + offset);
      if (days.includes(candidate.getUTCDay() === 0 ? 7 : candidate.getUTCDay())) {
        candidate.setUTCHours(h, m, 0, 0);
        return candidate;
      }
    }
    return null;
  }
  if (task.scheduleType === "interval") {
    return new Date(now.getTime() + task.scheduleIntervalHours * 3600 * 1000);
  }
  return null;
}

/** 获取用户默认文本模型（对应 _get_text_model_for_user） */
export async function getTextModelForUser(userId: number): Promise<[{ id: number; name: string; modelName: string; baseUrl: string; encryptedApiKey: string } | null, string]> {
  const config = await prisma.modelConfig.findFirst({
    where: { userId, modelType: "text", isDefault: true },
  });
  if (!config || !config.encryptedApiKey) return [null, ""];
  return [config, decryptText(config.encryptedApiKey)];
}

/** 执行单个自动运营任务（对应 _execute_auto_task_background 的调度器简化版） */
export async function executeAutoTaskBackground(options: {
  autoTaskId: number;
  pcAdapterFactory: (cookies: string) => { searchNote: (keyword: string, page?: number) => Promise<[boolean, string, unknown]> };
  creatorAdapterFactory: (cookies: string) => {
    uploadMedia: (filePath: string, mediaType: string) => Promise<Record<string, unknown>>;
    postNote: (noteInfo: Record<string, unknown>) => Promise<Record<string, unknown>>;
  };
  textClient?: {
    rewriteNote: (options: { modelConfig: ModelConfigLike; apiKey: string; title: string; body: string; instruction: string }) => Promise<string>;
    generateTitles: (options: { modelConfig: ModelConfigLike; apiKey: string; title: string; body: string; count: number }) => Promise<string[]>;
  };
}): Promise<void> {
  const { autoTaskId, pcAdapterFactory, creatorAdapterFactory, textClient } = options;
  const task = await prisma.autoTask.findUnique({ where: { id: autoTaskId } });
  if (!task) return;

  // PC 账号 Cookie
  const pcAccount = await prisma.platformAccount.findUnique({ where: { id: task.pcAccountId } });
  if (!pcAccount) return;
  const pcCookieVersion = await prisma.accountCookieVersion.findFirst({
    where: { platformAccountId: pcAccount.id },
    orderBy: { createdAt: "desc" },
  });
  if (!pcCookieVersion) return;
  const pcCookies = cookiesToSchedulerString(decryptText(pcCookieVersion.encryptedCookies));

  // 选关键词
  const keywords = Array.isArray(task.keywords) ? (task.keywords as unknown[]).filter((k): k is string => typeof k === "string") : [];
  if (!keywords.length) return;
  const keyword = keywords[Math.floor(Math.random() * keywords.length)];

  // 搜索（PC 适配器按账号 Cookie 构造）
  const pcAdapter = pcAdapterFactory(pcCookies);
  const [success, , raw] = await pcAdapter.searchNote(keyword, 1);
  if (!success) return;
  const items = dataItems(raw);
  const normalized = items.slice(0, 10).map(normalizeSearchItem);
  if (!normalized.length) return;

  // 选最佳
  const best = [...normalized].sort(
    (a, b) =>
      Number(b.likes ?? 0) + Number(b.collects ?? 0) + Number(b.comments ?? 0) + Number(b.shares ?? 0) -
      (Number(a.likes ?? 0) + Number(a.collects ?? 0) + Number(a.comments ?? 0) + Number(a.shares ?? 0)),
  )[0];

  // 创建草稿
  const draft = await prisma.aiDraft.create({
    data: {
      userId: task.userId,
      platform: "xhs",
      title: String(best.title ?? ""),
      body: String(best.content ?? ""),
      createdAt: shanghaiNow(),
    },
  });

  // AI 改写（非致命）
  try {
    const [modelConfig, apiKey] = await getTextModelForUser(task.userId);
    const client = textClient;
    if (modelConfig && apiKey && client) {
      const instruction = task.aiInstruction || "改写为原创小红书笔记";
      const rewrittenBody = await client.rewriteNote({
        modelConfig: modelConfig as unknown as ModelConfigLike,
        apiKey,
        title: draft.title,
        body: draft.body,
        instruction,
      });
      try {
        const titles = await client.generateTitles({
          modelConfig: modelConfig as unknown as ModelConfigLike,
          apiKey,
          title: draft.title,
          body: rewrittenBody,
          count: 1,
        });
        if (titles.length) {
          await prisma.aiDraft.update({ where: { id: draft.id }, data: { title: titles[0], body: rewrittenBody } });
        } else {
          await prisma.aiDraft.update({ where: { id: draft.id }, data: { body: rewrittenBody } });
        }
      } catch {
        await prisma.aiDraft.update({ where: { id: draft.id }, data: { body: rewrittenBody } });
      }
    }
  } catch {
    // AI 失败不阻塞流程
  }

  // Creator 账号
  const creatorAccount = await prisma.platformAccount.findUnique({ where: { id: task.creatorAccountId } });
  if (!creatorAccount) return;
  const creatorCv = await prisma.accountCookieVersion.findFirst({
    where: { platformAccountId: creatorAccount.id },
    orderBy: { createdAt: "desc" },
  });
  if (!creatorCv) return;
  const creatorCookies = cookiesToSchedulerString(decryptText(creatorCv.encryptedCookies));
  const creatorAdapter = creatorAdapterFactory(creatorCookies);

  // 上传图片并建发布任务
  const updatedDraft = await prisma.aiDraft.findUnique({ where: { id: draft.id } });
  const imageUrlsList = imageUrls(best);
  const fileInfos: Record<string, unknown>[] = [];
  for (const url of imageUrlsList.slice(0, 9)) {
    if (!url) continue;
    try {
      fileInfos.push(await creatorAdapter.uploadMedia(url, "image"));
    } catch (error) {
      console.warn(`Auto task ${task.id} image upload failed: ${(error as Error).message}`);
    }
  }
  if (!fileInfos.length) return;

  const job = await prisma.publishJob.create({
    data: {
      userId: task.userId,
      platformAccountId: task.creatorAccountId,
      sourceDraftId: updatedDraft?.id ?? draft.id,
      platform: "xhs",
      title: updatedDraft?.title ?? "",
      body: updatedDraft?.body ?? "",
      publishMode: "immediate",
      status: "publishing",
      createdAt: shanghaiNow(),
    },
  });
  await prisma.publishAsset.createMany({
    data: fileInfos.map((info) => ({
      publishJobId: job.id,
      assetType: "image",
      filePath: "",
      uploadStatus: "uploaded",
      creatorMediaId: String(info.fileIds ?? ""),
      creatorUploadInfo: JSON.stringify(info),
    })),
  });

  // 发布
  try {
    const noteInfo: Record<string, unknown> = {
      title: job.title,
      desc: job.body,
      media_type: "image",
      image_file_infos: fileInfos,
      type: 1,
      postTime: null,
    };
    const result = await creatorAdapter.postNote(noteInfo);
    let externalId = "";
    for (const key of ["note_id", "noteId", "id"]) {
      const v = result[key] ?? (result.data as Record<string, unknown> | undefined)?.[key];
      if (v) {
        externalId = String(v);
        break;
      }
    }
    await prisma.publishJob.update({
      where: { id: job.id },
      data: { status: "published", externalNoteId: externalId, publishedAt: shanghaiNow() },
    });
  } catch (error) {
    await prisma.publishJob.update({
      where: { id: job.id },
      data: { status: "failed", publishError: String((error as Error).message).slice(0, 500) },
    });
  }

  await prisma.autoTask.update({
    where: { id: task.id },
    data: {
      totalPublished: (task.totalPublished ?? 0) + 1,
      lastRunAt: shanghaiNow(),
    },
  });
  console.log(`Auto task ${task.id} executed: keyword=${keyword}, job=${job.id}`);
}

/** 运行到期自动任务（对应 run_due_auto_tasks） */
export async function runDueAutoTasks(options: {
  pcAdapterFactory: (cookies: string) => { searchNote: (keyword: string, page?: number) => Promise<[boolean, string, unknown]> };
  creatorAdapterFactory: (cookies: string) => {
    uploadMedia: (filePath: string, mediaType: string) => Promise<Record<string, unknown>>;
    postNote: (noteInfo: Record<string, unknown>) => Promise<Record<string, unknown>>;
  };
  textClient?: Parameters<typeof executeAutoTaskBackground>[0]["textClient"];
}): Promise<void> {
  const now = shanghaiNow();
  const dueTasks = await prisma.autoTask.findMany({
    where: {
      status: "active",
      scheduleType: { not: "manual" },
      nextRunAt: { not: null, lte: now },
    },
  });
  for (const task of dueTasks) {
    try {
      await executeAutoTaskBackground({
        autoTaskId: task.id,
        pcAdapterFactory: options.pcAdapterFactory,
        creatorAdapterFactory: options.creatorAdapterFactory,
        textClient: options.textClient,
      });
    } catch (error) {
      console.warn(`Auto task ${task.id} execution failed: ${(error as Error).message}`);
    } finally {
      const nextRunAt = calculateNextRunAt(task);
      await prisma.autoTask.update({ where: { id: task.id }, data: { nextRunAt } });
    }
  }
}

// ---------------- Cookie 健康巡检 ----------------

/** 检查单个账号 Cookie 有效性（对应 _check_single_account） */
export async function checkSingleAccount(options: {
  accountId: number;
  now?: Date;
  userInfoFetcher: (cookies: Record<string, unknown>) => Promise<void>;
}): Promise<string> {
  const now = options.now ?? shanghaiNow();
  const account = await prisma.platformAccount.findUnique({ where: { id: options.accountId } });
  if (!account) return "expired";
  const cookieVersion = await prisma.accountCookieVersion.findFirst({
    where: { platformAccountId: account.id },
    orderBy: { createdAt: "desc" },
  });
  if (!cookieVersion) {
    await prisma.platformAccount.update({
      where: { id: account.id },
      data: { status: "expired", statusMessage: "No stored cookie version", updatedAt: now },
    });
    return "expired";
  }
  const oldStatus = account.status;
  try {
    const cookiesText = decryptText(cookieVersion.encryptedCookies);
    const parsed = cookiesText.trim().startsWith("{")
      ? (JSON.parse(cookiesText) as Record<string, unknown>)
      : Object.fromEntries(
          cookiesText.split(";").map((part) => {
            const index = part.indexOf("=");
            return index >= 0 ? [part.slice(0, index).trim(), part.slice(index + 1)] : [part.trim(), ""];
          }),
        );
    await options.userInfoFetcher(parsed);
    await prisma.platformAccount.update({
      where: { id: account.id },
      data: { status: "active", statusMessage: "", updatedAt: now },
    });
    return oldStatus;
  } catch (error) {
    await prisma.platformAccount.update({
      where: { id: account.id },
      data: { status: "expired", statusMessage: (error as Error).message, updatedAt: now },
    });
    return oldStatus;
  }
}

/** 全部账号 Cookie 巡检（对应 check_all_account_cookies_once） */
export async function checkAllAccountCookiesOnce(options: {
  userInfoFetcherFor: (account: { id: number; subType: string | null }) => (cookies: Record<string, unknown>) => Promise<void>;
}): Promise<void> {
  const now = shanghaiNow();
  const accounts = await prisma.platformAccount.findMany({ orderBy: { id: "asc" } });
  let checked = 0;
  let newlyExpired = 0;
  for (const account of accounts) {
    try {
      const fetcher = options.userInfoFetcherFor(account);
      const oldStatus = await checkSingleAccount({ accountId: account.id, now, userInfoFetcher: fetcher });
      checked += 1;
      const updated = await prisma.platformAccount.findUnique({ where: { id: account.id } });
      if (updated?.status === "expired" && oldStatus !== "expired") {
        newlyExpired += 1;
        await prisma.notification.create({
          data: {
            userId: account.userId,
            title: "账号 Cookie 过期",
            body: `账号「${account.nickname || account.externalUserId || account.id}」(${account.subType || "pc"}) Cookie 已失效，请重新绑定。`,
            level: "warning",
            createdAt: now,
          },
        });
      }
    } catch (error) {
      console.warn(`Cookie check failed for account ${account.id}: ${(error as Error).message}`);
    }
  }
  console.log(`Cookie check completed: ${checked} accounts checked, ${newlyExpired} newly expired`);
}
