import { getCurrentUser } from "@/lib/server/core/auth";
import { prisma } from "@/lib/server/core/db";
import { handle } from "@/lib/server/core/route";
import { formatDate, shanghaiNow } from "@/lib/server/core/time";
import { NextResponse } from "next/server";
import { noteMetrics, ownedComments, ownedNotes, topicItems } from "../shared";

/** GET /api/xhs/analytics/overview 总览（对应原版 overview） */
export const GET = handle(async (req) => {
  const user = await getCurrentUser(req);
  const notes = await ownedNotes(user.id);
  const comments = await ownedComments(user.id);
  const accounts = await prisma.platformAccount.findMany({
    where: { userId: user.id, platform: "xhs" },
  });
  const pendingPublishes = await prisma.publishJob.findMany({
    where: {
      userId: user.id,
      platform: "xhs",
      status: { in: ["pending", "uploading", "publishing", "scheduled"] },
    },
  });
  const todayStr = formatDate(shanghaiNow());
  const totalEngagement = notes.reduce((sum, note) => sum + noteMetrics(note).engagement, 0);
  const hotTopics = await topicItems(user.id, notes);
  return NextResponse.json({
    platform: "xhs",
    today_crawls: notes.filter((note) => formatDate(note.createdAt) === todayStr).length,
    saved_notes: notes.length,
    pending_publishes: pendingPublishes.length,
    healthy_accounts: accounts.filter((account) => account.status === "active" || account.status === "healthy").length,
    at_risk_accounts: accounts.filter((account) => account.status !== "active" && account.status !== "healthy").length,
    comment_count: comments.length,
    total_engagement: totalEngagement,
    hot_topics: hotTopics.slice(0, 5),
    recent_activity: notes.slice(0, 5).map((note) => ({
      type: "note",
      title: note.title || note.noteId,
      status: "saved",
    })),
  });
});
