import { getCurrentUser } from "@/lib/server/core/auth";
import { ApiError } from "@/lib/server/core/http-error";
import { handle, readJson } from "@/lib/server/core/route";
import { runWorkflow } from "@/lib/server/services/workflow-service";
import { NextResponse } from "next/server";
import { z } from "zod";

const RunWorkflowSchema = z.object({
  workflow_key: z.string().min(1),
  params: z.record(z.string(), z.unknown()).default({}),
});

/** POST /api/workflows/run 执行预置工作流（S-04） */
export const POST = handle(async (req) => {
  const user = await getCurrentUser(req);
  const payload = await readJson(req, RunWorkflowSchema);
  try {
    const result = await runWorkflow({
      userId: user.id,
      workflowKey: payload.workflow_key,
      extraParams: payload.params,
    });
    // snake_case 序列化（与全系统 REST 约定一致）
    return NextResponse.json({
      workflow_key: result.workflowKey,
      status: result.status,
      steps: result.steps.map((step) => ({
        skill_key: step.skillKey,
        status: step.status,
        output: step.output,
        error: step.error ?? null,
      })),
    });
  } catch (error) {
    throw new ApiError(400, (error as Error).message);
  }
});
