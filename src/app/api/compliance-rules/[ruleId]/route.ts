import { getCurrentUser } from "@/lib/server/core/auth";
import { prisma } from "@/lib/server/core/db";
import { badRequest, notFound } from "@/lib/server/core/http-error";
import { handle, readJson } from "@/lib/server/core/route";
import { formatDateTime } from "@/lib/server/core/time";
import { NextResponse } from "next/server";
import { z } from "zod";

const RuleTypes = ["sensitive_word", "absolute_claim", "medical_claim", "inducement", "fake_data_pattern"] as const;

const UpdateRuleSchema = z.object({
  rule_type: z.enum(RuleTypes).optional(),
  pattern: z.string().min(1).max(500).optional(),
  is_regex: z.boolean().optional(),
  risk_level: z.enum(["warning", "error"]).optional(),
  enabled: z.boolean().optional(),
});

/** 查询归属当前用户的规则（不存在抛 404） */
async function getOwnedRule(userId: number, ruleId: number) {
  const rule = await prisma.complianceRule.findFirst({ where: { id: ruleId, userId } });
  if (!rule) throw notFound("Rule not found");
  return rule;
}

/** PUT /api/compliance-rules/{ruleId} 更新规则 */
export const PUT = handle(async (req, { params }) => {
  const user = await getCurrentUser(req);
  const ruleId = Number.parseInt(params.ruleId, 10);
  await getOwnedRule(user.id, ruleId);
  const payload = await readJson(req, UpdateRuleSchema);
  if (payload.is_regex && payload.pattern) {
    try {
      new RegExp(payload.pattern);
    } catch {
      throw badRequest("正则表达式无效");
    }
  }
  const rule = await prisma.complianceRule.update({
    where: { id: ruleId },
    data: {
      ...(payload.rule_type !== undefined ? { ruleType: payload.rule_type } : {}),
      ...(payload.pattern !== undefined ? { pattern: payload.pattern } : {}),
      ...(payload.is_regex !== undefined ? { isRegex: payload.is_regex } : {}),
      ...(payload.risk_level !== undefined ? { riskLevel: payload.risk_level } : {}),
      ...(payload.enabled !== undefined ? { enabled: payload.enabled } : {}),
    },
  });
  return NextResponse.json({
    id: rule.id,
    rule_type: rule.ruleType,
    pattern: rule.pattern,
    is_regex: rule.isRegex,
    risk_level: rule.riskLevel,
    enabled: rule.enabled,
    created_at: formatDateTime(rule.createdAt),
  });
});

/** DELETE /api/compliance-rules/{ruleId} 删除规则 */
export const DELETE = handle(async (req, { params }) => {
  const user = await getCurrentUser(req);
  const ruleId = Number.parseInt(params.ruleId, 10);
  await getOwnedRule(user.id, ruleId);
  await prisma.complianceRule.delete({ where: { id: ruleId } });
  return NextResponse.json({ success: true });
});
