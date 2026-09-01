import { getCurrentUser } from "@/lib/server/core/auth";
import { handle } from "@/lib/server/core/route";
import { diagnoseAccounts } from "@/lib/server/services/account-health-service";
import { NextResponse } from "next/server";

/** GET /api/xhs/analytics/health A-03 账号健康诊断（规则打分） */
export const GET = handle(async (req) => {
  const user = await getCurrentUser(req);
  const items = await diagnoseAccounts(user.id);
  return NextResponse.json({ items });
});
