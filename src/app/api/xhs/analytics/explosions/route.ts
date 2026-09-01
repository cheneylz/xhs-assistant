import { getCurrentUser } from "@/lib/server/core/auth";
import { ApiError } from "@/lib/server/core/http-error";
import { handle, readJson } from "@/lib/server/core/route";
import { analyzeExplosions, listExplosionReports } from "@/lib/server/services/exploration-service";
import { OpenAICompatibleTextClient } from "@/lib/server/services/ai-service";
import { textModelContext } from "../../../ai/shared";
import { makeUsageLogger } from "@/lib/server/services/usage-service";
import { NextResponse } from "next/server";
import { z } from "zod";

const AnalyzeSchema = z.object({
  keyword: z.string().min(1).max(50),
  range_days: z.number().int().min(1).max(30).default(7),
});

/** POST /api/xhs/analytics/explosions P-02 爆款拆解：搜索低粉高互动笔记 → LLM 结构化拆解报告 */
export const POST = handle(async (req) => {
  const user = await getCurrentUser(req);
  const payload = await readJson(req, AnalyzeSchema);
  const { modelConfig, apiKey } = await textModelContext(user.id);
  const { XhsPcApiAdapter } = await import("@/lib/server/xhs/adapters/pc-api-adapter");
  try {
    const { report } = await analyzeExplosions({
      userId: user.id,
      keyword: payload.keyword.trim(),
      rangeDays: payload.range_days,
      adapterFactory: (cookies) => new XhsPcApiAdapter(cookies),
      textClient: new OpenAICompatibleTextClient(),
      modelConfig,
      apiKey,
    });
    return NextResponse.json(report);
  } catch (error) {
    throw new ApiError(400, (error as Error).message);
  }
});

/** GET /api/xhs/analytics/explosions 拆解报告列表 */
export const GET = handle(async (req, { searchParams }) => {
  const user = await getCurrentUser(req);
  const limit = Number.parseInt(searchParams.get("limit") ?? "20", 10);
  const items = await listExplosionReports(user.id, Number.isNaN(limit) ? 20 : limit);
  return NextResponse.json({ items });
});
