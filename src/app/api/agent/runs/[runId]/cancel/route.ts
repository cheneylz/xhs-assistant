import { getCurrentUser } from "@/lib/server/core/auth";
import { ApiError, notFound } from "@/lib/server/core/http-error";
import { handle, parsePathId } from "@/lib/server/core/route";
import { cancelPendingRun } from "@/lib/server/services/agent-service";
import { NextResponse } from "next/server";
import { serializeRun } from "../../../shared";

/**
 * POST /api/agent/runs/[runId]/cancel 取消 Run —— 仅 pending（P1 设计稿 D19 / §4.2）
 *
 *   200 pending  → 置 cancelled，同步 Task 为 failed，会话回 idle
 *   409 running  → 已开始执行，P1 不支持中止运行中的任务
 *   409 终态     → 已是终态，无需取消
 *   404 不存在或不属于当前用户
 *
 * 三种结局都在服务层判完（`cancelled | conflict | not_found`），这里只做状态码映射。
 */
export const POST = handle(async (req, { params }) => {
  const user = await getCurrentUser(req);
  const runId = parsePathId(params.runId, "Run id");
  const result = await cancelPendingRun(runId, user.id);
  if (result.outcome === "not_found") throw notFound("Run 不存在");
  if (result.outcome === "conflict") throw new ApiError(409, result.reason);
  return NextResponse.json({ run: serializeRun(result.run) });
});
