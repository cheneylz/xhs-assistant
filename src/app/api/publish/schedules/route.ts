import { getCurrentUser } from "@/lib/server/core/auth";
import { prisma } from "@/lib/server/core/db";
import { handle } from "@/lib/server/core/route";
import { serializeScheduleSuggestion } from "@/lib/server/services/schedule-service";
import { NextResponse } from "next/server";

/** GET /api/publish/schedules 排期推荐列表（?platform_account_id= 指定账号） */
export const GET = handle(async (req, { searchParams }) => {
  const user = await getCurrentUser(req);
  const accountId = searchParams.get("platform_account_id") ? Number.parseInt(searchParams.get("platform_account_id") ?? "", 10) : undefined;
  const items = await prisma.scheduleSuggestion.findMany({
    where: {
      userId: user.id,
      ...(accountId && !Number.isNaN(accountId) ? { platformAccountId: accountId } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 30,
  });
  return NextResponse.json({ items: items.map(serializeScheduleSuggestion) });
});
