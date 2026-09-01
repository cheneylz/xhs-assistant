import { getCurrentUser } from "@/lib/server/core/auth";
import { handle, readJson } from "@/lib/server/core/route";
import { addLesson } from "@/lib/server/services/knowledge-base-service";
import { NextResponse } from "next/server";
import { z } from "zod";

const AddLessonSchema = z.object({
  platform_account_id: z.number().int().nullable().optional(),
  lesson: z.string().min(2).max(500),
});

/** POST /api/knowledge-base/lessons 闭环学习（A-06）：将归因结论写回知识库经验结论 */
export const POST = handle(async (req) => {
  const user = await getCurrentUser(req);
  const payload = await readJson(req, AddLessonSchema);
  const lessons = await addLesson(user.id, payload.platform_account_id ?? null, payload.lesson);
  return NextResponse.json({ lessons_learned: lessons });
});
