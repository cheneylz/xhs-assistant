import { getCurrentUser } from "@/lib/server/core/auth";
import { ApiError } from "@/lib/server/core/http-error";
import { handle, readJson } from "@/lib/server/core/route";
import { serializeTask } from "@/lib/server/services/task-serializer";
import { NextResponse } from "next/server";
import { z } from "zod";
import { completeOperationTask, createOperationTask, failOperationTask, getCreatorAdapter, getLatestCreatorCookies, getOwnedCreatorAccount } from "../../shared";

const CreatorUploadSchema = z.object({
  account_id: z.number().int(),
  file_path: z.string().min(1),
  media_type: z.enum(["image", "video"]).default("image"),
});

/** POST /api/xhs/creator/assets/upload 素材上传（对应原版 upload_asset） */
export const POST = handle(async (req) => {
  const user = await getCurrentUser(req);
  const payload = await readJson(req, CreatorUploadSchema);
  const account = await getOwnedCreatorAccount(user.id, payload.account_id);
  const task = await createOperationTask(user.id, "creator_direct_upload", {
    account_id: account.id,
    file_path: payload.file_path,
    media_type: payload.media_type,
  });
  try {
    const adapter = await getCreatorAdapter(await getLatestCreatorCookies(account.id));
    const uploadPayload = await adapter.uploadMedia(payload.file_path, payload.media_type);
    await completeOperationTask(task.id, { payload: uploadPayload });
    const completed = await prismaTask(task.id);
    return NextResponse.json({ task: serializeTask(completed), payload: uploadPayload });
  } catch (error) {
    await failOperationTask(task.id, (error as Error).message);
    throw new ApiError(502, (error as Error).message);
  }
});

import { prisma } from "@/lib/server/core/db";
async function prismaTask(taskId: number) {
  const task = await prisma.task.findUnique({ where: { id: taskId } });
  if (!task) throw new Error("Task not found");
  return task;
}
