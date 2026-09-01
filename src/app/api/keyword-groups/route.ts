import { getCurrentUser } from "@/lib/server/core/auth";
import { prisma } from "@/lib/server/core/db";
import { ApiError } from "@/lib/server/core/http-error";
import { paginated } from "@/lib/server/core/paginate";
import { handle, readJson } from "@/lib/server/core/route";
import { formatDateTime, shanghaiNow } from "@/lib/server/core/time";
import { NextResponse } from "next/server";
import { z } from "zod";

const PLATFORMS = ["xhs", "douyin", "kuaishou", "weibo", "xianyu", "taobao"] as const;

const KeywordGroupCreateSchema = z.object({
  platform: z.enum(PLATFORMS).default("xhs"),
  name: z.string().min(1).max(128),
  keywords: z.array(z.string()).min(1).max(50),
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

/** GET /api/keyword-groups 关键词组列表（支持 platform 过滤，对应原版 list_keyword_groups） */
export const GET = handle(async (req, { searchParams }) => {
  const user = await getCurrentUser(req);
  const platform = searchParams.get("platform") ?? undefined;
  const page = Number.parseInt(searchParams.get("page") ?? "1", 10);
  const pageSize = Number.parseInt(searchParams.get("page_size") ?? "20", 10);
  const groups = await prisma.keywordGroup.findMany({
    where: { userId: user.id, ...(platform ? { platform } : {}) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  return NextResponse.json(paginated(groups.map(serializeGroup), page, pageSize));
});

/** POST /api/keyword-groups 创建关键词组（对应原版 create_keyword_group） */
export const POST = handle(async (req) => {
  const user = await getCurrentUser(req);
  const payload = await readJson(req, KeywordGroupCreateSchema);
  const group = await prisma.keywordGroup.create({
    data: {
      userId: user.id,
      platform: payload.platform,
      name: payload.name.trim(),
      keywords: normalizeKeywords(payload.keywords),
      createdAt: shanghaiNow(),
      updatedAt: shanghaiNow(),
    },
  });
  return NextResponse.json(serializeGroup(group), { status: 201 });
});
