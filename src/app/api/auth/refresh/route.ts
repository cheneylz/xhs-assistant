import { prisma } from "@/lib/server/core/db";
import { ApiError } from "@/lib/server/core/http-error";
import { handle, readJson } from "@/lib/server/core/route";
import { createAccessToken, decodeToken } from "@/lib/server/core/security";
import { NextResponse } from "next/server";
import { z } from "zod";

const RefreshRequestSchema = z.object({
  refresh_token: z.string().min(1),
});

/** POST /api/auth/refresh 刷新 access token */
export const POST = handle(async (req) => {
  const payload = await readJson(req, RefreshRequestSchema);
  const decoded = decodeToken(payload.refresh_token);
  if (decoded.token_type !== "refresh") {
    throw new ApiError(401, "Invalid refresh token");
  }
  const user = await prisma.user.findUnique({ where: { id: decoded.user_id as number } });
  if (!user) {
    throw new ApiError(401, "User not found");
  }
  return NextResponse.json({ access_token: createAccessToken(user.id), token_type: "bearer" });
});
