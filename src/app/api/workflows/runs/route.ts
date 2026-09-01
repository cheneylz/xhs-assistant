import { getCurrentUser } from "@/lib/server/core/auth";
import { handle } from "@/lib/server/core/route";
import { listWorkflowRuns } from "@/lib/server/services/workflow-service";
import { NextResponse } from "next/server";

/** GET /api/workflows/runs 最近的工作流执行记录 */
export const GET = handle(async (req) => {
  const user = await getCurrentUser(req);
  const items = await listWorkflowRuns(user.id);
  return NextResponse.json({ items });
});
