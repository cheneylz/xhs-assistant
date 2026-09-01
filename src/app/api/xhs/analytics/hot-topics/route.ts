import { getCurrentUser } from "@/lib/server/core/auth";
import { handle } from "@/lib/server/core/route";
import { NextResponse } from "next/server";
import { ownedNotes, topicItems } from "../shared";

/** GET /api/xhs/analytics/hot-topics 热门话题（对应原版 hot_topics） */
export const GET = handle(async (req) => {
  const user = await getCurrentUser(req);
  const notes = await ownedNotes(user.id);
  return NextResponse.json({ items: await topicItems(user.id, notes) });
});
