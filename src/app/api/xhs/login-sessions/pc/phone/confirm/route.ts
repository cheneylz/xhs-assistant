/**
 * PC 端手机验证码确认登录（对应原版 backend/app/api/login_sessions.py 的 _confirm_phone_login）
 */
import { getCurrentUser } from "@/lib/server/core/auth";
import { ApiError, notFound } from "@/lib/server/core/http-error";
import { handle, readJson } from "@/lib/server/core/route";
import { decryptText, encryptText } from "@/lib/server/core/security";
import { serializeAccount } from "@/lib/server/services/account-service";
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "../../../shared";
import { createAccountFromLogin, dumpTempState, loadTempState, syncCreatorAccountFromPcLogin } from "../../../shared";

const PhoneConfirmSchema = z.object({
  session_id: z.number().int(),
  phone: z.string().min(6).max(32),
  code: z.string().min(4).max(12),
  sync_creator: z.boolean().nullable().optional(),
});

/** POST /api/xhs/login-sessions/pc/phone/confirm 确认手机验证码并完成登录 */
export const POST = handle(async (req) => {
  const user = await getCurrentUser(req);
  const payload = await readJson(req, PhoneConfirmSchema);
  const session = await prisma.loginSession.findUnique({ where: { id: payload.session_id } });
  if (!session || session.userId !== user.id || session.subType !== "pc" || session.loginMethod !== "phone") {
    throw notFound("Login session not found");
  }
  const { XhsPcLoginAdapter } = await import("@/lib/server/xhs/adapters/pc-login-adapter");
  const creatorLoginModule = await import("@/lib/server/xhs/adapters/creator-login-adapter");
  const adapter = new XhsPcLoginAdapter();
  let result: Record<string, unknown>;
  let userInfo: Record<string, unknown>;
  try {
    const [cookies, storedSyncCreator] = loadTempState(decryptText(session.encryptedTempCookies ?? ""));
    result = await adapter.confirmPhoneLogin(payload.phone, payload.code, cookies as Record<string, string>);
    userInfo = await adapter.getUserInfo(result.cookies as Record<string, string>);
    const syncCreator = payload.sync_creator ?? storedSyncCreator;
    await prisma.loginSession.update({
      where: { id: session.id },
      data: {
        status: "confirmed",
        encryptedTempCookies: encryptText(dumpTempState(result.cookies as Record<string, unknown>, syncCreator)),
      },
    });
    const { account, action } = await createAccountFromLogin({
      userId: user.id,
      subType: "pc",
      userInfo,
      cookies: result.cookies as Record<string, unknown>,
    });
    let creatorAccountPayload: Record<string, unknown> | null = null;
    if (syncCreator) {
      creatorAccountPayload = await syncCreatorAccountFromPcLogin({
        userId: user.id,
        pcCookies: result.cookies as Record<string, unknown>,
        creatorAdapter: new creatorLoginModule.XhsCreatorLoginAdapter(),
      });
    }
    return NextResponse.json({
      session_id: session.id,
      status: "confirmed",
      account: serializeAccount(account as never, action),
      creator_account: creatorAccountPayload,
    });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, "Phone login failed");
  }
});
