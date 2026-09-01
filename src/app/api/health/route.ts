import { handle } from "@/lib/server/core/route";
import { NextResponse } from "next/server";

/** GET /api/health 健康检） */
export const GET = handle(async () => {
  return NextResponse.json({ status: "ok", service: "xhs_crawer" });
});
