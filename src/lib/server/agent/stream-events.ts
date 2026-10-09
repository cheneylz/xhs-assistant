/**
 * SSE 事件工具（纯函数，可离线单测）
 *
 * 全项目此前 0 处 ReadableStream —— 服务端流式契约是从零定义的（P1 设计稿 §八 缺口 2），
 * 因此把「怎么编码帧」「哪些事件要回放」「怎么补摘要」都放在这里，路由只负责编排。
 *
 * 【本文件不含 Pi 依赖】—— 用结构化最小接口接收事件行，便于离线单测。
 * 【有意的类型重复】AgentEventRowLike 与 Prisma 的 AgentEvent 结构一致但不 import 它：
 * 路由传入的是 Prisma 行（多余字段被结构性兼容），测试传入的是字面量对象。
 */

/** 事件行的最小结构（Prisma 的 agentEvent.findMany 返回值满足它） */
export interface AgentEventRowLike {
  id: number;
  runId: number;
  type: string;
  payload: unknown;
  createdAt: Date;
}

/** 心跳帧：SSE 注释行，客户端解析时会被跳过，只为防中间层掐长连接 */
export const SSE_HEARTBEAT_FRAME = ": ping\n\n";

/** 心跳间隔（毫秒） */
export const SSE_HEARTBEAT_MS = 15_000;

/**
 * 首屏要回放的事件类型（接口 3 的 `events` 字段）。
 *
 * 组成理由：
 *   message_end —— 中间过程助手文本（D23 让它的载荷里有 text）
 *   artifact    —— 右栏工件（首屏与 artifacts 接口同源）
 *   status      —— 终态结论与告警（循环里写入的 level/message）
 *   error       —— 循环级异常（如「未配置默认文本模型」）
 *
 * **不含** tool_execution_* 与 message_update：工具卡由 agent_tool_calls 承担
 * （按 tool_call_id 归并），把它们也回放会让同一张卡片渲染两遍。
 *
 * ⚠️ 前端渲染须知：`message_end` 的 `payload.text` 是**可选**的 —— Pi 对 user /
 * toolResult / system 也会发 message_end（只留 `role`），且升级前落库的旧行是
 * `{role, trimmed:true}`。渲染前必须同时判定 `payload.role === "assistant"`
 * 与 `text` 非空，否则会出现空白气泡。
 */
export const RENDERABLE_EVENT_TYPES = ["message_end", "artifact", "status", "error"] as const;

/** 该事件类型是否要回放给前端（首屏 events 字段用） */
export function isRenderableEvent(type: string): boolean {
  return (RENDERABLE_EVENT_TYPES as readonly string[]).includes(type);
}

/**
 * SSE 帧编码：`data: <json>\n\n`
 *
 * 与项目现有 crawlXhsDataStream 的逐行解析一致（`line.startsWith("data: ")`）。
 * id 放在 JSON 载荷里而不是 SSE 规范的 `id:` 字段 —— 客户端是手工解析，
 * 断线重连直接复用同一个 last_event_id。
 * JSON.stringify 会把内容里的换行转义成 \n，所以单行帧不会被正文切断。
 */
export function encodeSseFrame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** 把 Prisma 的 Json 载荷收窄成普通对象（可能是 null / 数组 / 标量） */
function toPayloadRecord(payload: unknown): Record<string, unknown> {
  return payload !== null && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
}

/** 从一批事件里挑出需要补摘要的 toolCallId（去重） */
export function collectToolCallIds(rows: Array<{ type: string; payload: unknown }>): string[] {
  const ids = new Set<string>();
  for (const row of rows) {
    if (row.type !== "tool_execution_end") continue;
    const toolCallId = toPayloadRecord(row.payload).toolCallId;
    if (typeof toolCallId === "string" && toolCallId) ids.add(toolCallId);
  }
  return [...ids];
}

/**
 * 给 tool_execution_end 的载荷补上 summary。
 *
 * 为什么事件里本来没有摘要：摘要在 afterToolCall 里算好写进 agent_tool_calls.summary（D21），
 * 而事件是 Pi 在 afterToolCall 之后才发出的，循环侧拿不到改写事件的机会
 * （subscribe 只能观察）。前端又不能 import skill-catalog 自己去算
 * （会把 prisma 打进客户端包），所以在 SSE 出口补齐 —— 服务端算、前端只渲染。
 *
 * 时序是安全的：afterToolCall 的落库 await 完成后 Pi 才发 tool_execution_end，
 * 因此事件行存在时摘要一定已经提交（P1 设计稿 §4.3 的落地细节）。
 */
export function attachToolCallSummaries<T extends AgentEventRowLike>(
  rows: T[],
  summaries: Map<string, string>,
): T[] {
  if (summaries.size === 0) return rows;
  return rows.map((row) => {
    if (row.type !== "tool_execution_end") return row;
    const payload = toPayloadRecord(row.payload);
    const toolCallId = payload.toolCallId;
    if (typeof toolCallId !== "string") return row;
    const summary = summaries.get(toolCallId);
    if (!summary) return row;
    // 不就地改：rows 是 Prisma 返回对象，就地改会污染调用方的数据
    return { ...row, payload: { ...payload, summary } };
  });
}
