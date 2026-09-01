import { getCurrentUser } from "@/lib/server/core/auth";
import { handle } from "@/lib/server/core/route";
import { NextResponse } from "next/server";

/** GET /api/auth/me 当前用户信息（含角色 S-01） */
export const GET = handle(async (req) => {
  const user = await getCurrentUser(req);
  return NextResponse.json({ id: user.id, username: user.username, role: user.role });
});
