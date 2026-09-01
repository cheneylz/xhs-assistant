import { getCurrentUser } from "@/lib/server/core/auth";
import { badRequest } from "@/lib/server/core/http-error";
import { handle } from "@/lib/server/core/route";
import { deleteFewShotNote } from "@/lib/server/services/knowledge-base-service";
import { NextResponse } from "next/server";

/** DELETE /api/knowledge-base/few-shot/{itemId} 删除 Few-shot 样本 */
export const DELETE = handle(async (req, { params }) => {
  const user = await getCurrentUser(req);
  const itemId = Number.parseInt(params.itemId, 10);
  if (Number.isNaN(itemId)) throw badRequest("样本 ID 无效");
  await deleteFewShotNote(user.id, itemId);
  return NextResponse.json({ success: true });
});
