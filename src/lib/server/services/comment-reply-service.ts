/**
 * 评论自动响应服务（AI Agent 平台 D-05）
 *
 * 管线（worker 60s）：
 *   已发布笔记新评论检测 → LLM 意图分类（question/praise/complaint/ad/other）
 *   → 规则/模板匹配生成回复 → 状态 pending（人工审核队列）
 * 人工确认（approve）→ PC comment/post 接口发出（限流器内）
 *
 * 安全设计：差评（complaint）类只标记不自动生成回复；所有回复必须人工确认。
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "../core/db";
import { decryptText } from "../core/security";
import { extractJsonObject } from "../core/json-extract";
import { formatDateTime, shanghaiNow } from "../core/time";
import { renderPrompt } from "../../../prompts/loader";
import { noteUrl } from "./crawl-normalizers";
import type { TextClientLike } from "./review-service";
import type { ModelConfigLike } from "./ai-service";
import { makeUsageLogger } from "./usage-service";

/** 评论意图 */
export type CommentIntent = "question" | "praise" | "complaint" | "ad" | "other";

/** 评论抓取适配器（worker/路由注入） */
export interface CommentFetchAdapter {
  getNoteComments: (noteUrl: string) => Promise<[boolean, string, unknown]>;
}

/** 评论发布适配器 */
export interface CommentPostAdapter {
  postComment: (noteId: string, content: string, xsecToken: string, parentCommentId?: string | null) => Promise<[boolean, string, unknown]>;
}

// ---------- 纯函数（可单测）----------

/** 解析 LLM 意图分类输出 */
export function parseIntent(content: string): CommentIntent {
  const text = content.trim().toLowerCase();
  const payload = extractJsonObject<Record<string, unknown>>(content);
  const intent = String(payload?.intent ?? text).trim().toLowerCase();
  const valid: CommentIntent[] = ["question", "praise", "complaint", "ad", "other"];
  const matched = valid.find((item) => intent.includes(item));
  return matched ?? "other";
}

/** 从评论内容中提取关键词（触发规则匹配用，纯函数） */
export function extractKeywords(content: string): string[] {
  const matches = content.match(/[一-鿿]{2,8}/g) ?? [];
  return [...new Set(matches)].slice(0, 10);
}

/** 匹配回复模板（支持 {question} 占位符，纯函数） */
export function renderTemplate(template: string, content: string): string {
  if (!template) return "";
  return template.replaceAll("{question}", content.slice(0, 30)).trim();
}

// ---------- 意图分类与回复生成 ----------

/** LLM 意图分类 + 回复内容生成（失败降级为 other 意图、空回复） */
async function classifyAndGenerate(options: {
  userId: number;
  commentContent: string;
  textClient: TextClientLike;
  modelConfig: ModelConfigLike;
  apiKey: string;
}): Promise<{ intent: CommentIntent; reply: string }> {
  const usageLogger = makeUsageLogger(options.userId, options.modelConfig.modelName); // S-06 用量采集
  try {
    const content = await options.textClient.complete({
      modelConfig: options.modelConfig,
      apiKey: options.apiKey,
      systemPrompt: renderPrompt("comment-reply.md", "intent"),
      userPrompt: `评论内容：${options.commentContent.slice(0, 500)}`,
      temperature: 0.2,
      onUsage: usageLogger,
    });
    const intent = parseIntent(content);
    if (intent === "complaint" || intent === "ad") return { intent, reply: "" }; // 差评/广告不自动回复
    // 生成回复（复用知识库口吻）
    const reply = await options.textClient.complete({
      modelConfig: options.modelConfig,
      apiKey: options.apiKey,
      systemPrompt: renderPrompt("comment-reply.md", "reply"),
      userPrompt: `评论：${options.commentContent.slice(0, 300)}`,
      temperature: 0.7,
      onUsage: usageLogger,
    });
    return { intent, reply: reply.trim().slice(0, 200) };
  } catch (error) {
    console.warn(`[comment-reply] 意图分类失败: ${(error as Error).message}`);
    return { intent: "other", reply: "" };
  }
}

// ---------- 新评论检测管线 ----------

/** 构建笔记 URL（从 rawJson 提取 xsec_token；无 token 时返回 null 表示无法回复） */
function buildNoteUrl(note: { noteId: string; rawJson: unknown }): string | null {
  const raw = (note.rawJson ?? {}) as Record<string, unknown>;
  const card = (raw.note_card ?? raw) as Record<string, unknown>;
  const url = noteUrl(note.noteId, raw, card);
  return url.startsWith("https://www.xiaohongshu.com/explore/") ? url : null;
}

/** 检测单个用户的已发布笔记新评论，生成待审核回复（worker 60s 调用） */
export async function detectNewCommentsForUser(options: {
  userId: number;
  adapterFactory: (cookies: string) => CommentFetchAdapter;
  textClient?: TextClientLike | null;
  modelConfig?: ModelConfigLike | null;
  apiKey?: string | null;
  noteLimit?: number;
}): Promise<{ newComments: number; generatedReplies: number }> {
  const { userId, adapterFactory, textClient, modelConfig, apiKey, noteLimit = 5 } = options;

  // 已发布笔记（发布任务成功回传的 externalNoteId 匹配内容库笔记）
  const publishedJobs = await prisma.publishJob.findMany({
    where: { userId, platform: "xhs", status: "published", externalNoteId: { not: "" } },
    orderBy: { publishedAt: "desc" },
    take: noteLimit,
  });
  if (!publishedJobs.length) return { newComments: 0, generatedReplies: 0 };

  // 取 PC 账号 Cookie（评论抓取与回复共用）
  const account = await prisma.platformAccount.findFirst({
    where: { userId, platform: "xhs", subType: "pc" },
    orderBy: { id: "asc" },
  });
  if (!account) return { newComments: 0, generatedReplies: 0 };
  const cookieVersion = await prisma.accountCookieVersion.findFirst({
    where: { platformAccountId: account.id },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  if (!cookieVersion) return { newComments: 0, generatedReplies: 0 };

  const adapter = adapterFactory(decryptText(cookieVersion.encryptedCookies));
  let newComments = 0;
  let generatedReplies = 0;

  for (const job of publishedJobs) {
    const note = await prisma.note.findFirst({ where: { userId, platform: "xhs", noteId: job.externalNoteId } });
    if (!note) continue;
    const url = buildNoteUrl(note);
    if (!url) continue;

    const [success, , raw] = await adapter.getNoteComments(url);
    if (!success) continue;
    const comments = extractRemoteComments(raw);
    for (const comment of comments) {
      // 已进入响应流程的评论跳过（按 commentId 去重）
      const exists = await prisma.commentReply.findFirst({ where: { userId, commentId: comment.commentId } });
      if (exists) continue;
      newComments += 1;

      let intent: CommentIntent = "other";
      let reply = "";
      if (textClient && modelConfig && apiKey) {
        const classified = await classifyAndGenerate({ userId, commentContent: comment.content, textClient, modelConfig, apiKey });
        intent = classified.intent;
        reply = classified.reply;
      } else {
        // 无模型：规则匹配
        intent = matchRuleIntent(comment.content);
        reply = renderTemplate(await matchReplyTemplate(userId, intent), comment.content);
      }

      if (reply) generatedReplies += 1;
      await prisma.commentReply.create({
        data: {
          userId,
          noteId: note.id,
          commentId: comment.commentId,
          noteUrl: url,
          intent,
          replyContent: reply,
          status: "pending",
          createdAt: shanghaiNow(),
        },
      });
    }
  }
  return { newComments, generatedReplies };
}

/** 从评论接口原始数据提取评论列表（一级评论为主，复用 data.comments 结构） */
export function extractRemoteComments(raw: unknown): Array<{ commentId: string; content: string }> {
  if (!raw || typeof raw !== "object") return [];
  const payload = raw as Record<string, unknown>;
  const data = payload.data && typeof payload.data === "object" ? (payload.data as Record<string, unknown>) : {};
  const comments = Array.isArray(data.comments) ? (data.comments as unknown[]) : [];
  const result: Array<{ commentId: string; content: string }> = [];
  for (const item of comments) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const comment = item as Record<string, unknown>;
    const commentId = String(comment.id ?? comment.comment_id ?? "");
    const content = String(comment.content ?? comment.text ?? "");
    if (commentId && content) result.push({ commentId, content });
  }
  return result;
}

/** 无 LLM 时的规则意图匹配（关键词表，纯函数） */
const INTENT_KEYWORDS: Record<CommentIntent, string[]> = {
  question: ["怎么", "如何", "哪里", "多少钱", "链接", "求", "？", "?"],
  praise: ["好看", "喜欢", "赞", "棒", "优秀", "厉害", "种草"],
  complaint: ["差", "不好", "失望", "退", "骗", "假", "后悔"],
  ad: ["加v", "加微", "vx", "微信", "代购", "广告"],
  other: [],
};

export function matchRuleIntent(content: string): CommentIntent {
  const text = content.toLowerCase();
  for (const intent of ["ad", "complaint", "question", "praise"] as CommentIntent[]) {
    if (INTENT_KEYWORDS[intent].some((keyword) => text.includes(keyword))) return intent;
  }
  return "other";
}

/** 匹配意图对应的启用回复模板（优先关键词命中，否则取该意图第一条模板） */
async function matchReplyTemplate(userId: number, intent: CommentIntent): Promise<string> {
  const rules = await prisma.commentReplyRule.findMany({
    where: { userId, intent, enabled: true },
    orderBy: { id: "asc" },
  });
  if (!rules.length) return "";
  return rules[0].replyTemplate;
}

// ---------- 人工确认发布 ----------

/** 确认回复：调用 PC comment/post 发出（限流由 SDK 内部保证） */
export async function approveCommentReply(options: {
  userId: number;
  replyId: number;
  adapterFactory: (cookies: string) => CommentPostAdapter;
}): Promise<{ reply: Record<string, unknown> }> {
  const { userId, replyId, adapterFactory } = options;
  const reply = await prisma.commentReply.findFirst({ where: { id: replyId, userId } });
  if (!reply) throw new Error("回复记录不存在");
  if (reply.status !== "pending") throw new Error("该回复已处理");
  if (!reply.replyContent.trim()) throw new Error("该评论没有可发布的回复内容");

  // 解析 noteId 与 xsec_token
  const url = new URL(reply.noteUrl);
  const noteId = url.pathname.split("/").pop() ?? "";
  const xsecToken = url.searchParams.get("xsec_token") ?? "";
  if (!noteId || !xsecToken) throw new Error("笔记 URL 缺少回复所需参数");

  const account = await prisma.platformAccount.findFirst({
    where: { userId, platform: "xhs", subType: "pc" },
    orderBy: { id: "asc" },
  });
  if (!account) throw new Error("未绑定 PC 账号");
  const cookieVersion = await prisma.accountCookieVersion.findFirst({
    where: { platformAccountId: account.id },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  if (!cookieVersion) throw new Error("PC 账号无有效 Cookie");

  const adapter = adapterFactory(decryptText(cookieVersion.encryptedCookies));
  const [success, msg] = await adapter.postComment(noteId, reply.replyContent, xsecToken, null);
  if (!success) throw new Error(`评论发布失败: ${msg}`);

  const updated = await prisma.commentReply.update({
    where: { id: reply.id },
    data: { status: "published", repliedAt: shanghaiNow(), replyError: "" },
  });
  return { reply: serializeCommentReply(updated) };
}

// ---------- 序列化 ----------

export function serializeCommentReply(reply: {
  id: number;
  noteId: number;
  commentId: string;
  intent: string;
  replyContent: string;
  status: string;
  replyError: string;
  createdAt: Date;
  repliedAt: Date | null;
}): Record<string, unknown> {
  return {
    id: reply.id,
    note_id: reply.noteId,
    comment_id: reply.commentId,
    intent: reply.intent,
    reply_content: reply.replyContent,
    status: reply.status,
    reply_error: reply.replyError,
    created_at: formatDateTime(reply.createdAt),
    replied_at: reply.repliedAt ? formatDateTime(reply.repliedAt) : null,
  };
}
