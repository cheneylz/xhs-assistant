import { getCurrentUser } from "@/lib/server/core/auth";
import { prisma } from "@/lib/server/core/db";
import { notFound } from "@/lib/server/core/http-error";
import { paginated } from "@/lib/server/core/paginate";
import { handle, readJson } from "@/lib/server/core/route";
import { serializePublishAsset } from "@/lib/server/services/publish-serializers";
import { NextResponse } from "next/server";
import { z } from "zod";

const PublishAssetCreateSchema = z.object({
  asset_type: z.enum(["image", "video"]),
  file_path: z.string().min(1),
});

async function getOwnedJob(userId: number, jobId: number) {
  const job = await prisma.publishJob.findFirst({ where: { id: jobId, userId } });
  if (!job) throw notFound("Publish job not found");
  return job;
}

/** GET /api/publish/jobs/{jobId}/assets 素材列表（对应原版 get_publish_assets） */
export const GET = handle(async (req, { params, searchParams }) => {
  const user = await getCurrentUser(req);
  const job = await getOwnedJob(user.id, Number.parseInt(params.jobId, 10));
  const page = Number.parseInt(searchParams.get("page") ?? "1", 10);
  const pageSize = Number.parseInt(searchParams.get("page_size") ?? "20", 10);
  const assets = await prisma.publishAsset.findMany({
    where: { publishJobId: job.id },
    orderBy: { id: "asc" },
  });
  return NextResponse.json(paginated(assets.map(serializePublishAsset), page, pageSize));
});

/** POST /api/publish/jobs/{jobId}/assets 添加素材（对应原版 create_publish_asset） */
export const POST = handle(async (req, { params }) => {
  const user = await getCurrentUser(req);
  const job = await getOwnedJob(user.id, Number.parseInt(params.jobId, 10));
  const payload = await readJson(req, PublishAssetCreateSchema);
  const asset = await prisma.publishAsset.create({
    data: {
      publishJobId: job.id,
      assetType: payload.asset_type,
      filePath: payload.file_path,
    },
  });
  return NextResponse.json(serializePublishAsset(asset), { status: 201 });
});
