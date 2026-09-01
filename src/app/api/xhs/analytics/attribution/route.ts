import { getCurrentUser } from "@/lib/server/core/auth";
import { ApiError } from "@/lib/server/core/http-error";
import { handle } from "@/lib/server/core/route";
import { generateAttribution } from "@/lib/server/services/attribution-service";
import { OpenAICompatibleTextClient } from "@/lib/server/services/ai-service";
import { textModelContext } from "../../../ai/shared";
import { makeUsageLogger } from "@/lib/server/services/usage-service";
import { NextResponse } from "next/server";

/** POST /api/xhs/analytics/attribution A-02 效果归因：高/低表现内容对比 → LLM 归因结论 */
export const POST = handle(async (req) => {
  const user = await getCurrentUser(req);
  const { modelConfig, apiKey } = await textModelContext(user.id);
  try {
    const result = await generateAttribution({
      userId: user.id,
      textClient: new OpenAICompatibleTextClient(),
      modelConfig,
      apiKey,
    });
    return NextResponse.json(result);
  } catch (error) {
    throw new ApiError(400, (error as Error).message);
  }
});
