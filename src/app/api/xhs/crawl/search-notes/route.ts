import { getCurrentUser } from "@/lib/server/core/auth";
import { ApiError } from "@/lib/server/core/http-error";
import { handle, readJson } from "@/lib/server/core/route";
import { dataItems, normalizeSearchItem } from "@/lib/server/services/crawl-normalizers";
import { serializeTask } from "@/lib/server/services/task-serializer";
import { NextResponse } from "next/server";
import { z } from "zod";
import { completeTask, createCrawlTask, failTask, getOwnedPcAccount, getPcCookies, saveNormalizedNotes, serializeNote } from "../shared";

const CrawlSearchNotesSchema = z.object({
  account_id: z.number().int(),
  keyword: z.string().min(1).max(120),
  page: z.number().int().min(1).default(1),
  save_to_library: z.boolean().default(true),
  fetch_comments: z.boolean().default(false),
});

/** POST /api/xhs/crawl/search-notes 关键词爬取（对应原版 crawl_search_notes） */
export const POST = handle(async (req) => {
  const user = await getCurrentUser(req);
  const payload = await readJson(req, CrawlSearchNotesSchema);
  const account = await getOwnedPcAccount(user.id, payload.account_id);
  const cookies = await getPcCookies(account.id);
  const task = await createCrawlTask(user.id, "search_notes", {
    account_id: account.id,
    keyword: payload.keyword,
    page: payload.page,
  });

  const { XhsPcApiAdapter } = await import("@/lib/server/xhs/adapters/pc-api-adapter");
  const adapter = new XhsPcApiAdapter(cookies);
  const [success, message, rawPayload] = await adapter.searchNote(payload.keyword, payload.page);
  if (!success) {
    await failTask(task.id, message || "XHS search crawl failed");
    throw new ApiError(502, message || "XHS search crawl failed");
  }

  const normalizedItems = dataItems(rawPayload).map(normalizeSearchItem);
  const savedNotes = payload.save_to_library ? await saveNormalizedNotes(account, normalizedItems) : [];
  await completeTask(task.id, { result_count: normalizedItems.length, saved_count: savedNotes.length });
  const completedTask = await prismaTask(task.id);
  return NextResponse.json({
    task: serializeTask(completedTask),
    result_count: normalizedItems.length,
    saved_count: savedNotes.length,
    items: savedNotes.map(serializeNote),
    raw: rawPayload,
  });
});

import { prisma } from "@/lib/server/core/db";
async function prismaTask(taskId: number) {
  const task = await prisma.task.findUnique({ where: { id: taskId } });
  if (!task) throw new Error("Task not found");
  return task;
}
