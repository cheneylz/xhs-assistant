import { getCurrentUser } from "@/lib/server/core/auth";
import { prisma } from "@/lib/server/core/db";
import { notFound } from "@/lib/server/core/http-error";
import { handle } from "@/lib/server/core/route";
import { serializeSnapshot } from "@/lib/server/services/monitoring-crawl-service";
import { NextResponse } from "next/server";

/** GET /api/xhs/monitoring/targets/{targetId}/snapshots 快照列表（对应原版 target_snapshots） */
export const GET = handle(async (req, { params }) => {
  const user = await getCurrentUser(req);
  const targetId = Number.parseInt(params.targetId, 10);
  const target = await prisma.monitoringTarget.findUnique({ where: { id: targetId } });
  if (!target || target.userId !== user.id || target.platform !== "xhs") {
    throw notFound("Monitoring target not found");
  }
  const snapshots = await prisma.monitoringSnapshot.findMany({
    where: { targetId: target.id },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  return NextResponse.json({ target_id: target.id, items: snapshots.map(serializeSnapshot) });
});
