import { getCurrentUser } from "@/lib/server/core/auth";
import { notFound } from "@/lib/server/core/http-error";
import { handle, readJson } from "@/lib/server/core/route";
import { deleteUserSkill, updateUserSkill } from "@/lib/server/services/workflow-service";
import { NextResponse } from "next/server";
import { z } from "zod";

const UpdateSkillSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  description: z.string().max(500).optional(),
  instructions: z.string().max(20000).optional(),
  enabled: z.boolean().optional(),
});

/** PATCH /api/skills/{skillId} 更新技能（名称/描述/指令正文/启停，仅限本人） */
export const PATCH = handle(async (req, { params }) => {
  const user = await getCurrentUser(req);
  const skillId = Number.parseInt(params.skillId, 10);
  if (Number.isNaN(skillId)) throw notFound("Skill not found");
  const payload = await readJson(req, UpdateSkillSchema);
  try {
    const skill = await updateUserSkill(user.id, skillId, payload);
    return NextResponse.json(skill);
  } catch (error) {
    throw notFound((error as Error).message);
  }
});

/** DELETE /api/skills/{skillId} 删除技能（仅限本人） */
export const DELETE = handle(async (req, { params }) => {
  const user = await getCurrentUser(req);
  const skillId = Number.parseInt(params.skillId, 10);
  if (Number.isNaN(skillId)) throw notFound("Skill not found");
  try {
    await deleteUserSkill(user.id, skillId);
  } catch (error) {
    throw notFound((error as Error).message);
  }
  return NextResponse.json({ id: skillId, status: "deleted" });
});
