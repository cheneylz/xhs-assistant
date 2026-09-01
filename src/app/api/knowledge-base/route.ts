import { getCurrentUser } from "@/lib/server/core/auth";
import { badRequest } from "@/lib/server/core/http-error";
import { handle, readJson } from "@/lib/server/core/route";
import { getKnowledgeBase, serializeKnowledgeBase, updateKnowledgeBase } from "@/lib/server/services/knowledge-base-service";
import { NextResponse } from "next/server";
import { z } from "zod";

/** 解析 platform_account_id 查询参数（非法值抛 400） */
function parseAccountId(value: string | null): number | null {
  if (!value) return null;
  const accountId = Number.parseInt(value, 10);
  if (Number.isNaN(accountId)) throw badRequest("platform_account_id 无效");
  return accountId;
}

const UpdateKnowledgeBaseSchema = z.object({
  platform_account_id: z.number().int().nullable().optional(),
  positioning: z.string().max(300).optional(),
  tone_style: z.string().max(100).optional(),
  credible_claims: z.array(z.string().max(200)).max(20).optional(),
  content_boundary: z.string().max(500).optional(),
  visual_identity: z.record(z.string(), z.unknown()).optional(),
});

/** GET /api/knowledge-base 查询账号知识库（?platform_account_id= 指定账号，默认通用库） */
export const GET = handle(async (req, { searchParams }) => {
  const user = await getCurrentUser(req);
  const accountId = parseAccountId(searchParams.get("platform_account_id"));
  const kb = await getKnowledgeBase(user.id, accountId);
  return NextResponse.json(serializeKnowledgeBase(kb));
});

/** PUT /api/knowledge-base 更新知识库配置（部分字段更新） */
export const PUT = handle(async (req) => {
  const user = await getCurrentUser(req);
  const payload = await readJson(req, UpdateKnowledgeBaseSchema);
  const accountId = payload.platform_account_id ?? null;
  const kb = await updateKnowledgeBase(user.id, accountId, {
    positioning: payload.positioning,
    toneStyle: payload.tone_style,
    credibleClaims: payload.credible_claims,
    contentBoundary: payload.content_boundary,
    visualIdentity: payload.visual_identity,
  });
  return NextResponse.json(serializeKnowledgeBase(kb));
});
