import { getCurrentUser } from "@/lib/server/core/auth";
import { getConfig } from "@/lib/server/core/config";
import { notFound } from "@/lib/server/core/http-error";
import { handle } from "@/lib/server/core/route";
import { NextResponse } from "next/server";
import { existsSync, readFileSync } from "node:fs";

function exportMediaType(fileName: string): string {
  return fileName.endsWith(".csv") ? "text/csv; charset=utf-8" : "application/json";
}

/** GET /api/files/exports/{file_name} 导出文件下载（对应原版 download_export） */
export const GET = handle(async (req, { params }) => {
  const user = await getCurrentUser(req);
  const fileName = params.fileName;
  if (fileName.split("/").pop() !== fileName || fileName.includes("..")) {
    throw notFound("Export file not found");
  }
  const ownerPrefixes = [`xhs-notes-u${user.id}-`, `xhs-report-u${user.id}-`];
  if (!ownerPrefixes.some((prefix) => fileName.startsWith(prefix))) {
    throw notFound("Export file not found");
  }
  const filePath = `${getConfig().storageDir}/exports/${fileName}`;
  if (!existsSync(filePath)) throw notFound("Export file not found");
  const body = readFileSync(filePath);
  return new NextResponse(new Uint8Array(body), {
    headers: {
      "Content-Type": exportMediaType(fileName),
      "Content-Disposition": `attachment; filename="${fileName}"`,
      "Content-Length": String(body.length),
    },
  });
});
