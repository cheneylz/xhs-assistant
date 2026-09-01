import { getCurrentUser } from "@/lib/server/core/auth";
import { badRequest } from "@/lib/server/core/http-error";
import { handle } from "@/lib/server/core/route";
import { NextResponse } from "next/server";

/** POST /api/hot-topics/refresh 手动刷新热点榜单（同步采集，耗时约 1-3 分钟） */
export const POST = handle(async (req) => {
  const user = await getCurrentUser(req);
  const { collectHotTopicsForUser } = await import("@/lib/server/services/hot-topic-service");
  const { XhsPcApiAdapter } = await import("@/lib/server/xhs/adapters/pc-api-adapter");
  const result = await collectHotTopicsForUser({
    userId: user.id,
    adapterFactory: (cookies) => new XhsPcApiAdapter(cookies),
  });
  if (!result.collected) throw badRequest(result.reason ?? "热点采集失败，请检查 PC 账号与关键词组配置");
  return NextResponse.json(result);
});
