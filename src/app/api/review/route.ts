import { getCurrentUser } from "@/lib/server/core/auth";
import { prisma } from "@/lib/server/core/db";
import { badRequest, notFound } from "@/lib/server/core/http-error";
import { parsePagination, paginated } from "@/lib/server/core/paginate";
import { handle, readJson } from "@/lib/server/core/route";
import { serializeReviewJob, serializeReviewFinding, createReviewJob } from "@/lib/server/services/review-service";
import { OpenAICompatibleTextClient } from "@/lib/server/services/ai-service";
import { textModelContext } from "../ai/shared";
import { NextResponse } from "next/server";
import { z } from "zod";

const SubmitReviewSchema = z.object({
  source_draft_id: z.number().int().nullable().optional(),
  source_note_id: z.number().int().nullable().optional(),
  title: z.string().max(300).optional(),
  body: z.string().max(20000).optional(),
});

/** 获取文本模型上下文（未配置模型时返回 null，审校降级为仅规则层） */
async function optionalTextModel(userId: number) {
  try {
    const { modelConfig, apiKey } = await textModelContext(userId);
    return { modelConfig, apiKey, textClient: new OpenAICompatibleTextClient() };
  } catch {
    return null;
  }
}

/** POST /api/review 提交审校（双层检测 + 三道门禁），结果落库并同步发布任务门禁 */
export const POST = handle(async (req) => {
  const user = await getCurrentUser(req);
  const payload = await readJson(req, SubmitReviewSchema);

  // 从草稿/笔记取内容，或直接提交文本
  let title = payload.title ?? "";
  let body = payload.body ?? "";
  if (payload.source_draft_id) {
    const draft = await prisma.aiDraft.findFirst({ where: { id: payload.source_draft_id, userId: user.id } });
    if (!draft) throw notFound("Draft not found");
    title = draft.title;
    body = draft.body;
  }
  if (payload.source_note_id) {
    const note = await prisma.note.findFirst({ where: { id: payload.source_note_id, userId: user.id } });
    if (!note) throw notFound("Note not found");
    title = title || note.title;
    body = body || note.content;
  }
  if (!title.trim() && !body.trim()) throw badRequest("审校内容不能为空");

  const modelContext = await optionalTextModel(user.id);
  const { job, findings } = await createReviewJob({
    userId: user.id,
    sourceDraftId: payload.source_draft_id ?? null,
    sourceNoteId: payload.source_note_id ?? null,
    title,
    body,
    textClient: modelContext?.textClient ?? null,
    modelConfig: modelContext?.modelConfig ?? null,
    apiKey: modelContext?.apiKey ?? null,
  });
  return NextResponse.json(serializeReviewJob(job, findings.map(serializeReviewFinding)));
});

/** GET /api/review 审校队列（可按状态筛选，分页） */
export const GET = handle(async (req, { searchParams }) => {
  const user = await getCurrentUser(req);
  const { page, pageSize } = parsePagination(searchParams);
  const status = searchParams.get("status");
  const where = {
    userId: user.id,
    ...(status ? { status } : {}),
  };
  const items = await prisma.reviewJob.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: pageSize,
    skip: (page - 1) * pageSize,
  });
  const total = await prisma.reviewJob.count({ where });
  return NextResponse.json(paginated(items.map((job) => serializeReviewJob(job)), page, pageSize));
});
