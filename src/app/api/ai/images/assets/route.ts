import { getCurrentUser } from "@/lib/server/core/auth";
import { prisma } from "@/lib/server/core/db";
import { paginated } from "@/lib/server/core/paginate";
import { handle } from "@/lib/server/core/route";
import { NextResponse } from "next/server";
import { serializeGeneratedAsset } from "../../shared";

/** GET /api/ai/images/assets 生成资产列表（分页，对应原版 generated_image_assets） */
export const GET = handle(async (req, { searchParams }) => {
  const user = await getCurrentUser(req);
  const page = Number.parseInt(searchParams.get("page") ?? "1", 10);
  const pageSize = Number.parseInt(searchParams.get("page_size") ?? "20", 10);
  const assets = await prisma.aiGeneratedAsset.findMany({
    where: { userId: user.id },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  return NextResponse.json(paginated(assets.map(serializeGeneratedAsset), page, pageSize));
});
