import { getCurrentUser } from "@/lib/server/core/auth";
import { prisma } from "@/lib/server/core/db";
import { ApiError } from "@/lib/server/core/http-error";
import { handle } from "@/lib/server/core/route";
import { shanghaiNow } from "@/lib/server/core/time";
import { NextResponse } from "next/server";
import { benchmarkMatches, getOwnedBenchmarkTarget, ownedNotes, serializeDraft } from "../../../shared";

/** POST /api/xhs/analytics/benchmarks/{targetId}/create-drafts 为 benchmark 匹配笔记生成 AI 草稿（对应原版 create_benchmark_drafts） */
export const POST = handle(async (req, { params, searchParams }) => {
  const user = await getCurrentUser(req);
  const targetId = Number.parseInt(params.targetId, 10);
  if (Number.isNaN(targetId)) throw new ApiError(422, "target_id must be an integer");
  const limit = Number.parseInt(searchParams.get("limit") ?? "5", 10);
  if (Number.isNaN(limit) || limit < 1 || limit > 20) {
    throw new ApiError(422, "limit must be between 1 and 20");
  }
  const target = await getOwnedBenchmarkTarget(user.id, targetId);
  const matched = benchmarkMatches(await ownedNotes(user.id), target).slice(0, limit);

  // 逐条创建草稿（对应原版 add_all + commit + refresh）
  const drafts = [];
  for (const note of matched) {
    drafts.push(
      await prisma.aiDraft.create({
        data: {
          userId: user.id,
          platform: "xhs",
          title: note.title,
          body: note.content,
          sourceNoteId: note.id,
          createdAt: shanghaiNow(),
        },
      }),
    );
  }
  return NextResponse.json({
    created_count: drafts.length,
    items: drafts.map(serializeDraft),
  });
});
