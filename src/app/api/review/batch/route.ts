import { getCurrentUser } from "@/lib/server/core/auth";
import { prisma } from "@/lib/server/core/db";
import { badRequest } from "@/lib/server/core/http-error";
import { handle, readJson } from "@/lib/server/core/route";
import { createReviewJob, serializeReviewFinding, serializeReviewJob } from "@/lib/server/services/review-service";
import { OpenAICompatibleTextClient, type ModelConfigLike } from "@/lib/server/services/ai-service";
import { textModelContext } from "../../ai/shared";
import { NextResponse } from "next/server";
import { z } from "zod";

const BatchReviewSchema = z.object({
  draft_ids: z.array(z.number().int()).min(1).max(50),
});

/** POST /api/review/batch 批量审校：逐条草稿提交审校，返回审校摘要列表 */
export const POST = handle(async (req) => {
  const user = await getCurrentUser(req);
  const payload = await readJson(req, BatchReviewSchema);

  const drafts = await prisma.aiDraft.findMany({
    where: { id: { in: payload.draft_ids }, userId: user.id },
    orderBy: { id: "asc" },
  });
  if (!drafts.length) throw badRequest("未找到可审校的草稿");

  // 批量场景：LLM 层失败不阻塞，规则层保证基础拦截
  let modelContext: { modelConfig: ModelConfigLike; apiKey: string; textClient: OpenAICompatibleTextClient } | null = null;
  try {
    const context = await textModelContext(user.id);
    modelContext = { ...context, textClient: new OpenAICompatibleTextClient() };
  } catch {
    modelContext = null;
  }

  const results: Record<string, unknown>[] = [];
  for (const draft of drafts) {
    const { job, findings } = await createReviewJob({
      userId: user.id,
      sourceDraftId: draft.id,
      title: draft.title,
      body: draft.body,
      textClient: modelContext?.textClient ?? null,
      modelConfig: modelContext?.modelConfig ?? null,
      apiKey: modelContext?.apiKey ?? null,
    });
    results.push({
      draft_id: draft.id,
      review: serializeReviewJob(job, findings.map(serializeReviewFinding)),
    });
  }
  return NextResponse.json({ total: results.length, items: results });
});
