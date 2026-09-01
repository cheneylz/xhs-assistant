import { getCurrentUser } from "@/lib/server/core/auth";
import { handle } from "@/lib/server/core/route";
import { formatDate } from "@/lib/server/core/time";
import { NextResponse } from "next/server";
import { noteMetrics, ownedNotes, type NoteMetrics } from "../shared";

/** 单日互动量统计（对应原版 Counter.update 语义） */
interface DailyCounter {
  likes: number;
  collects: number;
  comments: number;
  shares: number;
  engagement: number;
}

/** GET /api/xhs/analytics/engagement 按日互动量（对应原版 engagement） */
export const GET = handle(async (req) => {
  const user = await getCurrentUser(req);
  const notes = await ownedNotes(user.id);
  const daily = new Map<string, DailyCounter>();
  for (const note of notes) {
    const metrics: NoteMetrics = noteMetrics(note);
    const key = formatDate(note.createdAt);
    const entry = daily.get(key) ?? { likes: 0, collects: 0, comments: 0, shares: 0, engagement: 0 };
    entry.likes += metrics.likes;
    entry.collects += metrics.collects;
    entry.comments += metrics.comments;
    entry.shares += metrics.shares;
    entry.engagement += metrics.engagement;
    daily.set(key, entry);
  }
  const items = [...daily.entries()]
    .sort(([dateA], [dateB]) => dateA.localeCompare(dateB))
    .map(([date, counter]) => ({ date, ...counter }));
  return NextResponse.json({ items });
});
