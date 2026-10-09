/**
 * 技能 → AgentTool 注册表
 *
 * 把 skill-catalog 的 executeSkill 包装成 Pi 的 AgentTool，
 * 让 Agent 循环能通过原生 tool calling 调用现有业务能力。
 *
 * 【本文件含 Pi 依赖】—— 仅 worker 侧使用，Next.js 侧禁止 import。
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { executeSkill, SKILL_CATALOG, type SkillContext } from "./skill-catalog";
import { assertSchemasComplete, assertToolNamesProviderSafe, getToolSchema } from "./tool-schemas";

/** 工具返回值中文本内容的长度上限（超出则截断，避免撑爆上下文） */
const TOOL_TEXT_LIMIT = 20_000;

/**
 * Pi 交给 execute 的入参静态类型是 unknown
 *
 * 原因：AgentTool 的 TParameters 是 TSchema，Static<TSchema> 无法静态求值，
 * 只能落到 unknown。运行时 Pi 已按 parameters 校验过入参，这里仅做类型收窄。
 */
function toParamsRecord(params: unknown): Record<string, unknown> {
  return params !== null && typeof params === "object" ? (params as Record<string, unknown>) : {};
}

/** 把技能执行结果序列化为模型可读文本 */
function toModelText(output: Record<string, unknown>): string {
  const text = JSON.stringify(output);
  if (text.length <= TOOL_TEXT_LIMIT) return text;
  return `${text.slice(0, TOOL_TEXT_LIMIT)}…（结果过长已截断，完整内容见工件面板）`;
}

/** 为目录中的每个技能生成 AgentTool */
export function buildAgentTools(context: SkillContext): AgentTool[] {
  assertSchemasComplete();
  // 工具名会原样进入供应商请求体：非法名称会被接口 400 拒绝，且表现为「模型请求失败」，
  // 排查成本很高（实测踩过，见 tool-schemas.ts 的 PROVIDER_TOOL_NAME_PATTERN 注释）
  assertToolNamesProviderSafe();

  return SKILL_CATALOG.map((definition) => ({
    name: definition.skillKey,
    label: definition.name,
    description: definition.description,
    parameters: getToolSchema(definition.skillKey),
    // 写操作不可安全重放（已生成的草稿/图片会产生重复产出）
    replay: definition.riskLevel === "read" ? "safe" : "never",
    execute: async (_toolCallId: string, params: unknown) => {
      const output = await executeSkill(definition.skillKey, toParamsRecord(params), context);
      return {
        content: [{ type: "text" as const, text: toModelText(output) }],
        details: output,
      };
    },
  }));
}
