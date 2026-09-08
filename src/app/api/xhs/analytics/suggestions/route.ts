import { getCurrentUser } from "@/lib/server/core/auth";
import { prisma } from "@/lib/server/core/db";
import { ApiError } from "@/lib/server/core/http-error";
import { handle, readJson } from "@/lib/server/core/route";
import { deleteTopicSuggestions, generateSuggestions, serializeTopicSuggestion } from "@/lib/server/services/suggestion-service";
import { OpenAICompatibleTextClient } from "@/lib/server/services/ai-service";
import { textModelContext } from "../../../ai/shared";
import { makeUsageLogger } from "@/lib/server/services/usage-service";
import { NextResponse } from "next/server";
import { z } from "zod";

const GenerateSchema = z.object({
  count: z.number().int().min(5).max(20).default(5),
  direction: z.string().max(200).default(""),
  platform_account_id: z.number().int().nullable().optional(),
});

const DeleteBatchSchema = z.object({
  ids: z.array(z.number().int().positive()).min(1).max(100),
});

/** POST /api/xhs/analytics/suggestions P-03 选题推荐：知识库 + 热点 + 爆款结构 → LLM 选题列表 */
export const POST = handle(async (req) => {
  const user = await getCurrentUser(req);
  const payload = await readJson(req, GenerateSchema);
  const { modelConfig, apiKey } = await textModelContext(user.id);
  try {
    const { items } = await generateSuggestions({
      userId: user.id,
      count: payload.count,
      direction: payload.direction,
      platformAccountId: payload.platform_account_id ?? null,
      textClient: new OpenAICompatibleTextClient(),
      modelConfig,
      apiKey,
    });
    return NextResponse.json({ total: items.length, items });
  } catch (error) {
    throw new ApiError(400, (error as Error).message);
  }
});

/** GET /api/xhs/analytics/suggestions 选题列表（open 优先，可按状态筛选） */
export const GET = handle(async (req, { searchParams }) => {
  const user = await getCurrentUser(req);
  const status = searchParams.get("status");
  const items = await prisma.topicSuggestion.findMany({
    where: { userId: user.id, ...(status ? { status } : {}) },
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    take: 50,
  });
  return NextResponse.json({ items: items.map(serializeTopicSuggestion) });
});

/** DELETE /api/xhs/analytics/suggestions 批量删除选题（body: {ids}，仅限本人） */
export const DELETE = handle(async (req) => {
  const user = await getCurrentUser(req);
  const payload = await readJson(req, DeleteBatchSchema);
  const deleted = await deleteTopicSuggestions(user.id, payload.ids);
  return NextResponse.json({ deleted });
});
