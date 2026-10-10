/**
 * Agent 事件与工具调用落库
 *
 * 【本文件不含 Pi 依赖】—— 用结构化最小接口接收事件，便于离线单测。
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "../core/db";
import { shanghaiNow } from "../core/time";
import { findSkillDefinition, type ArtifactKind } from "./skill-catalog";

/** 体积较大的事件类型：只记录摘要，不记录完整消息体 */
const TRIMMED_EVENT_TYPES = new Set(["message_update", "message_start"]);

/**
 * 从消息的 content 块里拼出纯文本（只认 text 块，工具调用块跳过）。
 *
 * 用结构化最小接口而不是 import Pi 的 AssistantMessage —— 本文件刻意不含 Pi 依赖，
 * 才能在 Next.js 侧与 vitest 里安全 import（见文件头）。
 */
export function extractMessageText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: string; text: string } => {
      if (block === null || typeof block !== "object") return false;
      const candidate = block as { type?: unknown; text?: unknown };
      return candidate.type === "text" && typeof candidate.text === "string";
    })
    .map((block) => block.text)
    .join("");
}

export interface SerializedEvent {
  type: string;
  payload: Prisma.InputJsonValue;
}

/** 事件 → 可落库的 { type, payload }，大体积事件只留摘要 */
export function serializeEventForDb(event: Record<string, unknown>): SerializedEvent {
  const type = String(event.type ?? "unknown");

  // D23：message_end 保留助手正文 —— 前端据此渲染「我先查一下热点」这类过程预告。
  // message_start / message_update 仍然裁掉：单轮约 300 条增量 vs 一次运行几条整段，
  // 体积差两个数量级（P1 设计稿 D23）。
  if (type === "message_end") {
    const message = event.message as { role?: string; content?: unknown; usage?: unknown } | undefined;
    const role = String(message?.role ?? "assistant");
    const payload: Record<string, unknown> = { role };
    // 只留助手正文：user 消息的正文由 agent_messages 承担（首屏接口单独返回），
    // 两处都存会让前端有两条渲染来源，必然重复。
    if (role === "assistant") {
      const text = extractMessageText(message?.content);
      if (text) payload.text = text;
    }
    // usage 是 P0 唯一的 token 明细来源（agent_runs.tokens_used 之外的明细），
    // 体积很小，必须保留；P0 验收脚本会断言它在。
    // 注意：工具结果消息（role="toolResult"）的 usage 是工具自身的执行开销，
    // 不等价于 LLM token —— 消费方需按 role 区分，别一概累加。
    if (message?.usage !== undefined) payload.usage = message.usage;
    return { type, payload: payload as Prisma.InputJsonValue };
  }

  if (TRIMMED_EVENT_TYPES.has(type)) {
    const message = event.message as { role?: string } | undefined;
    const payload: Record<string, unknown> = { role: message?.role ?? "assistant", trimmed: true };
    return { type, payload: payload as Prisma.InputJsonValue };
  }

  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event)) {
    if (key === "type") continue;
    payload[key] = value as unknown;
  }
  return { type, payload: payload as Prisma.InputJsonValue };
}

/** 落一条 Agent 事件，返回事件 id（自增 id 即 SSE 的 Last-Event-ID） */
export async function persistAgentEvent(runId: number, event: Record<string, unknown>): Promise<number> {
  const serialized = serializeEventForDb(event);
  const created = await prisma.agentEvent.create({
    data: {
      runId,
      type: serialized.type,
      payload: serialized.payload,
      createdAt: shanghaiNow(),
    },
  });
  return created.id;
}

export interface ArtifactRef {
  kind: ArtifactKind;
  id: number;
  title: string;
  href: string;
}

/**
 * 从工具产出中抽取工件引用（驱动右栏工件面板）
 *
 * 产出物配方来自 catalog 里各技能的 artifact 声明，**不另建映射表** ——
 * 单一真相源，避免两张表失配导致静默返回空工件。
 */
export function extractArtifacts(toolName: string, output: Record<string, unknown>): ArtifactRef[] {
  const definition = findSkillDefinition(toolName);
  const spec = definition?.artifact;
  if (!spec) return [];

  const rawIds = output[spec.idField];
  // 标题字段两种形状：数组（多产出，按索引对应）与字符串（单产出，如改写后的草稿标题）
  const rawTitles = spec.titleField ? output[spec.titleField] : undefined;
  let titles: string[] = [];
  if (Array.isArray(rawTitles)) titles = rawTitles as string[];
  else if (typeof rawTitles === "string" && rawTitles.trim()) titles = [rawTitles];

  // 多产出（如选题批量生成）：idField 是数组，标题按索引对应
  if (Array.isArray(rawIds)) {
    return rawIds
      .map((rawId, index) => {
        const id = Number(rawId);
        if (!id) return null;
        return {
          kind: spec.kind,
          id,
          title: titles[index] ?? `${definition.name} #${id}`,
          href: `${spec.hrefPrefix}${id}`,
        };
      })
      .filter((item): item is ArtifactRef => item !== null);
  }

  // 单产出（如草稿、审校工单）
  const id = Number(rawIds);
  if (!id) return [];
  return [
    {
      kind: spec.kind,
      id,
      title: titles[0] ?? `${definition.name} #${id}`,
      href: `${spec.hrefPrefix}${id}`,
    },
  ];
}

/** 落一条工具调用记录 */
export async function persistToolCall(options: {
  runId: number;
  stepIndex: number;
  toolName: string;
  toolCallId: string;
  params: Record<string, unknown>;
  result: Record<string, unknown> | null;
  status: "running" | "succeeded" | "failed" | "blocked";
  errorType?: string | null;
  durationMs?: number | null;
  /** 工具卡摘要（D21）。阻断路径在 beforeToolCall 就已知原因，一并写入 */
  summary?: string | null;
}): Promise<number> {
  const created = await prisma.agentToolCall.create({
    data: {
      runId: options.runId,
      stepIndex: options.stepIndex,
      toolName: options.toolName,
      toolCallId: options.toolCallId,
      params: options.params as Prisma.InputJsonValue,
      result: (options.result ?? undefined) as Prisma.InputJsonValue | undefined,
      status: options.status,
      errorType: options.errorType ?? null,
      durationMs: options.durationMs ?? null,
      summary: options.summary ?? null,
      createdAt: shanghaiNow(),
    },
  });
  return created.id;
}

/** 更新工具调用记录（执行结束时回填结果） */
export async function finalizeToolCall(options: {
  id: number;
  result: Record<string, unknown> | null;
  status: "succeeded" | "failed";
  errorType?: string | null;
  durationMs?: number | null;
  summary?: string | null;
}): Promise<void> {
  await prisma.agentToolCall.update({
    where: { id: options.id },
    data: {
      // 注意语义不对称（有意，不要「顺手统一」）：
      //   result 传 null 表示「本次不动这一列」（?? undefined 会被 Prisma 忽略）
      //   errorType / durationMs 传 null 表示「清空该列」（?? null 会真的写入 NULL）
      // 调用方若要保留原有 result，传 null 即可，不必回读。
      result: (options.result ?? undefined) as Prisma.InputJsonValue | undefined,
      status: options.status,
      errorType: options.errorType ?? null,
      durationMs: options.durationMs ?? null,
      // summary 与 result 同类：本次没算就不动这一列
      summary: options.summary ?? undefined,
    },
  });
}
