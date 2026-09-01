import { getCurrentUser } from "@/lib/server/core/auth";
import { ApiError } from "@/lib/server/core/http-error";
import { handle, readJson } from "@/lib/server/core/route";
import { normalizeCommentPayload } from "@/lib/server/services/crawl-normalizers";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getOwnedPcAccountCookies } from "../../shared";

const NoteCommentsSchema = z.object({
  account_id: z.number().int(),
  note_url: z.string().min(1),
});

/** POST /api/xhs/pc/notes/comments 笔记评论（对应原版 note_comments） */
export const POST = handle(async (req) => {
  const user = await getCurrentUser(req);
  const payload = await readJson(req, NoteCommentsSchema);
  const cookies = await getOwnedPcAccountCookies(user.id, payload.account_id);
  const { XhsPcApiAdapter } = await import("@/lib/server/xhs/adapters/pc-api-adapter");
  const adapter = new XhsPcApiAdapter(cookies);
  const [success, message, rawPayload] = await adapter.getNoteComments(payload.note_url);
  if (!success) throw new ApiError(502, message || "XHS note comments failed");
  const items = normalizeCommentPayload(rawPayload);
  return NextResponse.json({ total: items.length, items });
});
