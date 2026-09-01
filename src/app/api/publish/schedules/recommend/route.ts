import { getCurrentUser } from "@/lib/server/core/auth";
import { ApiError } from "@/lib/server/core/http-error";
import { handle, readJson } from "@/lib/server/core/route";
import { recommendSchedules, saveScheduleSlots } from "@/lib/server/services/schedule-service";
import { NextResponse } from "next/server";
import { z } from "zod";

const RecommendSchema = z.object({
  platform_account_id: z.number().int(),
  days: z.number().int().min(1).max(7).default(3),
});

/** POST /api/publish/schedules/recommend D-01 智能排期：历史互动高峰时段 + 约束 → 推荐排期（落库） */
export const POST = handle(async (req) => {
  const user = await getCurrentUser(req);
  const payload = await readJson(req, RecommendSchema);
  try {
    const { slots, bufferRemaining, reason } = await recommendSchedules({
      userId: user.id,
      platformAccountId: payload.platform_account_id,
      days: payload.days,
    });
    const items = slots.length ? await saveScheduleSlots({ userId: user.id, platformAccountId: payload.platform_account_id, slots }) : [];
    return NextResponse.json({ total: items.length, items, buffer_remaining: bufferRemaining, reason });
  } catch (error) {
    throw new ApiError(400, (error as Error).message);
  }
});
