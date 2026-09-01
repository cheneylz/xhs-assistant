import { prisma } from "@/lib/server/core/db";
import { handle, readJson } from "@/lib/server/core/route";
import { ApiError } from "@/lib/server/core/http-error";
import { createAccessToken, createRefreshToken, hashPassword } from "@/lib/server/core/security";
import { shanghaiNow } from "@/lib/server/core/time";
import { NextResponse } from "next/server";
import { z } from "zod";

/** 注册请求体（对应原版 auth.AuthCredentials） */
const AuthCredentialsSchema = z.object({
  username: z.string().min(3).max(80),
  password: z.string().min(6).max(128),
});

/** 序列化用户（对应原版 _serialize_user，含角色 S-01） */
function serializeUser(user: { id: number; username: string; role: string }) {
  return { id: user.id, username: user.username, role: user.role };
}

/** 生成 token 响应（对应原版 _token_response） */
function tokenResponse(user: { id: number; username: string; role: string }) {
  return {
    access_token: createAccessToken(user.id),
    refresh_token: createRefreshToken(user.id),
    token_type: "bearer",
    user: serializeUser(user),
  };
}

/** POST /api/auth/register 注册 */
export const POST = handle(async (req) => {
  const credentials = await readJson(req, AuthCredentialsSchema);
  const username = credentials.username.trim();
  const existingUser = await prisma.user.findUnique({ where: { username } });
  if (existingUser) {
    throw new ApiError(400, "Username already exists");
  }
  // S-01 两级角色：首位注册用户为 admin，其余为 user
  const userCount = await prisma.user.count();
  const user = await prisma.user.create({
    data: {
      username,
      passwordHash: hashPassword(credentials.password),
      role: userCount === 0 ? "admin" : "user",
      createdAt: shanghaiNow(),
    },
  });
  return NextResponse.json(tokenResponse(user), { status: 201 });
});
