import { getCurrentUser } from "@/lib/server/core/auth";
import { notFound } from "@/lib/server/core/http-error";
import { handle, readJson } from "@/lib/server/core/route";
import { prisma } from "@/lib/server/core/db";
import { formatDateTime } from "@/lib/server/core/time";
import { NextResponse } from "next/server";
import { z } from "zod";

const UpdateRuleSchema = z.object({
  intent: z.enum(["question", "praise", "complaint", "ad", "other"]).optional(),
  keywords: z.array(z.string().max(20)).max(20).optional(),
  reply_template: z.string().max(500).optional(),
  enabled: z.boolean().optional(),
});

/** 查询归属当前用户的规则 */
async function getOwnedRule(userId: number, ruleId: number) {
  const rule = await prisma.commentReplyRule.findFirst({ where: { id: ruleId, userId } });
  if (!rule) throw notFound("Rule not found");
  return rule;
}

/** PUT /api/xhs/comments/reply-rules/{ruleId} 更新规则 */
export const PUT = handle(async (req, { params }) => {
  const user = await getCurrentUser(req);
  const ruleId = Number.parseInt(params.ruleId, 10);
  await getOwnedRule(user.id, ruleId);
  const payload = await readJson(req, UpdateRuleSchema);
  const rule = await prisma.commentReplyRule.update({
    where: { id: ruleId },
    data: {
      ...(payload.intent !== undefined ? { intent: payload.intent } : {}),
      ...(payload.keywords !== undefined ? { keywords: payload.keywords as never } : {}),
      ...(payload.reply_template !== undefined ? { replyTemplate: payload.reply_template } : {}),
      ...(payload.enabled !== undefined ? { enabled: payload.enabled } : {}),
    },
  });
  return NextResponse.json({
    id: rule.id,
    intent: rule.intent,
    keywords: Array.isArray(rule.keywords) ? rule.keywords : [],
    reply_template: rule.replyTemplate,
    enabled: rule.enabled,
    created_at: formatDateTime(rule.createdAt),
  });
});

/** DELETE /api/xhs/comments/reply-rules/{ruleId} 删除规则 */
export const DELETE = handle(async (req, { params }) => {
  const user = await getCurrentUser(req);
  const ruleId = Number.parseInt(params.ruleId, 10);
  await getOwnedRule(user.id, ruleId);
  await prisma.commentReplyRule.delete({ where: { id: ruleId } });
  return NextResponse.json({ success: true });
});
