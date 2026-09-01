import { getCurrentUser } from "@/lib/server/core/auth";
import { ApiError } from "@/lib/server/core/http-error";
import { handle, readJson } from "@/lib/server/core/route";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getCreatorAdapter, getLatestCreatorCookies, getOwnedCreatorAccount, payloadItems } from "../../shared";

const CreatorKeywordSchema = z.object({
  account_id: z.number().int(),
  keyword: z.string().min(1).max(120),
});

/** POST /api/xhs/creator/locations/search 地点搜索（对应原版 search_locations） */
export const POST = handle(async (req) => {
  const user = await getCurrentUser(req);
  const payload = await readJson(req, CreatorKeywordSchema);
  const account = await getOwnedCreatorAccount(user.id, payload.account_id);
  const adapter = await getCreatorAdapter(await getLatestCreatorCookies(account.id));
  const [success, message, rawPayload] = await adapter.getLocationInfo(payload.keyword);
  if (!success) throw new ApiError(502, message || "Creator location search failed");
  return NextResponse.json({ items: payloadItems(rawPayload), raw: rawPayload });
});
