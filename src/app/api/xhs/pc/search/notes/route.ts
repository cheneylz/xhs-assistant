import { getCurrentUser } from "@/lib/server/core/auth";
import { ApiError } from "@/lib/server/core/http-error";
import { handle, readJson } from "@/lib/server/core/route";
import { normalizeSearchItem } from "@/lib/server/services/crawl-normalizers";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getOwnedPcAccountCookies } from "../../shared";

const SearchNotesSchema = z.object({
  account_id: z.number().int(),
  keyword: z.string().min(1).max(120),
  page: z.number().int().min(1).default(1),
  sort_type_choice: z.number().int().min(0).max(4).default(0),
  note_type: z.number().int().min(0).max(2).default(0),
  note_time: z.number().int().min(0).max(3).default(0),
  note_range: z.number().int().min(0).max(3).default(0),
  pos_distance: z.number().int().min(0).max(2).default(0),
  geo: z.string().default(""),
});

/** POST /api/xhs/pc/search/notes 笔记搜索（对应原版 search_notes） */
export const POST = handle(async (req) => {
  const user = await getCurrentUser(req);
  const payload = await readJson(req, SearchNotesSchema);
  const cookies = await getOwnedPcAccountCookies(user.id, payload.account_id);
  const { XhsPcApiAdapter } = await import("@/lib/server/xhs/adapters/pc-api-adapter");
  const adapter = new XhsPcApiAdapter(cookies);
  const [success, message, rawPayload] = await adapter.searchNote(
    payload.keyword,
    payload.page,
    payload.sort_type_choice,
    payload.note_type,
    payload.note_time,
    payload.note_range,
    payload.pos_distance,
    payload.geo,
  );
  if (!success) throw new ApiError(502, message || "XHS note search failed");
  const data = ((rawPayload ?? {}) as Record<string, unknown>).data;
  const dataObj = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  const items = Array.isArray(dataObj.items) ? dataObj.items : [];
  const normalizedItems = items
    .filter(
      (item): item is Record<string, unknown> =>
        Boolean(item && typeof item === "object" && !Array.isArray(item)) &&
        !["rec_query", "hot_query"].includes(String((item as Record<string, unknown>).model_type)),
    )
    .map(normalizeSearchItem);
  return NextResponse.json({
    total: normalizedItems.length,
    page: payload.page,
    page_size: dataObj.page_size ?? 20,
    has_more: Boolean(dataObj.has_more ?? false),
    items: normalizedItems,
    raw: rawPayload,
  });
});
