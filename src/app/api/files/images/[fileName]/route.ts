import { getCurrentUser } from "@/lib/server/core/auth";
import { getConfig } from "@/lib/server/core/config";
import { notFound } from "@/lib/server/core/http-error";
import { handle } from "@/lib/server/core/route";
import { NextResponse } from "next/server";
import { existsSync, rmSync } from "node:fs";

/** DELETE /api/files/images/{file_name} 删除用户上传图片（对应原版 delete_user_image） */
export const DELETE = handle(async (req, { params }) => {
  const user = await getCurrentUser(req);
  const fileName = params.fileName;
  const prefix = `xhs-upload-u${user.id}-`;
  if (fileName.split("/").pop() !== fileName || fileName.includes("..") || !fileName.startsWith(prefix)) {
    throw notFound("Image not found");
  }
  const filePath = `${getConfig().storageDir}/media/${fileName}`;
  if (!existsSync(filePath)) throw notFound("Image not found");
  rmSync(filePath);
  return NextResponse.json({ file_name: fileName, status: "deleted" });
});
