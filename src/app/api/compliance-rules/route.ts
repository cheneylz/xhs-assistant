import { getCurrentUser } from "@/lib/server/core/auth";
import { prisma } from "@/lib/server/core/db";
import { badRequest } from "@/lib/server/core/http-error";
import { handle, readJson } from "@/lib/server/core/route";
import { formatDateTime, shanghaiNow } from "@/lib/server/core/time";
import { NextResponse } from "next/server";
import { z } from "zod";

const RuleTypes = ["sensitive_word", "absolute_claim", "medical_claim", "inducement", "fake_data_pattern"] as const;

const ComplianceRuleSchema = z.object({
  rule_type: z.enum(RuleTypes),
  pattern: z.string().min(1).max(500),
  is_regex: z.boolean().default(false),
  risk_level: z.enum(["warning", "error"]).default("warning"),
});

function serializeRule(rule: {
  id: number;
  ruleType: string;
  pattern: string;
  isRegex: boolean;
  riskLevel: string;
  enabled: boolean;
  createdAt: Date;
}): Record<string, unknown> {
  return {
    id: rule.id,
    rule_type: rule.ruleType,
    pattern: rule.pattern,
    is_regex: rule.isRegex,
    risk_level: rule.riskLevel,
    enabled: rule.enabled,
    created_at: formatDateTime(rule.createdAt),
  };
}

/** GET /api/compliance-rules 查询用户规则库（含内置默认规则） */
export const GET = handle(async (req) => {
  const user = await getCurrentUser(req);
  const rules = await prisma.complianceRule.findMany({
    where: { userId: user.id },
    orderBy: { id: "asc" },
  });
  return NextResponse.json({ items: rules.map(serializeRule) });
});

/** POST /api/compliance-rules 新增合规规则 */
export const POST = handle(async (req) => {
  const user = await getCurrentUser(req);
  const payload = await readJson(req, ComplianceRuleSchema);
  if (payload.is_regex) {
    try {
      new RegExp(payload.pattern);
    } catch {
      throw badRequest("正则表达式无效");
    }
  }
  const rule = await prisma.complianceRule.create({
    data: {
      userId: user.id,
      ruleType: payload.rule_type,
      pattern: payload.pattern,
      isRegex: payload.is_regex,
      riskLevel: payload.risk_level,
      createdAt: shanghaiNow(),
    },
  });
  return NextResponse.json(serializeRule(rule));
});
