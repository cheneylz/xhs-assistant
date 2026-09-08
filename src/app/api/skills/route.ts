import { getCurrentUser } from "@/lib/server/core/auth";
import { handle, readJson } from "@/lib/server/core/route";
import { prisma } from "@/lib/server/core/db";
import { ApiError } from "@/lib/server/core/http-error";
import { createUserSkill, ensureUserSkills, serializeSkill } from "@/lib/server/services/workflow-service";
import { NextResponse } from "next/server";
import { z } from "zod";

const CreateSkillSchema = z.object({
  skill_key: z.string().min(1).max(64),
  name: z.string().min(1).max(64),
  description: z.string().max(500).default(""),
  instructions: z.string().max(20000).default(""),
});

/** GET /api/skills 技能库列表（首次访问自动写入预置技能种子） */
export const GET = handle(async (req) => {
  const user = await getCurrentUser(req);
  await ensureUserSkills(user.id);
  const skills = await prisma.skillRegistry.findMany({
    where: { userId: user.id },
    orderBy: { id: "asc" },
  });
  return NextResponse.json({ items: skills.map(serializeSkill) });
});

/** POST /api/skills 创建自定义技能（skillKey 用户级唯一） */
export const POST = handle(async (req) => {
  const user = await getCurrentUser(req);
  const payload = await readJson(req, CreateSkillSchema);
  try {
    const skill = await createUserSkill({
      userId: user.id,
      skillKey: payload.skill_key,
      name: payload.name,
      description: payload.description,
      instructions: payload.instructions,
    });
    return NextResponse.json(skill);
  } catch (error) {
    throw new ApiError(400, (error as Error).message);
  }
});
