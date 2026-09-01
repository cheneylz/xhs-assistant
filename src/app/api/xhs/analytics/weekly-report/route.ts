import { getCurrentUser } from "@/lib/server/core/auth";
import { handle } from "@/lib/server/core/route";
import { generateWeeklyReport } from "@/lib/server/services/attribution-service";
import { OpenAICompatibleTextClient } from "@/lib/server/services/ai-service";
import { textModelContext } from "../../../ai/shared";
import { makeUsageLogger } from "@/lib/server/services/usage-service";
import { NextResponse } from "next/server";

/** POST /api/xhs/analytics/weekly-report A-04 运营周报：数据汇总 + LLM 叙述 */
export const POST = handle(async (req) => {
  const user = await getCurrentUser(req);
  const { modelConfig, apiKey } = await textModelContext(user.id);
  const result = await generateWeeklyReport({
    userId: user.id,
    textClient: new OpenAICompatibleTextClient(),
    modelConfig,
    apiKey,
  });
  return NextResponse.json(result);
});
