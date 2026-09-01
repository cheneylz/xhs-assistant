import { getCurrentUser } from "@/lib/server/core/auth";
import { handle } from "@/lib/server/core/route";
import { formatDateTime } from "@/lib/server/core/time";
import { latestHotTopicBatch } from "@/lib/server/services/hot-topic-service";
import { NextResponse } from "next/server";

/** GET /api/hot-topics 全站热点榜单（最新一批快照，?category= 分类筛选） */
export const GET = handle(async (req, { searchParams }) => {
  const user = await getCurrentUser(req);
  const category = searchParams.get("category") ?? undefined;
  const { snapAt, items } = await latestHotTopicBatch(user.id, category);
  return NextResponse.json({
    snap_at: snapAt ? formatDateTime(snapAt) : null,
    estimated: true, // 逆向采集估算，前端标注「估算」
    items,
  });
});
