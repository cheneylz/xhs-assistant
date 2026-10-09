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
      const item = block as { text?: string; type?: string; arguments?: unknown };
      if (typeof item?.text === "string") total += item.text.length;
      // toolCall 块没有 text 字段，但它的 arguments 同样会进入请求体。
      // 只累加 text 会让「模型一直在调工具」的场景被系统性低估。
      if (item?.type === "toolCall" && item.arguments !== undefined) {
        total += JSON.stringify(item.arguments).length;
      }
    }
    return total;
  }
  return 0;
}

/** 消息是否是工具结果 */
function isToolResult(message: unknown): boolean {
  return (message as MinimalMessage)?.role === "toolResult";
}

/** 反向查找最后一条 user 消息的下标，不存在返回 -1 */
function findLastUserIndex(messages: unknown[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if ((messages[i] as MinimalMessage)?.role === "user") return i;
  }
  return -1;
}

/**
 * 按字符预算从尾部保留消息。
 *
 * 算法：从最新往前累加字符数，超预算即停止；
 * 然后两处修正：
 *   修正 1：切点不能是 toolResult（其 assistant 父消息已被裁掉，模型会困惑）
 *   修正 2（保底）：最新一条 user 消息必须保留 —— 预算小于 system 时上面的循环会把
 *          整段对话裁光，模型只拿到 system、拿不到指令，却会产出「像样的」非答案，
 *          Run 还记为 succeeded。保底可让它至少回答对问题，而不是静默失忆。
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
  const budget = charBudget - systemChars;

  let cutIndex = conversational.length;
  let used = 0;
  for (let i = conversational.length - 1; i >= 0; i -= 1) {
    const size = estimateChars(conversational[i]);
    if (used + size > budget) break;
    used += size;
    cutIndex = i;
  }

  // 修正 1：不能以 toolResult 开头（否则其 assistant 父消息已被裁掉，模型会困惑）
  while (cutIndex < conversational.length && isToolResult(conversational[cutIndex])) {
    cutIndex += 1;
  }

  // 修正 2：保底保留最新 user 消息（cutIndex 回退到它，此时切点必是 user 消息，不会再产生孤立 toolResult）
  const lastUserIndex = findLastUserIndex(conversational);
  if (lastUserIndex >= 0 && cutIndex > lastUserIndex) {
    cutIndex = lastUserIndex;
  }

  return [...systemMessages, ...conversational.slice(cutIndex)];
}

/**
 * 工具结果摘要：把**每一个**数组值截断到 limit 条，并给出各自的原始条数。
 *
 * 为什么必须遍历所有数组键：topic.generate 同时返回 suggestion_ids 与 titles，
 * 只截第一个会出现「10 个 id 配 20 个标题」的错位，模型会把标题张冠李戴。
 * 非数组键原样保留。
 *
 * 注意：本函数的返回值只用于模型可见的 content，**不要**用它替换 details ——
 * persist.ts 的 extractArtifacts 依赖完整的 details。
 * 另：`totals`/`truncated` 两个键与工具自身产出同名时会被覆盖（当前 6 个技能无此字段）。
 */
export function summarizeToolResult(
  result: Record<string, unknown>,
  limit = DEFAULT_LIST_LIMIT,
): Record<string, unknown> {
  const listKeys = Object.keys(result).filter((key) => Array.isArray(result[key]));
  if (listKeys.length === 0) return result;

  const summary: Record<string, unknown> = { ...result };
  const totals: Record<string, number> = {};
  let truncated = false;
  for (const key of listKeys) {
    const list = result[key] as unknown[];
    totals[key] = list.length;
    if (list.length > limit) {
      summary[key] = list.slice(0, limit);
      truncated = true;
    }
  }
  summary.totals = totals;
  summary.truncated = truncated;
  return summary;
}
