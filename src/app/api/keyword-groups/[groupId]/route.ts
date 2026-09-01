import { getCurrentUser } from "@/lib/server/core/auth";
import { prisma } from "@/lib/server/core/db";
import { ApiError, notFound } from "@/lib/server/core/http-error";
import { handle, readJson } from "@/lib/server/core/route";
import { formatDateTime, shanghaiNow } from "@/lib/server/core/time";
import { NextResponse } from "next/server";
import { z } from "zod";
import type { KeywordGroup, Note } from "@prisma/client";

const KeywordGroupUpdateSchema = z.object({
  name: z.string().min(1).max(128).optional(),
  keywords: z.array(z.string()).min(1).max(50).optional(),
});

/** 序列化关键词组（响应字段与原版 _serialize_group 一致） */
function serializeGroup(group: {
  id: number;
  platform: string;
  name: string;
  keywords: unknown;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: group.id,
    platform: group.platform,
    name: group.name,
    keywords: Array.isArray(group.keywords) ? (group.keywords as string[]) : [],
    created_at: formatDateTime(group.createdAt),
    updated_at: formatDateTime(group.updatedAt),
  };
}

/** 关键词去空白、按小写去重（对应原版 _normalize_keywords） */
function normalizeKeywords(keywords: string[]): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const keyword of keywords) {
    const value = keyword.trim();
    const key = value.toLowerCase();
    if (value && !seen.has(key)) {
      normalized.push(value);
      seen.add(key);
    }
  }
  if (normalized.length === 0) {
    throw new ApiError(422, "At least one keyword is required");
  }
  return normalized;
}

/** 获取当前用户拥有的关键词组（对应原版 _get_owned_group） */
async function getOwnedGroup(userId: number, groupId: number) {
  const group = await prisma.keywordGroup.findUnique({ where: { id: groupId } });
  if (!group || group.userId !== userId) {
    throw notFound("Keyword group not found");
  }
  return group;
}

/** 将数值字段归一化为整数（对应原版 _as_int，支持 "1.2w" 等写法） */
function asInt(value: unknown): number {
  if (typeof value === "boolean" || value === null || value === undefined) return 0;
  if (typeof value === "number") return Math.trunc(value);
  if (typeof value === "string") {
    let cleaned = value.trim().toLowerCase().replace(/,/g, "");
    let multiplier = 1;
    if (cleaned.endsWith("w")) {
      multiplier = 10000;
      cleaned = cleaned.slice(0, -1);
    }
    const parsed = Number(cleaned);
    if (Number.isNaN(parsed)) return 0;
    return Math.trunc(parsed * multiplier);
  }
  return 0;
}

interface NoteMetrics {
  likes: number;
  collects: number;
  comments: number;
  shares: number;
  engagement: number;
}

/** 提取笔记互动指标（对应原版 _note_metrics，raw_json 与 interact_info 合并取值） */
function noteMetrics(note: Note): NoteMetrics {
  const raw = (note.rawJson ?? {}) as Record<string, unknown>;
  const interaction =
    typeof raw["interact_info"] === "object" && raw["interact_info"] !== null && !Array.isArray(raw["interact_info"])
      ? (raw["interact_info"] as Record<string, unknown>)
      : {};
  const merged = { ...raw, ...interaction };
  const likes = asInt(merged["likes"] || merged["liked_count"] || merged["like_count"]);
  const collects = asInt(merged["collects"] || merged["collected_count"] || merged["collect_count"]);
  const comments = asInt(merged["comments"] || merged["comment_count"]);
  const shares = asInt(merged["shares"] || merged["share_count"]);
  return { likes, collects, comments, shares, engagement: likes + collects + comments + shares };
}

/** 构建笔记全文检索文本（对应原版 _note_haystack） */
function noteHaystack(note: Note): string {
  const rawText = JSON.stringify(note.rawJson ?? {});
  return [note.noteId, note.title, note.content, note.authorName, rawText].join("\n").toLowerCase();
}

interface MatchedNote {
  id: number;
  note_id: string;
  title: string;
  author_name: string;
  created_at: string;
  likes: number;
  collects: number;
  comments: number;
  shares: number;
  engagement: number;
}

interface TrendSummary {
  total_matches: number;
  total_engagement: number;
  keywords: { keyword: string; notes: number; engagement: number }[];
  matched_notes: MatchedNote[];
}

/** 关键词趋势汇总（对应原版 _trend_summary，按互动量倒序取前 10 条匹配笔记） */
async function trendSummary(userId: number, group: KeywordGroup): Promise<TrendSummary> {
  const notes = await prisma.note.findMany({
    where: { userId, platform: group.platform },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  const keywordItems: { keyword: string; notes: number; engagement: number }[] = [];
  const matchedByNoteId = new Map<number, MatchedNote>();
  for (const keyword of Array.isArray(group.keywords) ? (group.keywords as string[]) : []) {
    const needle = keyword.toLowerCase();
    const matchedNotes = notes.filter((note) => noteHaystack(note).includes(needle));
    const engagement = matchedNotes.reduce((sum, note) => sum + noteMetrics(note).engagement, 0);
    keywordItems.push({ keyword, notes: matchedNotes.length, engagement });
    for (const note of matchedNotes) {
      matchedByNoteId.set(note.id, {
        id: note.id,
        note_id: note.noteId,
        title: note.title,
        author_name: note.authorName,
        created_at: formatDateTime(note.createdAt),
        ...noteMetrics(note),
      });
    }
  }
  const matchedNotes = [...matchedByNoteId.values()].sort((a, b) => b.engagement - a.engagement);
  return {
    total_matches: matchedNotes.length,
    total_engagement: matchedNotes.reduce((sum, item) => sum + item.engagement, 0),
    keywords: keywordItems,
    matched_notes: matchedNotes.slice(0, 10),
  };
}

/** GET /api/keyword-groups/{groupId} 关键词组详情（含 trend 汇总，对应原版 get_keyword_group） */
export const GET = handle(async (req, { params }) => {
  const user = await getCurrentUser(req);
  const groupId = Number.parseInt(params.groupId, 10);
  const group = await getOwnedGroup(user.id, groupId);
  const serialized = serializeGroup(group);
  const trend = await trendSummary(user.id, group);
  return NextResponse.json({ ...serialized, trend });
});

/** PATCH /api/keyword-groups/{groupId} 更新关键词组（对应原版 update_keyword_group） */
export const PATCH = handle(async (req, { params }) => {
  const user = await getCurrentUser(req);
  const groupId = Number.parseInt(params.groupId, 10);
  const group = await getOwnedGroup(user.id, groupId);
  const payload = await readJson(req, KeywordGroupUpdateSchema);

  const data: Record<string, unknown> = { updatedAt: shanghaiNow() };
  if (payload.name !== undefined) {
    data.name = payload.name.trim();
  }
  if (payload.keywords !== undefined) {
    data.keywords = normalizeKeywords(payload.keywords);
  }
  const updated = await prisma.keywordGroup.update({ where: { id: group.id }, data });
  return NextResponse.json(serializeGroup(updated));
});

/** DELETE /api/keyword-groups/{groupId} 删除关键词组（对应原版 delete_keyword_group） */
export const DELETE = handle(async (req, { params }) => {
  const user = await getCurrentUser(req);
  const groupId = Number.parseInt(params.groupId, 10);
  await getOwnedGroup(user.id, groupId);
  await prisma.keywordGroup.delete({ where: { id: groupId } });
  return NextResponse.json({ id: groupId, status: "deleted" });
});
