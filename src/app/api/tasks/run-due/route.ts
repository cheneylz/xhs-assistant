import { getCurrentUser } from "@/lib/server/core/auth";
import { ApiError } from "@/lib/server/core/http-error";
import { handle } from "@/lib/server/core/route";
import { runDuePublishJobs, type PublishAdapter } from "@/lib/server/services/scheduler-service";
import { NextResponse } from "next/server";

/**
 * 获取 Creator 发布适配器工厂（对应原版 get_creator_publish_adapter_factory -> XhsCreatorApiAdapter）
 * 注意：TS 端 Creator 发布适配器正在 src/lib/server/xhs/ 下开发，尚未完成；
 * 此处先抛出明确错误，避免占位实现把到期任务误标为失败。
 * 完成后替换为真实适配器即可（如 adapterFactory = XhsCreatorApiAdapter）
 */
function getCreatorPublishAdapterFactory(): (cookies: string) => PublishAdapter {
  throw new ApiError(501, "Creator publish adapter is not available yet");
}

/** POST /api/tasks/run-due 执行当前用户全部到期发布任务（对应原版 run_due_tasks） */
export const POST = handle(async (req, { searchParams }) => {
  const user = await getCurrentUser(req);
  const platform = searchParams.get("platform") ?? "xhs";
  const result = await runDuePublishJobs({
    userId: user.id,
    now: undefined,
    platform,
    adapterFactory: getCreatorPublishAdapterFactory(),
  });
  return NextResponse.json(result);
});
