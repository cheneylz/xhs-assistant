/**
 * 知识库服务（AI Agent 平台 S-02 / C-07 / A-06）
 *
 * 职责：
 * - 账号知识库 CRUD：定位、口吻、可信主张、内容边界、视觉身份
 * - Few-shot 样本管理：历史优质笔记 + LLM 风格分析（C-07 风格模仿）
 * - 闭环学习结论写回（A-06）：lessonsLearned 追加
 * - 生成时上下文装配 buildKbContext()：所有生成类 Skill 统一注入
 *
 * Phase 1 用结构化配置 + Few-shot（零依赖），Phase 2 升级 pgvector 向量检索。
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "../core/db";
import { formatDateTime, shanghaiNow } from "../core/time";
import type { ModelConfigLike } from "./ai-service";
import type { TextClientLike } from "./review-service";

// ---------- 知识库查询 ----------

/** 获取账号知识库（platformAccountId 为空返回通用库；不存在则创建默认空库） */
export async function getKnowledgeBase(userId: number, platformAccountId?: number | null) {
  const existing = await prisma.knowledgeBase.findFirst({
    where: { userId, platformAccountId: platformAccountId ?? null },
  });
  if (existing) return existing;
  return prisma.knowledgeBase.create({
    data: {
      userId,
      platformAccountId: platformAccountId ?? null,
      updatedAt: shanghaiNow(),
    },
  });
}

/** 更新知识库配置（仅更新传入字段） */
export async function updateKnowledgeBase(
  userId: number,
  platformAccountId: number | null,
  data: {
    positioning?: string;
    toneStyle?: string;
    credibleClaims?: string[];
    contentBoundary?: string;
    visualIdentity?: Record<string, unknown>;
  },
) {
  const kb = await getKnowledgeBase(userId, platformAccountId);
  return prisma.knowledgeBase.update({
    where: { id: kb.id },
    data: {
      ...(data.positioning !== undefined ? { positioning: data.positioning } : {}),
      ...(data.toneStyle !== undefined ? { toneStyle: data.toneStyle } : {}),
      ...(data.credibleClaims !== undefined ? { credibleClaims: data.credibleClaims as Prisma.InputJsonValue } : {}),
      ...(data.contentBoundary !== undefined ? { contentBoundary: data.contentBoundary } : {}),
      ...(data.visualIdentity !== undefined ? { visualIdentity: data.visualIdentity as Prisma.InputJsonValue } : {}),
      updatedAt: shanghaiNow(),
    },
  });
}

/** 追加闭环学习结论（A-06），返回最新结论列表 */
export async function addLesson(userId: number, platformAccountId: number | null, lesson: string) {
  const kb = await getKnowledgeBase(userId, platformAccountId);
  const lessons = Array.isArray(kb.lessonsLearned) ? (kb.lessonsLearned as unknown[]).map(String) : [];
  lessons.push(lesson);
  await prisma.knowledgeBase.update({
    where: { id: kb.id },
    data: { lessonsLearned: lessons.slice(-50), updatedAt: shanghaiNow() }, // 最多保留 50 条
  });
  return lessons.slice(-50);
}

// ---------- Few-shot 样本管理（C-07 风格模仿）----------

/** 查询知识库下的 Few-shot 样本 */
export async function listFewShotNotes(knowledgeBaseId: number) {
  return prisma.fewShotNote.findMany({
    where: { knowledgeBaseId },
    orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
  });
}

/** 新增 Few-shot 样本（noteId 关联库内笔记时自动带出标题正文） */
export async function addFewShotNote(options: {
  userId: number;
  platformAccountId: number | null;
  noteId?: number | null;
  title?: string;
  body?: string;
  styleAnalysis?: string;
  sortOrder?: number;
}) {
  const kb = await getKnowledgeBase(options.userId, options.platformAccountId);
  let title = options.title ?? "";
  let body = options.body ?? "";
  if (options.noteId) {
    const note = await prisma.note.findFirst({ where: { id: options.noteId, userId: options.userId } });
    if (note) {
      title = title || note.title;
      body = body || note.content;
    }
  }
  if (!title && !body) throw new Error("Few-shot note content is empty");
  return prisma.fewShotNote.create({
    data: {
      knowledgeBaseId: kb.id,
      noteId: options.noteId ?? null,
      title,
      body,
      styleAnalysis: options.styleAnalysis ?? "",
      sortOrder: options.sortOrder ?? 0,
      createdAt: shanghaiNow(),
    },
  });
}

/** 删除 Few-shot 样本 */
export async function deleteFewShotNote(userId: number, fewShotNoteId: number) {
  const item = await prisma.fewShotNote.findUnique({ where: { id: fewShotNoteId } });
  if (!item) throw new Error("Few-shot note not found");
  const kb = await prisma.knowledgeBase.findFirst({ where: { id: item.knowledgeBaseId, userId } });
  if (!kb) throw new Error("Knowledge base not found");
  await prisma.fewShotNote.delete({ where: { id: fewShotNoteId } });
}

const STYLE_ANALYSIS_PROMPT = `你是小红书内容风格分析师。分析给定笔记的语言风格、句式结构、用词偏好、情绪基调、常用开头与结尾方式。
输出一段 150 字以内的分析文本（用于后续模仿生成），要点式输出，不要客套话。`;

/** LLM 风格分析（C-07）：单篇笔记 → 结构化风格描述 */
export async function analyzeNoteStyle(options: {
  title: string;
  body: string;
  modelConfig: ModelConfigLike;
  apiKey: string;
  textClient: TextClientLike;
}): Promise<string> {
  const { title, body, modelConfig, apiKey, textClient } = options;
  try {
    const analysis = await textClient.complete({
      modelConfig,
      apiKey,
      systemPrompt: STYLE_ANALYSIS_PROMPT,
      userPrompt: `标题：${title}\n\n正文：\n${body.slice(0, 2000)}`,
      temperature: 0.3,
    });
    return analysis.trim().slice(0, 1000);
  } catch (error) {
    console.warn(`[knowledge-base] 风格分析失败: ${(error as Error).message}`);
    return "";
  }
}

// ---------- 生成时上下文装配 ----------

/**
 * 组装知识库上下文（生成类 Skill 统一注入系统提示词）
 * 返回一段可直接拼入系统提示词的文本；无配置时返回空串
 */
export async function buildKbContext(userId: number, platformAccountId?: number | null): Promise<string> {
  const kb = await getKnowledgeBase(userId, platformAccountId ?? null);
  const sections: string[] = [];
  if (kb.positioning.trim()) sections.push(`【账号定位】${kb.positioning.trim()}`);
  if (kb.toneStyle.trim()) sections.push(`【口吻风格】${kb.toneStyle.trim()}，内容语气需贴合该风格`);
  const claims = Array.isArray(kb.credibleClaims) ? (kb.credibleClaims as unknown[]).map(String).filter(Boolean) : [];
  if (claims.length) sections.push(`【可信主张（可引用的真实背景）】${claims.join("；")}`);
  if (kb.contentBoundary.trim()) sections.push(`【内容边界（禁止涉及）】${kb.contentBoundary.trim()}`);
  const lessons = Array.isArray(kb.lessonsLearned) ? (kb.lessonsLearned as unknown[]).map(String).filter(Boolean) : [];
  if (lessons.length) sections.push(`【已验证的运营经验（生成时优先遵循）】${lessons.slice(-10).join("；")}`);

  // Few-shot 风格样本（最多 3 篇，附风格分析）
  const samples = await listFewShotNotes(kb.id);
  const effective = samples.slice(0, 3);
  if (effective.length) {
    const sampleText = effective
      .map((note, index) => {
        const analysis = note.styleAnalysis ? `\n风格要点：${note.styleAnalysis}` : "";
        return `${index + 1}. 标题：${note.title}\n正文摘录：${note.body.slice(0, 300)}${analysis}`;
      })
      .join("\n\n");
    sections.push(`【风格参考示例（模仿以下笔记的语言风格，不得照抄原文）】\n${sampleText}`);
  }
  return sections.join("\n\n");
}

// ---------- 序列化 ----------

export function serializeKnowledgeBase(kb: {
  id: number;
  platformAccountId: number | null;
  positioning: string;
  toneStyle: string;
  credibleClaims: unknown;
  contentBoundary: string;
  visualIdentity: unknown;
  lessonsLearned: unknown;
  updatedAt: Date;
}): Record<string, unknown> {
  return {
    id: kb.id,
    platform_account_id: kb.platformAccountId,
    positioning: kb.positioning,
    tone_style: kb.toneStyle,
    credible_claims: Array.isArray(kb.credibleClaims) ? kb.credibleClaims : [],
    content_boundary: kb.contentBoundary,
    visual_identity: (kb.visualIdentity as Record<string, unknown>) ?? {},
    lessons_learned: Array.isArray(kb.lessonsLearned) ? kb.lessonsLearned : [],
    updated_at: formatDateTime(kb.updatedAt),
  };
}

export function serializeFewShotNote(note: {
  id: number;
  noteId: number | null;
  title: string;
  body: string;
  styleAnalysis: string;
  sortOrder: number;
  createdAt: Date;
}): Record<string, unknown> {
  return {
    id: note.id,
    note_id: note.noteId,
    title: note.title,
    body: note.body,
    style_analysis: note.styleAnalysis,
    sort_order: note.sortOrder,
    created_at: formatDateTime(note.createdAt),
  };
}
