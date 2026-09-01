import { handle } from "@/lib/server/core/route";
import { NextResponse } from "next/server";

/** POST /api/auth/logout 登出（无状态 JWT，仅返回 ok） */
export const POST = handle(async () => {
  return NextResponse.json({ status: "ok" });
});
