import { getCurrentUser } from "@/lib/server/core/auth";
import { ApiError } from "@/lib/server/core/http-error";
import { handle } from "@/lib/server/core/route";
import { NextResponse } from "next/server";
import { noteMetrics, ownedNotes, serializeTopNote } from "../shared";

/** GET /api/xhs/analytics/top-content 热门内容（limit 1..100，默认 20，对应原版 top_content） */
export const GET = handle(async (req, { searchParams }) => {
  const user = await getCurrentUser(req);
  const limit = Number.parseInt(searchParams.get("limit") ?? "20", 10);
  if (Number.isNaN(limit) || limit < 1 || limit > 100) {
    throw new ApiError(422, "limit must be between 1 and 100");
  }
  const notes = (await ownedNotes(user.id)).sort((a, b) => noteMetrics(b).engagement - noteMetrics(a).engagement);
  return NextResponse.json({ items: notes.slice(0, limit).map(serializeTopNote) });
});
