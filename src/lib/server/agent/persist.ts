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
const TRIMMED_EVENT_TYPES = new Set(["message_update", "message_start", "message_end"]);

export interface SerializedEvent {
  type: string;
  payload: Prisma.InputJsonValue;
}

/** 事件 → 可落库的 { type, payload }，大体积事件只留摘要 */
export function serializeEventForDb(event: Record<string, unknown>): SerializedEvent {
  const type = String(event.type ?? "unknown");

  if (TRIMMED_EVENT_TYPES.has(type)) {
    const message = event.message as { role?: string; usage?: unknown } | undefined;
    const payload: Record<string, unknown> = { role: message?.role ?? "assistant", trimmed: true };
    // message_end 的 usage 是 P0 唯一的 token 基线（agent_runs.tokens_used 之外的明细来源），
    // 体积很小，必须保留；整条 message 的其余部分仍然剔除。
    if (type === "message_end" && message?.usage !== undefined) payload.usage = message.usage;
    return { type, payload: payload as Prisma.InputJsonValue };
  }

  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event)) {
    if (key === "type") continue;
    payload[key] = value as unknown;
  }
  return { type, payload: payload as Prisma.InputJsonValue };
}

/** 落一条 Agent 事件 */
export async function persistAgentEvent(runId: number, event: Record<string, unknown>): Promise<void> {
  const serialized = serializeEventForDb(event);
  await prisma.agentEvent.create({
    data: {
      runId,
      type: serialized.type,
      payload: serialized.payload,
      createdAt: shanghaiNow(),
    },
  });
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
  const titles =
    spec.titleField && Array.isArray(output[spec.titleField]) ? (output[spec.titleField] as string[]) : [];

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
    },
  });
}
