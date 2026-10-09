/**
 * 工具卡摘要的唯一入口（D21）
 *
 * 摘要必须**在服务端算好落库**：skill-catalog.ts import 了 prisma 与多个 service，
 * 前端一旦 import 它就会把整条 DB 依赖链打进客户端包。落库时是唯一同时握有
 * 「工具 + 结果 + 阻断原因」的时刻（被阻断的行 result 为 null）。
 */
import { findSkillDefinition } from "./skill-catalog";

/** 被护栏阻断时的兜底文案（正常路径永远用 guard 给的 reason） */
const BLOCKED_FALLBACK = "被护栏阻断";
/** 工具执行失败时的摘要（原始错误文本在 result 里，展开可见） */
const FAILED_SUMMARY = "执行失败（展开可见错误详情）";

export interface ToolCallSummaryInput {
  toolName: string;
  details: Record<string, unknown>;
  isError: boolean;
  /** 仅阻断路径传：guard 返回的 reason */
  blockedReason?: string | null;
}

export function buildToolCallSummary(input: ToolCallSummaryInput): string {
  // guard 正常会给非空 reason；缺省或空串都走兜底：摘要是对外文案，不能出现空卡片
  if (input.blockedReason != null) return input.blockedReason || BLOCKED_FALLBACK;
  if (input.isError) return FAILED_SUMMARY;

  const definition = findSkillDefinition(input.toolName);
  if (!definition) return "";
  try {
    return definition.summarize(input.details) || "";
  } catch (error) {
    // 摘要只是展示层：算错不能影响循环 —— 工具结果已经写进 agent_tool_calls 了
    console.error(`[agent] 摘要生成失败（${input.toolName}）`, error);
    return "";
  }
}
