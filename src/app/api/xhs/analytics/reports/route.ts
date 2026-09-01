import { getCurrentUser } from "@/lib/server/core/auth";
import { handle, readJson } from "@/lib/server/core/route";
import { formatDateTime, shanghaiNow } from "@/lib/server/core/time";
import { NextResponse } from "next/server";
import { z } from "zod";
import { buildReportPayload, ownedReportNotes, writeReportFile } from "../shared";

/** 报告请求体（对应原版 AnalyticsReportRequest） */
const AnalyticsReportRequestSchema = z.object({
  note_ids: z.array(z.number().int()).default([]),
  format: z.literal("json").default("json"),
});

/** POST /api/xhs/analytics/reports 生成运营报告并落盘（对应原版 create_report） */
export const POST = handle(async (req) => {
  const user = await getCurrentUser(req);
  const payload = await readJson(req, AnalyticsReportRequestSchema);
  const notes = await ownedReportNotes(user.id, payload.note_ids);
  const generatedAt = shanghaiNow();
  const reportPayload = await buildReportPayload(user.id, notes, generatedAt);
  const { fileName, filePath } = writeReportFile(user.id, reportPayload);
  return NextResponse.json({
    report_type: "operations",
    generated_at: formatDateTime(generatedAt),
    note_count: notes.length,
    file_name: fileName,
    file_path: filePath,
    download_url: `/api/files/exports/${fileName}`,
    summary: reportPayload.summary,
  });
});
