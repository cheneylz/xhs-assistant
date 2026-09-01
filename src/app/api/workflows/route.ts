import { getCurrentUser } from "@/lib/server/core/auth";
import { handle } from "@/lib/server/core/route";
import { ensureUserSkills, PREBUILT_WORKFLOWS, serializeWorkflow } from "@/lib/server/services/workflow-service";
import { NextResponse } from "next/server";

/** GET /api/workflows 预置工作流列表（含技能步骤说明） */
export const GET = handle(async (req) => {
  const user = await getCurrentUser(req);
  await ensureUserSkills(user.id);
  return NextResponse.json({ items: PREBUILT_WORKFLOWS.map(serializeWorkflow) });
});
