import { getCurrentUser } from "@/lib/server/core/auth";
import { prisma } from "@/lib/server/core/db";
import { notFound } from "@/lib/server/core/http-error";
import { handle } from "@/lib/server/core/route";
import { NextResponse } from "next/server";

/** POST /api/model-configs/{configId}/set-default 设为默认（对应原版 set_default_model_config） */
export const POST = handle(async (req, { params }) => {
  const user = await getCurrentUser(req);
  const configId = Number.parseInt(params.configId, 10);
  const config = await prisma.modelConfig.findUnique({ where: { id: configId } });
  if (!config || config.userId !== user.id) throw notFound("Model config not found");

  const siblings = await prisma.modelConfig.findMany({ where: { userId: user.id, modelType: config.modelType, isDefault: true } });
  for (const sibling of siblings) {
    if (sibling.id !== config.id) {
      await prisma.modelConfig.update({ where: { id: sibling.id }, data: { isDefault: false } });
    }
  }
  const updated = await prisma.modelConfig.update({ where: { id: config.id }, data: { isDefault: true } });
  return NextResponse.json({
    id: updated.id,
    name: updated.name,
    model_type: updated.modelType,
    provider: updated.provider,
    model_name: updated.modelName,
    base_url: updated.baseUrl,
    has_api_key: Boolean(updated.encryptedApiKey),
    is_default: updated.isDefault,
  });
});
