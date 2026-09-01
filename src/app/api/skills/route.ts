import { getCurrentUser } from "@/lib/server/core/auth";
import { handle } from "@/lib/server/core/route";
import { prisma } from "@/lib/server/core/db";
import { formatDateTime } from "@/lib/server/core/time";
import { ensureUserSkills } from "@/lib/server/services/workflow-service";
import { NextResponse } from "next/server";

/** GET /api/skills 技能库列表（首次访问自动写入预置技能种子） */
export const GET = handle(async (req) => {
  const user = await getCurrentUser(req);
  await ensureUserSkills(user.id);
  const skills = await prisma.skillRegistry.findMany({
    where: { userId: user.id },
    orderBy: { id: "asc" },
  });
  return NextResponse.json({
    items: skills.map((skill) => ({
      id: skill.id,
      skill_key: skill.skillKey,
      name: skill.name,
      description: skill.description,
      enabled: skill.enabled,
      created_at: formatDateTime(skill.createdAt),
    })),
  });
});
