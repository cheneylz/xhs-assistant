import { getCurrentUser } from "@/lib/server/core/auth";
import { ApiError } from "@/lib/server/core/http-error";
import { handle, readJson } from "@/lib/server/core/route";
import { normalizeDetailPayload } from "@/lib/server/services/crawl-normalizers";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getOwnedPcAccountCookies } from "../../shared";

const NoteDetailSchema = z.object({
  account_id: z.number().int(),
  url: z.string().min(1),
});

/** POST /api/xhs/pc/notes/detail 笔记详情（对应原版 note_detail） */
export const POST = handle(async (req) => {
  const user = await getCurrentUser(req);
  const payload = await readJson(req, NoteDetailSchema);
  const cookies = await getOwnedPcAccountCookies(user.id, payload.account_id);
  const { XhsPcApiAdapter } = await import("@/lib/server/xhs/adapters/pc-api-adapter");
  const adapter = new XhsPcApiAdapter(cookies);
  const [success, message, rawPayload] = await adapter.getNoteInfo(payload.url);
  if (!success) throw new ApiError(502, message || "XHS note detail failed");
  return NextResponse.json(normalizeDetailPayload((rawPayload ?? {}) as Record<string, unknown>, payload.url));
});
