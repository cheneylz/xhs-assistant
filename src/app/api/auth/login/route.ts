import { prisma } from "@/lib/server/core/db";
import { ApiError } from "@/lib/server/core/http-error";
import { handle, readJson } from "@/lib/server/core/route";
import { createAccessToken, createRefreshToken, verifyPassword } from "@/lib/server/core/security";
import { NextResponse } from "next/server";
import { z } from "zod";

const AuthCredentialsSchema = z.object({
  username: z.string().min(3).max(80),
  password: z.string().min(6).max(128),
});

/** POST /api/auth/login 登录 */
export const POST = handle(async (req) => {
  const credentials = await readJson(req, AuthCredentialsSchema);
  const username = credentials.username.trim();
  const user = await prisma.user.findUnique({ where: { username } });
  if (!user || !verifyPassword(credentials.password, user.passwordHash)) {
    throw new ApiError(401, "Invalid username or password");
  }
  return NextResponse.json({
    access_token: createAccessToken(user.id),
    refresh_token: createRefreshToken(user.id),
    token_type: "bearer",
    user: { id: user.id, username: user.username, role: user.role },
  });
});
