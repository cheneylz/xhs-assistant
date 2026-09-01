/**
 * XHS 数据分析路由共享工具（对应原版 backend/app/api/platforms/xhs/analytics.py 的纯函数）
 * 端点：overview / top-content / hot-topics / engagement / keyword-trends /
 * comment-insights / reports / benchmarks / benchmarks/{targetId}/create-drafts
 */
import { prisma } from "@/lib/server/core/db";
import { ApiError, notFound } from "@/lib/server/core/http-error";
import { storagePath } from "@/lib/server/core/config";
import { formatDateTime } from "@/lib/server/core/time";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import type { AiDraft, MonitoringTarget, Note, NoteComment } from "@prisma/client";

/** 指标键与原始字段候选（对应原版 METRIC_KEYS，顶层 / data / note 逐层兜底） */
const METRIC_KEYS: Record<string, string[]> = {
  likes: ["likes", "liked_count", "like_count"],
  collects: ["collects", "collected_count", "collect_count"],
  comments: ["comments", "comment_count"],
  shares: ["shares", "share_count"],
};

/** 笔记指标（对应原版 _note_metrics 返回值） */
export interface NoteMetrics {
  likes: number;
  collects: number;
  comments: number;
  shares: number;
  engagement: number;
}

/** 话题聚合项（对应原版 _topic_items 条目） */
export interface TopicItem {
  keyword: string;
  notes: number;
  engagement: number;
}

/** 判断是否为普通对象（排除 null / 数组） */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 将 Prisma Json 字段转为普通对象（非对象时返回空对象） */
export function rawObject(rawJson: unknown): Record<string, unknown> {
  return isRecord(rawJson) ? rawJson : {};
}

/** 任意值转整数（对应原版 _as_int，支持 "1.2w" 等带单位字符串） */
export function asInt(value: unknown): number {
  if (typeof value === "boolean" || value === null || value === undefined) return 0;
  if (typeof value === "number") return Number.isFinite(value) ? Math.trunc(value) : 0;
  if (typeof value === "string") {
    let cleaned = value.trim().toLowerCase().replace(/,/g, "");
    let multiplier = 1;
    if (cleaned.endsWith("w")) {
      multiplier = 10000;
      cleaned = cleaned.slice(0, -1);
    }
    const parsed = Number.parseFloat(cleaned);
    if (Number.isNaN(parsed)) return 0;
    return Math.trunc(parsed * multiplier);
  }
  return 0;
}

/** 从原始 JSON 中提取指标值（对应原版 _raw_value：顶层 / data / note 三处兜底） */
export function rawMetricValue(raw: Record<string, unknown>, keys: string[]): number {
  for (const key of keys) {
    if (key in raw) return asInt(raw[key]);
    const data = raw["data"];
    if (isRecord(data) && key in data) return asInt(data[key]);
    const note = raw["note"];
    if (isRecord(note) && key in note) return asInt(note[key]);
  }
  return 0;
}

/** 计算笔记指标（对应原版 _note_metrics） */
export function noteMetrics(note: { rawJson: unknown }): NoteMetrics {
  const raw = rawObject(note.rawJson);
  const likes = rawMetricValue(raw, METRIC_KEYS.likes);
  const collects = rawMetricValue(raw, METRIC_KEYS.collects);
  const comments = rawMetricValue(raw, METRIC_KEYS.comments);
  const shares = rawMetricValue(raw, METRIC_KEYS.shares);
  return { likes, collects, comments, shares, engagement: likes + collects + comments + shares };
}

/** 当前用户全部 XHS 笔记（按 created_at 倒序，对应原版 _owned_notes） */
export function ownedNotes(userId: number): Promise<Note[]> {
  return prisma.note.findMany({
    where: { userId, platform: "xhs" },
    orderBy: { createdAt: "desc" },
  });
}

/** 笔记检索全文串（对应原版 _note_haystack） */
function noteHaystack(note: Note): string {
  return [note.noteId, note.title, note.content, note.authorName, JSON.stringify(rawObject(note.rawJson))]
    .join("\n")
    .toLowerCase();
}

/** 笔记是否匹配关键词（对应原版 _note_matches_value） */
export function noteMatchesValue(note: Note, value: string): boolean {
  const needle = value.trim().toLowerCase();
  if (!needle) return false;
  return noteHaystack(note).includes(needle);
}

/** 序列化热门笔记（对应原版 _serialize_top_note） */
export function serializeTopNote(note: Note): Record<string, unknown> {
  return {
    id: note.id,
    note_id: note.noteId,
    title: note.title,
    author_name: note.authorName,
    created_at: formatDateTime(note.createdAt),
    ...noteMetrics(note),
  };
}

/** 序列化 AI 草稿（对应原版 _serialize_draft） */
export function serializeDraft(draft: AiDraft): Record<string, unknown> {
  return {
    id: draft.id,
    platform: draft.platform,
    title: draft.title,
    body: draft.body,
    source_note_id: draft.sourceNoteId,
    created_at: formatDateTime(draft.createdAt),
  };
}

/** 获取归属当前用户的 benchmark 目标（对应原版 _get_owned_benchmark_target） */
export async function getOwnedBenchmarkTarget(userId: number, targetId: number): Promise<MonitoringTarget> {
  const target = await prisma.monitoringTarget.findUnique({ where: { id: targetId } });
  if (!target || target.userId !== userId || target.platform !== "xhs") {
    throw notFound("Benchmark target not found");
  }
  if (target.targetType !== "account" && target.targetType !== "brand") {
    throw new ApiError(400, "Benchmark target must be account or brand");
  }
  return target;
}

/** 按 benchmark 目标值匹配笔记，并按互动量倒序（对应原版 _benchmark_matches） */
export function benchmarkMatches(notes: Note[], target: { value: string }): Note[] {
  const matched = notes.filter((note) => noteMatchesValue(note, target.value));
  return matched.sort((a, b) => noteMetrics(b).engagement - noteMetrics(a).engagement);
}

/** 从原始 JSON 提取话题关键词（对应原版 _raw_topics，字符串去 # 前缀） */
export function rawTopics(raw: Record<string, unknown>): string[] {
  const topics: string[] = [];
  for (const key of ["tags", "topics", "keywords"]) {
    const value = raw[key];
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (typeof item === "string" && item.trim()) {
        topics.push(item.trim().replace(/^#+/, ""));
      } else if (isRecord(item)) {
        const name = item["name"] ?? item["tag"] ?? item["keyword"];
        if (typeof name === "string" && name.trim()) {
          topics.push(name.trim().replace(/^#+/, ""));
        }
      }
    }
  }
  return topics;
}

/** 向话题映射中追加笔记（对应原版 defaultdict(set) 语义） */
function addTopicNote(map: Map<string, Set<number>>, keyword: string, noteId: number): void {
  let set = map.get(keyword);
  if (!set) {
    set = new Set();
    map.set(keyword, set);
  }
  set.add(noteId);
}

/** 话题聚合（用户标签 + 原始 JSON 中的 tags/topics/keywords，对应原版 _topic_items） */
export async function topicItems(userId: number, notes: Note[]): Promise<TopicItem[]> {
  const noteById = new Map(notes.map((note) => [note.id, note]));
  const topicNoteIds = new Map<string, Set<number>>();

  // 用户标签（note_tags 关联 Tag，须归属当前用户）
  const noteIds = notes.map((note) => note.id);
  const tagRows = await prisma.noteTags.findMany({
    where: { noteId: { in: noteIds.length > 0 ? noteIds : [-1] }, tag: { userId } },
    include: { tag: true },
  });
  for (const row of tagRows) {
    if (row.tag.name) addTopicNote(topicNoteIds, row.tag.name, row.noteId);
  }

  // 原始 JSON 中的话题
  for (const note of notes) {
    for (const topic of rawTopics(rawObject(note.rawJson))) {
      addTopicNote(topicNoteIds, topic, note.id);
    }
  }

  const items: TopicItem[] = [];
  for (const [keyword, ids] of topicNoteIds) {
    let engagement = 0;
    for (const noteId of ids) {
      const note = noteById.get(noteId);
      if (note) engagement += noteMetrics(note).engagement;
    }
    items.push({ keyword, notes: ids.size, engagement });
  }
  // 按 (notes, engagement, keyword) 全部倒序（对应原版 sorted(..., reverse=True)）
  return items.sort((a, b) => b.notes - a.notes || b.engagement - a.engagement || b.keyword.localeCompare(a.keyword));
}

/** 当前用户全部 XHS 笔记的评论（按点赞数倒序、id 升序，对应原版 _owned_comments） */
export function ownedComments(userId: number): Promise<NoteComment[]> {
  return prisma.noteComment.findMany({
    where: { note: { userId, platform: "xhs" } },
    orderBy: [{ likeCount: "desc" }, { id: "asc" }],
  });
}

/** 指定笔记集合的评论（对应原版 _comments_for_notes） */
export function commentsForNotes(userId: number, noteIds: Set<number>): Promise<NoteComment[]> {
  const ids = [...noteIds];
  if (ids.length === 0) return Promise.resolve([]);
  return prisma.noteComment.findMany({
    where: { note: { userId, platform: "xhs" }, noteId: { in: ids } },
    orderBy: [{ likeCount: "desc" }, { id: "asc" }],
  });
}

/** 评论洞察载荷（英文关键词，对应原版 _comment_insight_payload） */
export function commentInsightPayload(comments: NoteComment[]): Record<string, unknown> {
  const repeatedTerms = new Map<string, number>();
  for (const comment of comments) {
    const content = comment.content.toLowerCase();
    for (const term of ["price", "link", "suitable", "how", "where", "recommend", "commute"]) {
      if (content.includes(term)) repeatedTerms.set(term, (repeatedTerms.get(term) ?? 0) + 1);
    }
  }
  return {
    total_comments: comments.length,
    question_count: comments.filter((comment) => comment.content.includes("?") || comment.content.includes("？")).length,
    top_terms: [...repeatedTerms.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([term, count]) => ({ term, count })),
    top_comments: comments.slice(0, 10).map((comment) => ({
      id: comment.id,
      note_id: comment.noteId,
      user_name: comment.userName,
      content: comment.content,
      like_count: comment.likeCount,
    })),
  };
}

/** 报告笔记集合（对应原版 _owned_report_notes，指定 id 缺失时 404） */
export async function ownedReportNotes(userId: number, noteIds: number[]): Promise<Note[]> {
  if (noteIds.length === 0) return ownedNotes(userId);
  const uniqueIds = [...new Set(noteIds)];
  const notes = await prisma.note.findMany({
    where: { userId, platform: "xhs", id: { in: uniqueIds } },
  });
  const byId = new Map(notes.map((note) => [note.id, note]));
  if (byId.size !== uniqueIds.length) throw notFound("Report note not found");
  return uniqueIds.map((id) => byId.get(id)!);
}

/** Python round(x, 2) 语义：四舍六入五成双（对应原版 round(total / count, 2)） */
export function pythonRound(value: number, digits: number): number {
  const factor = 10 ** digits;
  const scaled = value * factor;
  const floored = Math.floor(scaled);
  const diff = scaled - floored;
  if (diff === 0.5) {
    return (floored % 2 === 0 ? floored : floored + 1) / factor;
  }
  return Math.round(scaled) / factor;
}

/** 报告中的 benchmark 条目（对应原版 _benchmark_report_items） */
export async function benchmarkReportItems(userId: number, notes: Note[]): Promise<Array<Record<string, unknown>>> {
  const targets = await prisma.monitoringTarget.findMany({
    where: { userId, platform: "xhs", targetType: { in: ["account", "brand"] } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });

  const items: Array<Record<string, unknown>> = [];
  for (const target of targets) {
    const matched = benchmarkMatches(notes, target);
    const totalEngagement = matched.reduce((sum, note) => sum + noteMetrics(note).engagement, 0);
    items.push({
      target_id: target.id,
      target_type: target.targetType,
      name: target.name || target.value,
      value: target.value,
      matched_notes: matched.length,
      total_engagement: totalEngagement,
      average_engagement: matched.length ? pythonRound(totalEngagement / matched.length, 2) : 0,
      top_notes: matched.slice(0, 5).map(serializeTopNote),
    });
  }
  // 按 (total_engagement, matched_notes, name) 全部倒序（对应原版 sorted(..., reverse=True)）
  return items.sort(
    (a, b) =>
      (b.total_engagement as number) - (a.total_engagement as number) ||
      (b.matched_notes as number) - (a.matched_notes as number) ||
      String(b.name).localeCompare(String(a.name)),
  );
}

/** 关键词趋势（关键词组优先，无组时退回话题聚合，对应原版 _keyword_trend_items） */
export async function keywordTrendItems(userId: number, notes: Note[]): Promise<Array<Record<string, unknown>>> {
  const groups = await prisma.keywordGroup.findMany({
    where: { userId, platform: "xhs" },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });

  if (groups.length > 0) {
    const items: Array<Record<string, unknown>> = [];
    for (const group of groups) {
      const keywords = Array.isArray(group.keywords) ? (group.keywords as unknown[]).map(String) : [];
      for (const keyword of keywords) {
        const keywordText = keyword.trim();
        if (!keywordText) continue;
        const matched = notes.filter((note) => noteMatchesValue(note, keywordText));
        const engagement = matched.reduce((sum, note) => sum + noteMetrics(note).engagement, 0);
        const topNotes = matched
          .sort((a, b) => noteMetrics(b).engagement - noteMetrics(a).engagement)
          .slice(0, 5)
          .map(serializeTopNote);
        items.push({
          keyword: keywordText,
          group_id: group.id,
          group_name: group.name,
          notes: matched.length,
          engagement,
          top_notes: topNotes,
        });
      }
    }
    return items;
  }

  return (await topicItems(userId, notes)).map((item) => ({
    keyword: item.keyword,
    group_id: null,
    group_name: "",
    notes: item.notes,
    engagement: item.engagement,
    top_notes: [],
  }));
}

/** 组装报告主体（对应原版 _build_report_payload） */
export async function buildReportPayload(userId: number, notes: Note[], generatedAt: Date): Promise<Record<string, unknown>> {
  const comments = await commentsForNotes(userId, new Set(notes.map((note) => note.id)));
  const topNotes = [...notes].sort((a, b) => noteMetrics(b).engagement - noteMetrics(a).engagement);
  const topics = await topicItems(userId, notes);
  const totalEngagement = notes.reduce((sum, note) => sum + noteMetrics(note).engagement, 0);
  const benchmarkItems = await benchmarkReportItems(userId, notes);
  return {
    metadata: {
      report_type: "operations",
      platform: "xhs",
      user_id: userId,
      generated_at: formatDateTime(generatedAt),
    },
    summary: {
      note_count: notes.length,
      total_engagement: totalEngagement,
      comment_count: comments.length,
      top_topics: topics.slice(0, 10),
      top_notes: topNotes.slice(0, 10).map(serializeTopNote),
      benchmark_count: benchmarkItems.length,
    },
    top_notes: topNotes.slice(0, 20).map(serializeTopNote),
    hot_topics: topics,
    comment_insights: commentInsightPayload(comments),
    benchmarks: benchmarkItems,
  };
}

/** 写入报告 JSON 文件（对应原版 _write_report_file，文件名 xhs-report-u{userId}-{hex}.json） */
export function writeReportFile(userId: number, payload: Record<string, unknown>): { fileName: string; filePath: string } {
  const exportDir = storagePath("exports");
  mkdirSync(exportDir, { recursive: true });
  const fileName = `xhs-report-u${userId}-${randomUUID().replace(/-/g, "")}.json`;
  const filePath = `${exportDir}/${fileName}`;
  writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf-8");
  return { fileName, filePath };
}
