import { getCurrentUser } from "@/lib/server/core/auth";
import { prisma } from "@/lib/server/core/db";
import { ApiError, notFound } from "@/lib/server/core/http-error";
import { handle, readJson } from "@/lib/server/core/route";
import { NextResponse } from "next/server";
import { z } from "zod";

const TagUpdateSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  color: z.string().max(24).optional(),
});

/** 序列化标签（响应字段与原版 serialize_tag 一致） */
function serializeTag(tag: { id: number; name: string; color: string }) {
  return { id: tag.id, name: tag.name, color: tag.color };
}

/** 获取当前用户拥有的标签（对应原版 _get_owned_tag） */
async function getOwnedTag(userId: number, tagId: number) {
  const tag = await prisma.tag.findUnique({ where: { id: tagId } });
  if (!tag || tag.userId !== userId) {
    throw notFound("Tag not found");
  }
  return tag;
}

/** 校验同名标签唯一，排除自身（对应原版 _ensure_unique_name） */
async function ensureUniqueName(userId: number, name: string, excludeTagId?: number): Promise<void> {
  const existing = await prisma.tag.findFirst({ where: { userId, name } });
  if (existing && existing.id !== excludeTagId) {
    throw new ApiError(400, "Tag name already exists");
  }
}

/** PATCH /api/tags/{tagId} 更新标签（对应原版 update_tag） */
export const PATCH = handle(async (req, { params }) => {
  const user = await getCurrentUser(req);
  const tagId = Number.parseInt(params.tagId, 10);
  const tag = await getOwnedTag(user.id, tagId);
  const payload = await readJson(req, TagUpdateSchema);

  const data: Record<string, unknown> = {};
  if (payload.name !== undefined) {
    const name = payload.name.trim();
    if (!name) {
      throw new ApiError(422, "Tag name is required");
    }
    await ensureUniqueName(user.id, name, tag.id);
    data.name = name;
  }
  if (payload.color !== undefined) {
    data.color = payload.color || "#111111";
  }
  const updated = await prisma.tag.update({ where: { id: tag.id }, data });
  return NextResponse.json(serializeTag(updated));
});

/** DELETE /api/tags/{tagId} 删除标签（先清理关联的笔记标签关系，对应原版 delete_tag） */
export const DELETE = handle(async (req, { params }) => {
  const user = await getCurrentUser(req);
  const tagId = Number.parseInt(params.tagId, 10);
  await getOwnedTag(user.id, tagId);
  await prisma.noteTags.deleteMany({ where: { tagId } });
  await prisma.tag.delete({ where: { id: tagId } });
  return NextResponse.json({ id: tagId, status: "deleted" });
});
