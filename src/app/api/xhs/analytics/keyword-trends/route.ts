import { getCurrentUser } from "@/lib/server/core/auth";
import { handle } from "@/lib/server/core/route";
import { NextResponse } from "next/server";
import { keywordTrendItems, ownedNotes } from "../shared";

/** GET /api/xhs/analytics/keyword-trends 关键词趋势（对应原版 keyword_trends） */
export const GET = handle(async (req) => {
  const user = await getCurrentUser(req);
  const notes = await ownedNotes(user.id);
  return NextResponse.json({ items: await keywordTrendItems(user.id, notes) });
});
