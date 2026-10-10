import { getCurrentUser } from "@/lib/server/core/auth";
import { ApiError, notFound } from "@/lib/server/core/http-error";
import { paginated } from "@/lib/server/core/paginate";
import { handle } from "@/lib/server/core/route";
import { searchNotes } from "@/lib/server/services/note-service";
import { NextResponse } from "next/server";

/** 解析并校验分页参数（page>=1、page_size 1..max，对应原版 Query 校验） */
function parsePageParams(searchParams: URLSearchParams, defaultPageSize = 20, maxPageSize = 100) {
  const page = Number.parseInt(searchParams.get("page") ?? "1", 10);
  const pageSize = Number.parseInt(searchParams.get("page_size") ?? String(defaultPageSize), 10);
  if (Number.isNaN(page) || page < 1) throw new ApiError(422, "page must be >= 1");
  if (Number.isNaN(pageSize) || pageSize < 1 || pageSize > maxPageSize) {
    throw new ApiError(422, `page_size must be between 1 and ${maxPageSize}`);
  }
  return { page, pageSize };
}

/** 解析可选布尔查询参数（对应原版 Optional[bool] 校验） */
function parseOptionalBool(searchParams: URLSearchParams, key: string): boolean | undefined {
  const raw = searchParams.get(key);
  if (raw === null) return undefined;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  throw new ApiError(422, `${key} must be a boolean`);
}

/** 解析可选整数查询参数（对应原版 Query[int] 校验） */
function parseOptionalInt(searchParams: URLSearchParams, key: string): number | undefined {
  const raw = searchParams.get(key);
  if (raw === null) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) throw new ApiError(422, `${key} must be an integer`);
  return parsed;
}

/** GET /api/notes 笔记列表（分页 + 多条件过滤，对应原版 get_notes） */
export const GET = handle(async (req, { searchParams }) => {
  const user = await getCurrentUser(req);
  const { page, pageSize } = parsePageParams(searchParams);
  // 参数解析留在路由层（服务层不 import http-error，设计稿 §6.4 的边界）
  const platform = searchParams.get("platform") ?? undefined;
  const q = searchParams.get("q") ?? undefined;
  const hasAssets = parseOptionalBool(searchParams, "has_assets");
  const hasComments = parseOptionalBool(searchParams, "has_comments");
  const tagId = parseOptionalInt(searchParams, "tag_id");

  const result = await searchNotes(user.id, { platform, keyword: q, tagId, hasAssets, hasComments });
  // 标签不存在或不属于当前用户 → 404（对应原版；服务层只返回 outcome）
  if (result.outcome === "tag_not_found") throw notFound("Tag not found");
  return NextResponse.json(paginated(result.items, page, pageSize));
});
