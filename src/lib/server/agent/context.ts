/**
 * Agent 上下文装配
 *
 * 1. 按字符预算裁剪历史（本项目用「字符数 / 2」估算 token，不引 tokenizer 依赖）
 * 2. 工具结果摘要（防大结果撑爆上下文窗口）
 *
 * 硬约束：
 *   - system 消息永不裁剪
 *   - 不产生孤立的 toolResult（其配对的 assistant 工具调用被裁掉时必须一并裁掉）
 *
 * 【本文件不含 Pi 依赖】—— 用结构化最小接口，不 import pi 类型。
 */

/** 最小消息形状（兼容 pi 的 AgentMessage，但不依赖其类型） */
interface MinimalMessage {
  role?: string;
  content?: unknown;
  toolCallId?: string;
}

/** 默认工具结果列表保留条数 */
const DEFAULT_LIST_LIMIT = 10;

/** 估算单条消息的字符数 */
export function estimateChars(message: unknown): number {
  const target = message as MinimalMessage;
  const content = target?.content;
  if (typeof content === "string") return content.length;
  if (Array.isArray(content)) {
    let total = 0;
    for (const block of content) {
      const item = block as { text?: string; type?: string };
      if (typeof item?.text === "string") total += item.text.length;
    }
    return total;
  }
  return 0;
}

/** 消息是否携带工具调用（assistant 消息的 content 里有 type="toolCall" 块） */
function hasToolCall(message: unknown): boolean {
  const content = (message as MinimalMessage)?.content;
  if (!Array.isArray(content)) return false;
  return content.some((block) => (block as { type?: string })?.type === "toolCall");
}

/** 消息是否是工具结果 */
function isToolResult(message: unknown): boolean {
  return (message as MinimalMessage)?.role === "toolResult";
}

/**
 * 按字符预算从尾部保留消息。
 *
 * 算法：从最新往前累加字符数，超预算即停止；
 * 然后修正切点 —— 若切点处是 toolResult（其 assistant 父消息已被裁掉），
 * 则继续往后推进，直到不再以 toolResult 开头。
 */
export function pruneByCharBudget<T>(messages: T[], charBudget: number): T[] {
  if (messages.length === 0) return messages;

  const systemMessages: T[] = [];
  const conversational: T[] = [];
  for (const message of messages) {
    if ((message as MinimalMessage)?.role === "system") systemMessages.push(message);
    else conversational.push(message);
  }

  const systemChars = systemMessages.reduce((sum, m) => sum + estimateChars(m), 0);
  let budget = charBudget - systemChars;

  let cutIndex = conversational.length;
  let used = 0;
  for (let i = conversational.length - 1; i >= 0; i -= 1) {
    const size = estimateChars(conversational[i]);
    if (used + size > budget) break;
    used += size;
    cutIndex = i;
  }

  // 修正：不能以 toolResult 开头（否则其 assistant 父消息已被裁掉，模型会困惑）
  while (cutIndex < conversational.length && isToolResult(conversational[cutIndex])) {
    cutIndex += 1;
  }

  return [...systemMessages, ...conversational.slice(cutIndex)];
}

/**
 * 工具结果摘要：列表类结果截断到 limit 条，附总数与截断标记。
 * 非列表结果原样返回。
 */
export function summarizeToolResult(
  result: Record<string, unknown>,
  limit = DEFAULT_LIST_LIMIT,
): Record<string, unknown> {
  const listKey = Object.keys(result).find((key) => Array.isArray(result[key]));
  if (!listKey) return result;

  const list = result[listKey] as unknown[];
  if (list.length <= limit) {
    return { ...result, total: list.length, truncated: false };
  }
  return {
    ...result,
    [listKey]: list.slice(0, limit),
    total: list.length,
    truncated: true,
  };
}
