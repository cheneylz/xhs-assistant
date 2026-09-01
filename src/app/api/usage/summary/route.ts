import { getCurrentUser } from "@/lib/server/core/auth";
import { handle } from "@/lib/server/core/route";
import { usageSummary } from "@/lib/server/services/usage-service";
import { NextResponse } from "next/server";

/** GET /api/usage/summary?days=7 AI 用量汇总（S-06，按模型分组） */
export const GET = handle(async (req, { searchParams }) => {
  const user = await getCurrentUser(req);
  const days = Number.parseInt(searchParams.get("days") ?? "7", 10);
  const summary = await usageSummary(user.id, Number.isNaN(days) ? 7 : Math.min(Math.max(days, 1), 90));
  return NextResponse.json(summary);
});
