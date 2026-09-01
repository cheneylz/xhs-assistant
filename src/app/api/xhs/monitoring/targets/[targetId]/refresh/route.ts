import { getCurrentUser } from "@/lib/server/core/auth";
import { prisma } from "@/lib/server/core/db";
import { notFound } from "@/lib/server/core/http-error";
import { handle } from "@/lib/server/core/route";
import { executeMonitoringRefresh } from "@/lib/server/services/monitoring-crawl-service";
import { NextResponse } from "next/server";

/** POST /api/xhs/monitoring/targets/{targetId}/refresh 手动刷新（对应原版 refresh_target） */
export const POST = handle(async (req, { params }) => {
  const user = await getCurrentUser(req);
  const targetId = Number.parseInt(params.targetId, 10);
  const target = await prisma.monitoringTarget.findUnique({ where: { id: targetId } });
  if (!target || target.userId !== user.id || target.platform !== "xhs") {
    throw notFound("Monitoring target not found");
  }
  const result = await executeMonitoringRefresh({ targetId, userId: user.id });
  return NextResponse.json(result);
});
