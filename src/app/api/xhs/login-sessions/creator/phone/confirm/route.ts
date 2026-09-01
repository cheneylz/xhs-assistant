/**
 * Creator 端手机验证码确认登录（对应原版 backend/app/api/login_sessions.py 的 _confirm_phone_login）
 */
import { getCurrentUser } from "@/lib/server/core/auth";
import { ApiError, notFound } from "@/lib/server/core/http-error";
import { handle, readJson } from "@/lib/server/core/route";
import { decryptText, encryptText } from "@/lib/server/core/security";
import { serializeAccount } from "@/lib/server/services/account-service";
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "../../../shared";
import { createAccountFromLogin, dumpJson, loadTempState } from "../../../shared";

const PhoneConfirmSchema = z.object({
  session_id: z.number().int(),
  phone: z.string().min(6).max(32),
  code: z.string().min(4).max(12),
  sync_creator: z.boolean().nullable().optional(),
});

/** POST /api/xhs/login-sessions/creator/phone/confirm 确认手机验证码并完成登录 */
export const POST = handle(async (req) => {
  const user = await getCurrentUser(req);
  const payload = await readJson(req, PhoneConfirmSchema);
  const session = await prisma.loginSession.findUnique({ where: { id: payload.session_id } });
  if (!session || session.userId !== user.id || session.subType !== "creator" || session.loginMethod !== "phone") {
    throw notFound("Login session not found");
  }
  const { XhsCreatorLoginAdapter } = await import("@/lib/server/xhs/adapters/creator-login-adapter");
  const adapter = new XhsCreatorLoginAdapter();
  try {
    const [cookies] = loadTempState(decryptText(session.encryptedTempCookies ?? ""));
    const result = await adapter.confirmPhoneLogin(payload.phone, payload.code, cookies as Record<string, string>);
    const userInfo = await adapter.getUserInfo(result.cookies as Record<string, string>);
    await prisma.loginSession.update({
      where: { id: session.id },
      data: {
        status: "confirmed",
        encryptedTempCookies: encryptText(dumpJson(result.cookies as Record<string, unknown>)),
      },
    });
    const { account, action } = await createAccountFromLogin({
      userId: user.id,
      subType: "creator",
      userInfo,
      cookies: result.cookies as Record<string, unknown>,
    });
    return NextResponse.json({
      session_id: session.id,
      status: "confirmed",
      account: serializeAccount(account as never, action),
      creator_account: null,
    });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, "Phone login failed");
  }
});
