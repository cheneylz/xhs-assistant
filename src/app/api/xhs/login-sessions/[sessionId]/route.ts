/**
 * 登录会话轮询（对应原版 backend/app/api/login_sessions.py 的 login_session）
 * URL 路径 /api/xhs/login-sessions/{sessionId}（前端 2s 轮询）
 */
import { getCurrentUser } from "@/lib/server/core/auth";
import { prisma } from "@/lib/server/core/db";
import { ApiError, notFound } from "@/lib/server/core/http-error";
import { handle } from "@/lib/server/core/route";
import { decryptText, encryptText } from "@/lib/server/core/security";
import { serializeAccount } from "@/lib/server/services/account-service";
import { NextResponse } from "next/server";
import { createAccountFromLogin, dumpTempState, loadTempState, syncCreatorAccountFromPcLogin } from "../shared";

/** GET /api/xhs/login-sessions/{sessionId} 查询登录会话状态 */
export const GET = handle(async (req, { params }) => {
  const user = await getCurrentUser(req);
  const sessionId = Number.parseInt(params.sessionId, 10);
  const session = await prisma.loginSession.findUnique({ where: { id: sessionId } });
  if (!session || session.userId !== user.id) throw notFound("Login session not found");

  // 已确认 / 已过期：直接返回
  if (session.status === "confirmed" || session.status === "expired") {
    return NextResponse.json({ session_id: session.id, status: session.status, qr_url: session.qrUrl });
  }

  // 校验会话类型与 QR 标识
  if ((session.subType !== "pc" && session.subType !== "creator") || !session.qrId) {
    throw new ApiError(400, "Unsupported login session");
  }
  if (session.subType === "pc" && !session.code) {
    throw new ApiError(400, "Unsupported login session");
  }

  const [cookies, syncCreator] = loadTempState(decryptText(session.encryptedTempCookies ?? ""));
  let result: { status: string; cookies: Record<string, unknown> };
  let userInfo: Record<string, unknown> | null = null;
  let accountSubType: string;
  let creatorAdapter: { exchangeFromUserCookies: (c: Record<string, unknown>) => Promise<Record<string, unknown>>; getUserInfo: (c: Record<string, unknown>) => Promise<Record<string, unknown>> } | null = null;

  if (session.subType === "pc") {
    const { XhsPcLoginAdapter } = await import("@/lib/server/xhs/adapters/pc-login-adapter");
    const { XhsCreatorLoginAdapter } = await import("@/lib/server/xhs/adapters/creator-login-adapter");
    const pcAdapter = new XhsPcLoginAdapter();
    result = await pcAdapter.checkQrcodeStatus(session.qrId, session.code!, cookies as Record<string, string>);
    accountSubType = "pc";
    if (result.status === "confirmed") {
      userInfo = await pcAdapter.getUserInfo(result.cookies as Record<string, string>);
      creatorAdapter = new XhsCreatorLoginAdapter();
    }
  } else {
    const { XhsCreatorLoginAdapter } = await import("@/lib/server/xhs/adapters/creator-login-adapter");
    const creatorAdapterInstance = new XhsCreatorLoginAdapter();
    result = await creatorAdapterInstance.checkQrcodeStatus(session.qrId, cookies);
    accountSubType = "creator";
    if (result.status === "confirmed") {
      userInfo = await creatorAdapterInstance.getUserInfo(result.cookies);
    }
  }

  await prisma.loginSession.update({
    where: { id: session.id },
    data: {
      status: result.status,
      encryptedTempCookies: encryptText(dumpTempState(result.cookies, syncCreator)),
    },
  });

  let accountPayload: Record<string, unknown> | null = null;
  let creatorAccountPayload: Record<string, unknown> | null = null;
  if (result.status === "confirmed" && userInfo) {
    const { account, action } = await createAccountFromLogin({
      userId: user.id,
      subType: accountSubType,
      userInfo,
      cookies: result.cookies,
    });
    accountPayload = serializeAccount(account as never, action);
    if (accountSubType === "pc" && syncCreator && creatorAdapter) {
      creatorAccountPayload = await syncCreatorAccountFromPcLogin({
        userId: user.id,
        pcCookies: result.cookies,
        creatorAdapter,
      });
    }
  }

  return NextResponse.json({
    session_id: session.id,
    status: result.status,
    qr_url: session.qrUrl,
    account: accountPayload,
    creator_account: creatorAccountPayload,
  });
});
