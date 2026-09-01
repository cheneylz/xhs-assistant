import { getCurrentUser } from "@/lib/server/core/auth";
import { prisma } from "@/lib/server/core/db";
import { handle } from "@/lib/server/core/route";
import { formatDateTime } from "@/lib/server/core/time";
import { NextResponse } from "next/server";
import { benchmarkMatches, noteMetrics, ownedNotes, pythonRound, serializeTopNote } from "../shared";

/** GET /api/xhs/analytics/benchmarks benchmark 列表（含聚合汇总，对应原版 benchmarks） */
export const GET = handle(async (req) => {
  const user = await getCurrentUser(req);
  const notes = await ownedNotes(user.id);
  const targets = await prisma.monitoringTarget.findMany({
    where: { userId: user.id, platform: "xhs", targetType: { in: ["account", "brand"] } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });

  const items: Array<Record<string, unknown>> = [];
  for (const target of targets) {
    const matched = benchmarkMatches(notes, target);
    const totalEngagement = matched.reduce((sum, note) => sum + noteMetrics(note).engagement, 0);
    items.push({
      target_id: target.id,
      target_type: target.targetType,
      name: target.name || target.value,
      value: target.value,
      status: target.status,
      last_refreshed_at: target.lastRefreshedAt ? formatDateTime(target.lastRefreshedAt) : null,
      matched_notes: matched.length,
      total_engagement: totalEngagement,
      average_engagement: matched.length ? pythonRound(totalEngagement / matched.length, 2) : 0,
      top_notes: matched.slice(0, 5).map(serializeTopNote),
    });
  }

  // 按 (total_engagement, matched_notes, name) 全部倒序（对应原版 sorted(..., reverse=True)）
  items.sort(
    (a, b) =>
      (b.total_engagement as number) - (a.total_engagement as number) ||
      (b.matched_notes as number) - (a.matched_notes as number) ||
      String(b.name).localeCompare(String(a.name)),
  );
  const totalMatched = items.reduce((sum, item) => sum + (item.matched_notes as number), 0);
  const totalEngagement = items.reduce((sum, item) => sum + (item.total_engagement as number), 0);
  return NextResponse.json({
    total_targets: items.length,
    matched_notes: totalMatched,
    total_engagement: totalEngagement,
    average_engagement: totalMatched ? pythonRound(totalEngagement / totalMatched, 2) : 0,
    items,
  });
});
