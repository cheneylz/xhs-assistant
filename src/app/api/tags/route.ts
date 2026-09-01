import { getCurrentUser } from "@/lib/server/core/auth";
import { prisma } from "@/lib/server/core/db";
import { ApiError } from "@/lib/server/core/http-error";
import { paginated } from "@/lib/server/core/paginate";
import { handle, readJson } from "@/lib/server/core/route";
import { NextResponse } from "next/server";
import { z } from "zod";

const TagCreateSchema = z.object({
  name: z.string().min(1).max(64),
  color: z.string().max(24).default("#111111"),
});

/** 序列化标签（响应字段与原版 serialize_tag 一致） */
function serializeTag(tag: { id: number; name: string; color: string }) {
  return { id: tag.id, name: tag.name, color: tag.color };
}

/** 去除首尾空白（对应原版 _normalize_name） */
function normalizeName(name: string): string {
  return name.trim();
}

/** 校验同名标签唯一（对应原版 _ensure_unique_name） */
async function ensureUniqueName(userId: number, name: string, excludeTagId?: number): Promise<void> {
  const existing = await prisma.tag.findFirst({ where: { userId, name } });
  if (existing && existing.id !== excludeTagId) {
    throw new ApiError(400, "Tag name already exists");
  }
}

/** GET /api/tags 标签列表（按 id 升序，对应原版 list_tags） */
export const GET = handle(async (req, { searchParams }) => {
  const user = await getCurrentUser(req);
  const page = Number.parseInt(searchParams.get("page") ?? "1", 10);
  const pageSize = Number.parseInt(searchParams.get("page_size") ?? "100", 10);
  const tags = await prisma.tag.findMany({
    where: { userId: user.id },
    orderBy: { id: "asc" },
  });
  return NextResponse.json(paginated(tags.map(serializeTag), page, pageSize));
});

/** POST /api/tags 创建标签（对应原版 create_tag） */
export const POST = handle(async (req) => {
  const user = await getCurrentUser(req);
  const payload = await readJson(req, TagCreateSchema);
  const name = normalizeName(payload.name);
  if (!name) {
    throw new ApiError(422, "Tag name is required");
  }
  await ensureUniqueName(user.id, name);
  const tag = await prisma.tag.create({
    data: { userId: user.id, name, color: payload.color || "#111111" },
  });
  return NextResponse.json(serializeTag(tag), { status: 201 });
});
