import { getCurrentUser } from "@/lib/server/core/auth";
import { ApiError } from "@/lib/server/core/http-error";
import { handle } from "@/lib/server/core/route";
import { NextResponse } from "next/server";
import { getCreatorAdapter, getLatestCreatorCookies, getOwnedCreatorAccount, payloadItems } from "../shared";

/** GET /api/xhs/creator/published 已发布笔记（对应原版 published） */
export const GET = handle(async (req, { searchParams }) => {
  const user = await getCurrentUser(req);
  const accountId = Number.parseInt(searchParams.get("account_id") ?? "", 10);
  const account = await getOwnedCreatorAccount(user.id, accountId);
  const adapter = await getCreatorAdapter(await getLatestCreatorCookies(account.id));
  const [success, message, rawPayload] = await adapter.getPublishedNotes();
  if (!success) throw new ApiError(502, message || "Creator published list failed");
  return NextResponse.json({ items: payloadItems(rawPayload), raw: rawPayload });
});
