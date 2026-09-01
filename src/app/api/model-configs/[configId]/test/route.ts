import { getCurrentUser } from "@/lib/server/core/auth";
import { prisma } from "@/lib/server/core/db";
import { notFound } from "@/lib/server/core/http-error";
import { handle } from "@/lib/server/core/route";
import { decryptText } from "@/lib/server/core/security";
import { NextResponse } from "next/server";

/** POST /api/model-configs/{configId}/test 测试模型连通（对应原版 test_model_config） */
export const POST = handle(async (req, { params }) => {
  const user = await getCurrentUser(req);
  const configId = Number.parseInt(params.configId, 10);
  const config = await prisma.modelConfig.findUnique({ where: { id: configId } });
  if (!config || config.userId !== user.id) throw notFound("Model config not found");
  if (!config.encryptedApiKey) {
    return NextResponse.json({ id: config.id, status: "error", message: "未配置 API Key" });
  }
  if (!config.baseUrl) {
    return NextResponse.json({ id: config.id, status: "error", message: "未配置 Base URL" });
  }
  const apiKey = decryptText(config.encryptedApiKey);
  const baseUrl = config.baseUrl.replace(/\/+$/, "");
  try {
    const isImage = config.modelType === "image";
    const endpoint = isImage ? `${baseUrl}/images/generations` : `${baseUrl}/chat/completions`;
    const body = isImage
      ? { model: config.modelName, prompt: "test", n: 1, size: "256x256" }
      : { model: config.modelName, messages: [{ role: "user", content: "hi" }], max_tokens: 5 };
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const text = await response.text();
    if (response.status < 400) {
      try {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        if (parsed.choices || parsed.data || parsed.object) {
          return NextResponse.json({ id: config.id, status: "ok", message: `连接成功 (${response.status})` });
        }
        return NextResponse.json({ id: config.id, status: "error", message: `响应格式异常: ${text.slice(0, 150)}` });
      } catch {
        return NextResponse.json({ id: config.id, status: "error", message: `响应非 JSON: ${text.slice(0, 150)}` });
      }
    }
    return NextResponse.json({ id: config.id, status: "error", message: `HTTP ${response.status}: ${text.slice(0, 150)}` });
  } catch (error) {
    return NextResponse.json({ id: config.id, status: "error", message: String((error as Error).message).slice(0, 200) });
  }
});
