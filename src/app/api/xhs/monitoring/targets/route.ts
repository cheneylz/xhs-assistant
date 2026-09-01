import type { Prisma } from "@prisma/client";
import { getCurrentUser } from "@/lib/server/core/auth";
import { prisma } from "@/lib/server/core/db";
import { paginated } from "@/lib/server/core/paginate";
import { handle, readJson } from "@/lib/server/core/route";
import { shanghaiNow } from "@/lib/server/core/time";
import { serializeTarget } from "@/lib/server/services/monitoring-crawl-service";
import { NextResponse } from "next/server";
import { z } from "zod";

const MonitoringTargetCreateSchema = z.object({
  target_type: z.enum(["keyword", "account", "brand", "note_url"]),
  name: z.string().max(128).default(""),
  value: z.string().min(1).max(512),
  status: z.enum(["active", "paused"]).default("active"),
  config: z.record(z.string(), z.unknown()).default({}),
});

/** GET /api/xhs/monitoring/targets 目标列表（对应原版 targets） */
export const GET = handle(async (req, { searchParams }) => {
  const user = await getCurrentUser(req);
  const page = Number.parseInt(searchParams.get("page") ?? "1", 10);
  const pageSize = Number.parseInt(searchParams.get("page_size") ?? "20", 10);
  const rows = await prisma.monitoringTarget.findMany({
    where: { userId: user.id, platform: "xhs" },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  return NextResponse.json(paginated(rows.map(serializeTarget), page, pageSize));
});

/** POST /api/xhs/monitoring/targets 创建目标（对应原版 create_target） */
export const POST = handle(async (req) => {
  const user = await getCurrentUser(req);
  const payload = await readJson(req, MonitoringTargetCreateSchema);
  const now = shanghaiNow();
  const target = await prisma.monitoringTarget.create({
    data: {
      userId: user.id,
      platform: "xhs",
      targetType: payload.target_type,
      name: payload.name || payload.value,
      value: payload.value,
      status: payload.status,
      config: payload.config as unknown as Prisma.InputJsonValue,
      createdAt: now,
      updatedAt: now,
    },
  });
  return NextResponse.json(serializeTarget(target));
});
