/**
 * PC 端 QR 登录会话创建（对应原版 backend/app/api/login_sessions.py 的 pc_qrcode）
 */
import { getCurrentUser } from "@/lib/server/core/auth";
import { ApiError, zodError } from "@/lib/server/core/http-error";
import { handle } from "@/lib/server/core/route";
import { encryptText } from "@/lib/server/core/security";
import { shanghaiNow } from "@/lib/server/core/time";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import QRCode from "qrcode";
import { z } from "zod";
import { prisma } from "../../shared";
import { dumpTempState } from "../../shared";

/** 请求体（对应原版 PcQrCodeRequest） */
const PcQrCodeSchema = z.object({
  sync_creator: z.boolean().default(false),
});

/** 解析可选请求体（对应原版 payload: PcQrCodeRequest | None = None，允许空 body） */
async function parseOptionalBody(req: NextRequest): Promise<{ sync_creator: boolean }> {
  const text = await req.text();
  if (!text.trim()) return { sync_creator: false };
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new ApiError(400, "Invalid JSON body");
  }
  const result = PcQrCodeSchema.safeParse(body);
  if (!result.success) throw zodError(result.error);
  return result.data;
}

/** POST /api/xhs/login-sessions/pc/qrcode 创建 PC 端 QR 登录会话 */
export const POST = handle(async (req) => {
  const user = await getCurrentUser(req);
  const payload = await parseOptionalBody(req);
  const { XhsPcLoginAdapter } = await import("@/lib/server/xhs/adapters/pc-login-adapter");
  const adapter = new XhsPcLoginAdapter();
  let qrPayload: Record<string, unknown>;
  try {
    qrPayload = await adapter.createQrcode();
  } catch (error) {
    throw new ApiError(502, `XHS PC QR code generation failed: ${(error as Error).message}`);
  }
  const session = await prisma.loginSession.create({
    data: {
      userId: user.id,
      platform: "xhs",
      subType: "pc",
      status: "pending",
      qrId: String(qrPayload.qr_id),
      code: String(qrPayload.code),
      qrUrl: String(qrPayload.qr_url),
      encryptedTempCookies: encryptText(dumpTempState(qrPayload.cookies as Record<string, unknown>, payload.sync_creator)),
      createdAt: shanghaiNow(),
    },
  });
  const qrImageDataUrl = session.qrUrl ? await QRCode.toDataURL(session.qrUrl) : "";
  return NextResponse.json({
    session_id: session.id,
    status: session.status,
    qr_url: session.qrUrl,
    qr_image_data_url: qrImageDataUrl,
  });
});
