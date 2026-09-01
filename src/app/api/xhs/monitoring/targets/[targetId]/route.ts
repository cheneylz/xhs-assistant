import { getCurrentUser } from "@/lib/server/core/auth";
import { prisma } from "@/lib/server/core/db";
import { notFound } from "@/lib/server/core/http-error";
import { handle, readJson } from "@/lib/server/core/route";
import { shanghaiNow } from "@/lib/server/core/time";
import { serializeTarget } from "@/lib/server/services/monitoring-crawl-service";
import { NextResponse } from "next/server";
import { z } from "zod";

const MonitoringTargetUpdateSchema = z.object({
  name: z.string().max(128).optional(),
  value: z.string().min(1).max(512).optional(),
  status: z.enum(["active", "paused"]).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});

async function getOwnedTarget(userId: number, targetId: number) {
  const target = await prisma.monitoringTarget.findUnique({ where: { id: targetId } });
  if (!target || target.userId !== userId || target.platform !== "xhs") {
    throw notFound("Monitoring target not found");
  }
  return target;
}

/** PATCH /api/xhs/monitoring/targets/{targetId} 更新（对应原版 update_target） */
export const PATCH = handle(async (req, { params }) => {
  const user = await getCurrentUser(req);
  const targetId = Number.parseInt(params.targetId, 10);
  const target = await getOwnedTarget(user.id, targetId);
  const payload = await readJson(req, MonitoringTargetUpdateSchema);
  const data: Record<string, unknown> = { updatedAt: shanghaiNow() };
  if (payload.name !== undefined) data.name = payload.name;
  if (payload.value !== undefined) data.value = payload.value;
  if (payload.status !== undefined) data.status = payload.status;
  if (payload.config !== undefined) data.config = payload.config;
  const updated = await prisma.monitoringTarget.update({ where: { id: target.id }, data });
  return NextResponse.json(serializeTarget(updated));
});

/** DELETE /api/xhs/monitoring/targets/{targetId} 删除（对应原版 delete_target） */
export const DELETE = handle(async (req, { params }) => {
  const user = await getCurrentUser(req);
  const targetId = Number.parseInt(params.targetId, 10);
  await getOwnedTarget(user.id, targetId);
  await prisma.monitoringSnapshot.deleteMany({ where: { targetId } });
  await prisma.monitoringTarget.delete({ where: { id: targetId } });
  return NextResponse.json({ id: targetId, status: "deleted" });
});
