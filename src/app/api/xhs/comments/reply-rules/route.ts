import { getCurrentUser } from "@/lib/server/core/auth";
import { handle, readJson } from "@/lib/server/core/route";
import { prisma } from "@/lib/server/core/db";
import { formatDateTime, shanghaiNow } from "@/lib/server/core/time";
import { NextResponse } from "next/server";
import { z } from "zod";

const ReplyRuleSchema = z.object({
  intent: z.enum(["question", "praise", "complaint", "ad", "other"]),
  keywords: z.array(z.string().max(20)).max(20).optional(),
  reply_template: z.string().max(500).default(""),
});

function serializeRule(rule: {
  id: number;
  intent: string;
  keywords: unknown;
  replyTemplate: string;
  enabled: boolean;
  createdAt: Date;
}): Record<string, unknown> {
  return {
    id: rule.id,
    intent: rule.intent,
    keywords: Array.isArray(rule.keywords) ? rule.keywords : [],
    reply_template: rule.replyTemplate,
    enabled: rule.enabled,
    created_at: formatDateTime(rule.createdAt),
  };
}

/** GET /api/xhs/comments/reply-rules 回复规则列表 */
export const GET = handle(async (req) => {
  const user = await getCurrentUser(req);
  const rules = await prisma.commentReplyRule.findMany({
    where: { userId: user.id },
    orderBy: { id: "asc" },
  });
  return NextResponse.json({ items: rules.map(serializeRule) });
});

/** POST /api/xhs/comments/reply-rules 新增回复规则 */
export const POST = handle(async (req) => {
  const user = await getCurrentUser(req);
  const payload = await readJson(req, ReplyRuleSchema);
  const rule = await prisma.commentReplyRule.create({
    data: {
      userId: user.id,
      intent: payload.intent,
      keywords: (payload.keywords ?? []) as never,
      replyTemplate: payload.reply_template,
      createdAt: shanghaiNow(),
    },
  });
  return NextResponse.json(serializeRule(rule));
});
