/**
 * Creator 端 QR 登录会话创建（对应原版 backend/app/api/login_sessions.py 的 creator_qrcode）
 */
import { getCurrentUser } from "@/lib/server/core/auth";
import { ApiError } from "@/lib/server/core/http-error";
import { handle } from "@/lib/server/core/route";
import { encryptText } from "@/lib/server/core/security";
import { shanghaiNow } from "@/lib/server/core/time";
import { NextResponse } from "next/server";
import QRCode from "qrcode";
import { prisma } from "../../shared";
import { dumpJson } from "../../shared";

/** POST /api/xhs/login-sessions/creator/qrcode 创建 Creator 端 QR 登录会话（无请求体） */
export const POST = handle(async (req) => {
  const user = await getCurrentUser(req);
  const { XhsCreatorLoginAdapter } = await import("@/lib/server/xhs/adapters/creator-login-adapter");
  const adapter = new XhsCreatorLoginAdapter();
  let payload: Record<string, unknown>;
  try {
    payload = await adapter.createQrcode();
  } catch (error) {
    throw new ApiError(502, `XHS Creator QR code generation failed: ${(error as Error).message}`);
  }
  const session = await prisma.loginSession.create({
    data: {
      userId: user.id,
      platform: "xhs",
      subType: "creator",
      status: "pending",
      qrId: String(payload.qr_id),
      qrUrl: String(payload.qr_url),
      encryptedTempCookies: encryptText(dumpJson(payload.cookies as Record<string, unknown>)),
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
