import { getCurrentUser } from "@/lib/server/core/auth";
import { prisma } from "@/lib/server/core/db";
import { notFound } from "@/lib/server/core/http-error";
import { handle } from "@/lib/server/core/route";
import { serializeExplosionReport } from "@/lib/server/services/exploration-service";
import { NextResponse } from "next/server";

/** GET /api/xhs/analytics/explosions/{reportId} 拆解报告详情 */
export const GET = handle(async (req, { params }) => {
  const user = await getCurrentUser(req);
  const reportId = Number.parseInt(params.reportId, 10);
  const report = await prisma.explosionReport.findFirst({ where: { id: reportId, userId: user.id } });
  if (!report) throw notFound("Explosion report not found");
  return NextResponse.json(serializeExplosionReport(report));
});
