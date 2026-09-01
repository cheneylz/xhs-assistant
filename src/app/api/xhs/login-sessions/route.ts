/**
 * 登录会话路由集合（对应原版 backend/app/api/login_sessions.py，原版前缀为 /xhs/login-sessions，
 * 本路由统一收敛为 /api/login-sessions）
 *
 * 各子路径端点分布：
 *  - /api/login-sessions/pc/qrcode                 POST  PC 端 QR 登录会话创建
 *  - /api/login-sessions/creator/qrcode            POST  Creator 端 QR 登录会话创建
 *  - /api/login-sessions/{sessionId}               GET   轮询登录会话状态
 *  - /api/login-sessions/pc/phone/send-code        POST  手机验证码发送
 *  - /api/login-sessions/pc/phone/confirm          POST  手机验证码确认
 *  - /api/login-sessions/creator/phone/send-code   POST  手机验证码发送
 *  - /api/login-sessions/creator/phone/confirm     POST  手机验证码确认
 */
import { handle } from "@/lib/server/core/route";
import { NextResponse } from "next/server";

/** 集合路径本身在原版中无端点，所有请求返回 405（与 FastAPI 行为一致） */
export const GET = handle(async () => {
  return NextResponse.json({ detail: "Method Not Allowed" }, { status: 405 });
});
