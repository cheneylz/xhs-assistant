import { getCurrentUser } from "@/lib/server/core/auth";
import { prisma } from "@/lib/server/core/db";
import { ApiError, notFound } from "@/lib/server/core/http-error";
import { paginated } from "@/lib/server/core/paginate";
import { handle, readJson } from "@/lib/server/core/route";
import { formatDateTime, shanghaiNow } from "@/lib/server/core/time";
import type { AiDraft, Note, Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import { z } from "zod";

/** 创建草稿请求体（对应原版 DraftCreateRequest） */
const DraftCreateSchema = z.object({
  platform: z.enum(["xhs"]),
  source_note_id: z.number().int().nullable().optional(),
  title: z.string().default(""),
  body: z.string().default(""),
  intent: z.string().max(32).default("publish"),
});

/** 序列化草稿（含 tags，对应原版 _serialize_draft） */
function serializeDraft(draft: AiDraft) {
  return {
    id: draft.id,
    platform: draft.platform,
    title: draft.title,
    body: draft.body,
    tags: draft.tags ?? [],
    source_note_id: draft.sourceNoteId,
    created_at: formatDateTime(draft.createdAt),
  };
}

/** 获取当前用户拥有的源笔记（对应原版 _get_owned_source_note） */
async function getOwnedSourceNote(userId: number, noteId: number) {
  const note = await prisma.note.findUnique({ where: { id: noteId } });
  if (!note || note.userId !== userId) throw notFound("Source note not found");
  return note;
}

/** 从源笔记 raw_json 中提取标签（对应原版标签提取逻辑） */
function extractSourceNoteTags(rawJson: Prisma.JsonValue | null): Array<{ id?: string; name: string }> | null {
  const raw = rawJson && typeof rawJson === "object" && !Array.isArray(rawJson)
    ? (rawJson as Record<string, unknown>)
    : {};
  // 兼容 tags / tag_list / data.items[0].note_card.tag_list 多层结构（对应原版）
  let tagList: unknown = raw.tags || raw.tag_list;
  if (!tagList) {
    const data = raw.data;
    if (data && typeof data === "object" && !Array.isArray(data)) {
      const items = (data as Record<string, unknown>).items ?? [];
      if (Array.isArray(items) && items.length && typeof items[0] === "object" && items[0] !== null) {
        const card = (items[0] as Record<string, unknown>).note_card;
        if (card && typeof card === "object" && !Array.isArray(card)) {
          tagList = (card as Record<string, unknown>).tag_list;
        }
      }
    }
  }
  if (!Array.isArray(tagList)) return null;
  const tags: Array<{ id?: string; name: string }> = [];
  for (const tag of tagList) {
    if (typeof tag === "string") {
      tags.push({ name: tag });
    } else if (tag && typeof tag === "object" && !Array.isArray(tag)) {
      const name = (tag as Record<string, unknown>).name;
      if (name) {
        tags.push({ id: String((tag as Record<string, unknown>).id ?? ""), name: String(name) });
      }
    }
  }
  return tags;
}

/** 解析并校验分页参数（page>=1、page_size 1..100，对应原版 Query 校验） */
function parsePageParams(searchParams: URLSearchParams, defaultPageSize = 20, maxPageSize = 100) {
  const page = Number.parseInt(searchParams.get("page") ?? "1", 10);
  const pageSize = Number.parseInt(searchParams.get("page_size") ?? String(defaultPageSize), 10);
  if (Number.isNaN(page) || page < 1) throw new ApiError(422, "page must be >= 1");
  if (Number.isNaN(pageSize) || pageSize < 1 || pageSize > maxPageSize) {
    throw new ApiError(422, `page_size must be between 1 and ${maxPageSize}`);
  }
  return { page, pageSize };
}

/** GET /api/drafts 草稿列表（分页，对应原版 get_drafts） */
export const GET = handle(async (req, { searchParams }) => {
  const user = await getCurrentUser(req);
  const { page, pageSize } = parsePageParams(searchParams);
  const platform = searchParams.get("platform") ?? undefined;
  const drafts = await prisma.aiDraft.findMany({
    where: { userId: user.id, ...(platform ? { platform } : {}) },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json(paginated(drafts.map(serializeDraft), page, pageSize));
});

/** POST /api/drafts 创建草稿（可选关联源笔记并复制素材，对应原版 create_draft） */
export const POST = handle(async (req) => {
  const user = await getCurrentUser(req);
  const payload = await readJson(req, DraftCreateSchema);

  // 校验源笔记归属（对应原版）
  let sourceNote: Note | null = null;
  if (payload.source_note_id !== null && payload.source_note_id !== undefined) {
    sourceNote = await getOwnedSourceNote(user.id, payload.source_note_id);
  }
  // 从源笔记 raw_json 提取标签（对应原版）
  const tags = sourceNote ? extractSourceNoteTags(sourceNote.rawJson) : null;

  const draft = await prisma.aiDraft.create({
    data: {
      userId: user.id,
      platform: payload.platform,
      title: payload.title || (sourceNote ? sourceNote.title : ""),
      body: payload.body || (sourceNote ? sourceNote.content : ""),
      // 无标签时存 SQL NULL（对应原版 tags=None，运行时 null 即 SQL NULL）
      tags: (tags ?? null) as unknown as Prisma.InputJsonValue,
      sourceNoteId: sourceNote ? sourceNote.id : null,
      createdAt: shanghaiNow(),
    },
  });

  // 复制源笔记素材为草稿素材（对应原版）
  if (sourceNote) {
    const sourceAssets = await prisma.noteAsset.findMany({
      where: { noteId: sourceNote.id },
      orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
    });
    let index = 0;
    for (const asset of sourceAssets) {
      await prisma.draftAsset.create({
        data: {
          draftId: draft.id,
          assetType: asset.assetType,
          url: asset.url,
          localPath: asset.localPath,
          sortOrder: index,
        },
      });
      index++;
    }
  }

  return NextResponse.json(serializeDraft(draft));
});
