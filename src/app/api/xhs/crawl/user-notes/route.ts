import { getCurrentUser } from "@/lib/server/core/auth";
import { ApiError } from "@/lib/server/core/http-error";
import { handle, readJson } from "@/lib/server/core/route";
import { dataItems, normalizeSearchItem } from "@/lib/server/services/crawl-normalizers";
import { serializeTask } from "@/lib/server/services/task-serializer";
import { NextResponse } from "next/server";
import { z } from "zod";
import { completeTask, createCrawlTask, failTask, getOwnedPcAccount, getPcCookies, saveNormalizedNotes, serializeNote } from "../shared";

const CrawlUserNotesSchema = z.object({
  account_id: z.number().int(),
  user_url: z.string().min(1),
  save_to_library: z.boolean().default(true),
});

/** POST /api/xhs/crawl/user-notes 用户笔记爬取（对应原版 crawl_user_notes） */
export const POST = handle(async (req) => {
  const user = await getCurrentUser(req);
  const payload = await readJson(req, CrawlUserNotesSchema);
  const account = await getOwnedPcAccount(user.id, payload.account_id);
  const cookies = await getPcCookies(account.id);
  const task = await createCrawlTask(user.id, "user_notes", {
    account_id: account.id,
    user_url: payload.user_url,
  });

  const { XhsPcApiAdapter } = await import("@/lib/server/xhs/adapters/pc-api-adapter");
  const adapter = new XhsPcApiAdapter(cookies);
  const [success, message, rawPayload] = await adapter.getUserNotes(payload.user_url);
  if (!success) {
    await failTask(task.id, message || "XHS user notes crawl failed");
    throw new ApiError(502, message || "XHS user notes crawl failed");
  }

  const normalizedItems = dataItems(rawPayload).map(normalizeSearchItem);
  const savedNotes = payload.save_to_library ? await saveNormalizedNotes(account, normalizedItems) : [];
  await completeTask(task.id, { result_count: normalizedItems.length, saved_count: savedNotes.length });
  const { prisma } = await import("@/lib/server/core/db");
  const completedTask = await prisma.task.findUnique({ where: { id: task.id } });
  return NextResponse.json({
    task: completedTask ? serializeTask(completedTask) : null,
    result_count: normalizedItems.length,
    saved_count: savedNotes.length,
    items: savedNotes.map(serializeNote),
    raw: rawPayload,
  });
});
