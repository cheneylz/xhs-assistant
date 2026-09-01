/**
 * PC 端手机验证码发送（对应原版 backend/app/api/login_sessions.py 的 pc_phone_send_code）
 */
import { getCurrentUser } from "@/lib/server/core/auth";
import { ApiError } from "@/lib/server/core/http-error";
import { handle, readJson } from "@/lib/server/core/route";
import { encryptText } from "@/lib/server/core/security";
import { shanghaiNow } from "@/lib/server/core/time";
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "../../../shared";
import { dumpTempState, maskPhone } from "../../../shared";

const PhoneSendCodeSchema = z.object({
  phone: z.string().min(6).max(32),
  sync_creator: z.boolean().default(false),
});

/** POST /api/xhs/login-sessions/pc/phone/send-code 发送手机验证码 */
export const POST = handle(async (req) => {
  const user = await getCurrentUser(req);
  const payload = await readJson(req, PhoneSendCodeSchema);
  const { XhsPcLoginAdapter } = await import("@/lib/server/xhs/adapters/pc-login-adapter");
  const adapter = new XhsPcLoginAdapter();
  let result: Record<string, unknown>;
  try {
    result = await adapter.createPhoneSession(payload.phone);
  } catch {
    throw new ApiError(400, "Failed to send phone code");
  }
  const session = await prisma.loginSession.create({
    data: {
      userId: user.id,
      platform: "xhs",
      subType: "pc",
      loginMethod: "phone",
      phoneMask: maskPhone(payload.phone),
      status: "pending",
      encryptedTempCookies: encryptText(dumpTempState(result.cookies as Record<string, unknown>, payload.sync_creator)),
      createdAt: shanghaiNow(),
    },
  });
  return NextResponse.json({ session_id: session.id, status: session.status, message: String(result.message ?? "sent") });
});
