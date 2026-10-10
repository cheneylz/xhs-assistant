/**
 * Agent P1-C 新工具端到端验收脚本（真模型，需 worker）
 *
 * 用法（两个终端）：
 *   终端 A：npx tsx src/worker/index.mts          （必须用最新代码重启）
 *   终端 B：npx tsx src/scripts/agent-c-tools-smoke.ts
 *
 * 与另外两个脚本的分工：
 *   - agent-smoke.ts（P0）：验「循环能不能跑」；agent-api-smoke.ts（P1-A）：验接口契约；
 *   - 本脚本：验 C 块 7 个新工具里**风险最高的 2 个**能被真实模型调用、行落库、产出真的变了
 *     （设计稿 §7.1：其余 5 个由离线单测覆盖 schema / 摘要 / 参数映射）。
 *     选中的两条路径：library_search_notes（唯一先做抽取重构的读工具）、
 *     content_rewrite（唯一 write 工具，直接覆盖用户草稿）。
 *
 * 验收项（任一不通过即 exit 1）：
 *   1. 内容库检索：模型调用 library_search_notes → 行 succeeded、摘要非空、items 命中种子笔记
 *   2. 去 AI 味改写：模型调用 content_rewrite → 行 succeeded、draft_id 正确、草稿正文真的被改写、
 *      run 里落了 kind=draft 的工件事件、改写前的助手文本说明了要改哪篇草稿
 *
 * 脚本自己造数据、自己清理（finally 兜底）。
 */
import { prisma } from "../lib/server/core/db";
import { shanghaiNow } from "../lib/server/core/time";
import { appendMessage, createConversation, createRunForMessage } from "../lib/server/services/agent-service";

/** 断言：不通过就抛错 —— 验收脚本必须能失败（asserts condition 与 P1-A 脚本同口径，供 TS 收窄） */
function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`验收未通过：${message}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 轮询等待 Run 进入终态（与 P0 脚本同口径） */
async function waitForRun(runId: number, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await prisma.agentRun.findUnique({ where: { id: runId } });
    if (run && ["succeeded", "failed", "cancelled"].includes(run.status)) return run.status;
    await sleep(2000);
  }
  return "timeout";
}

interface OneRun {
  conversationId: number;
  runId: number;
  taskId: number;
  status: string;
}

/** 发一条消息并等 Run 跑完 */
async function runOnce(options: { userId: number; title: string; prompt: string; timeoutMs: number }): Promise<OneRun> {
  const conversation = await createConversation(options.userId, options.title);
  const message = await appendMessage({ conversationId: conversation.id, role: "user", content: options.prompt });
  const run = await createRunForMessage({
    conversationId: conversation.id,
    userId: options.userId,
    messageId: message.id,
  });
  console.log(`  会话 ${conversation.id} / Run ${run.id}：${options.prompt}`);
  const status = await waitForRun(run.id, options.timeoutMs);
  return { conversationId: conversation.id, runId: run.id, taskId: run.taskId, status };
}

/** 清掉一次 Run 相关的全部行（含会话与消息） */
async function cleanupRun(item: OneRun): Promise<void> {
  await prisma.agentEvent.deleteMany({ where: { runId: item.runId } });
  await prisma.agentToolCall.deleteMany({ where: { runId: item.runId } });
  await prisma.agentRun.delete({ where: { id: item.runId } }).catch(() => undefined);
  await prisma.task.delete({ where: { id: item.taskId } }).catch(() => undefined);
  await prisma.agentMessage.deleteMany({ where: { conversationId: item.conversationId } });
  await prisma.agentConversation.delete({ where: { id: item.conversationId } }).catch(() => undefined);
}

async function main(): Promise<void> {
  const modelConfig = await prisma.modelConfig.findFirst({
    where: { modelType: "text", isDefault: true, encryptedApiKey: { not: "" } },
    orderBy: { id: "asc" },
  });
  if (!modelConfig) throw new Error("数据库里没有默认文本模型，先在界面上配一个");
  const user = await prisma.user.findUnique({ where: { id: modelConfig.userId } });
  if (!user) throw new Error(`默认文本模型 ${modelConfig.id} 挂在已不存在的用户上`);
  console.log(`目标用户 ${user.id}（${user.username}），模型 ${modelConfig.modelName}`);

  const finished: OneRun[] = [];
  const seededNoteIds: number[] = [];
  let seededDraftId: number | null = null;

  try {
    // 种子：关键词带时间戳，避免与库里的真实笔记撞车
    const keyword = `P1C冒烟${Date.now()}`;
    for (const suffix of ["甲", "乙"]) {
      const note = await prisma.note.create({
        data: {
          userId: user.id,
          platformAccountId: 0,
          platform: "xhs",
          noteId: `${keyword}_${suffix}`,
          title: `${keyword}${suffix} 露营装备怎么选`,
          content: "这是 C 块验收脚本写入的种子笔记，用于验证内容库检索与详情读取链路。",
          authorName: "C块验收种子",
          createdAt: shanghaiNow(),
        },
      });
      seededNoteIds.push(note.id);
    }
    const draftBody =
      "综上所述，随着生活水平的不断提高，露营已成为一种备受青睐的户外休闲方式。首先，我们需要准备帐篷；其次，我们需要准备睡袋。";
    const draft = await prisma.aiDraft.create({
      data: { userId: user.id, platform: "xhs", title: `${keyword} 改写用草稿`, body: draftBody, createdAt: shanghaiNow() },
    });
    seededDraftId = draft.id;
    console.log(`种子：笔记 ${seededNoteIds.join("、")}，草稿 ${draft.id}`);

    // ========== 1) library_search_notes ==========
    const first = await runOnce({
      userId: user.id,
      title: "C 块验收：内容库检索",
      prompt: `请用 library_search_notes 工具检索关键词「${keyword}」，告诉我一共找到几篇笔记。`,
      timeoutMs: 5 * 60 * 1000,
    });
    finished.push(first);
    assert(first.status === "succeeded", `检索 Run 应为 succeeded，实际 ${first.status}`);
    const rows1 = await prisma.agentToolCall.findMany({ where: { runId: first.runId }, orderBy: { stepIndex: "asc" } });
    console.log(`  工具调用：${rows1.map((row) => `${row.stepIndex}:${row.toolName}:${row.status}`).join(", ") || "（无）"}`);
    const searchRow = rows1.find((row) => row.toolName === "library_search_notes");
    assert(searchRow !== undefined, `模型没有调用 library_search_notes（实际：${rows1.map((row) => row.toolName).join(",") || "无"}）`);
    assert(searchRow.status === "succeeded", `library_search_notes 应为 succeeded，实际 ${searchRow.status}`);
    assert((searchRow.summary ?? "").length > 0, "library_search_notes 的摘要为空（工具卡会显示空白）");
    const searchResult = (searchRow.result ?? {}) as { items?: Array<{ id?: number }> };
    const itemIds = (searchResult.items ?? []).map((item) => Number(item.id));
    assert(
      seededNoteIds.every((id) => itemIds.includes(id)),
      `检索结果应包含两篇种子笔记 ${seededNoteIds.join("、")}，实际 ${itemIds.join("、") || "（空）"}`,
    );
    console.log(`【1/2】内容库检索 通过：摘要「${searchRow.summary}」，items 命中 ${seededNoteIds.length} 篇种子笔记`);

    // ========== 2) content_rewrite ==========
    const second = await runOnce({
      userId: user.id,
      title: "C 块验收：去 AI 味改写",
      prompt: `请对草稿 #${draft.id} 做「去 AI 味」改写（强度 medium），改写前先说明你要修改哪篇草稿。`,
      timeoutMs: 5 * 60 * 1000,
    });
    finished.push(second);
    assert(second.status === "succeeded", `改写 Run 应为 succeeded，实际 ${second.status}`);
    const rows2 = await prisma.agentToolCall.findMany({ where: { runId: second.runId }, orderBy: { stepIndex: "asc" } });
    console.log(`  工具调用：${rows2.map((row) => `${row.stepIndex}:${row.toolName}:${row.status}`).join(", ") || "（无）"}`);
    const rewriteRow = rows2.find((row) => row.toolName === "content_rewrite");
    assert(rewriteRow !== undefined, `模型没有调用 content_rewrite（实际：${rows2.map((row) => row.toolName).join(",") || "无"}）`);
    assert(rewriteRow.status === "succeeded", `content_rewrite 应为 succeeded，实际 ${rewriteRow.status}`);
    assert(
      Number((rewriteRow.params as { draft_id?: number })?.draft_id) === draft.id,
      `content_rewrite 的 draft_id 应为 ${draft.id}，实际 ${JSON.stringify(rewriteRow.params)}`,
    );
    assert((rewriteRow.summary ?? "").includes("已改写草稿"), `摘要应形如「已改写草稿 …」，实际「${rewriteRow.summary}」`);

    const rewritten = await prisma.aiDraft.findUnique({ where: { id: draft.id } });
    assert(rewritten !== null, `草稿 ${draft.id} 不见了`);
    assert(rewritten.body !== draftBody, "草稿正文没有被改写（与改写前完全相同）");
    assert(rewritten.body.trim().length > 0, "改写后的草稿正文为空");
    assert(
      rewritten.title === draft.title && rewritten.userId === user.id,
      "改写不应改动草稿标题或归属",
    );

    // 工件事件：改写产出必须进工件面板（kind=draft、id=草稿 id）
    const artifactEvents = await prisma.agentEvent.findMany({ where: { runId: second.runId, type: "artifact" } });
    const draftArtifact = artifactEvents.find((event) => {
      const payload = event.payload as { kind?: string; id?: number };
      return payload.kind === "draft" && Number(payload.id) === draft.id;
    });
    assert(draftArtifact !== undefined, `没有 kind=draft、id=${draft.id} 的工件事件（右栏不会出现工件卡）`);

    // 护栏：agent.md 要求改写前说明将修改哪篇（设计稿 §八 风险 5）
    const messageEnds = await prisma.agentEvent.findMany({
      where: { runId: second.runId, type: "message_end" },
      orderBy: { id: "asc" },
    });
    const announced = messageEnds.some((event) => {
      const payload = event.payload as { role?: string; text?: string };
      const text = typeof payload.text === "string" ? payload.text : "";
      return payload.role === "assistant" && (text.includes(`#${draft.id}`) || text.includes(draft.title));
    });
    assert(announced, `改写前的助手文本没有说明将修改哪篇草稿（未出现 #${draft.id} 或标题「${draft.title}」）`);
    console.log(
      `【2/2】去 AI 味改写 通过：草稿 ${draft.id} 正文 ${draftBody.length} → ${rewritten.body.length} 字，工件事件已落，改写前已说明`,
    );

    console.log("\nP1-C 新工具端到端验收全部通过");
  } finally {
    for (const item of finished) {
      await cleanupRun(item).catch((error) => {
        console.warn(`[清理] Run ${item.runId} 清理失败：${(error as Error).message}`);
      });
    }
    if (seededDraftId !== null) {
      await prisma.aiDraft.delete({ where: { id: seededDraftId } }).catch(() => undefined);
    }
    if (seededNoteIds.length > 0) {
      await prisma.note.deleteMany({ where: { id: { in: seededNoteIds } } }).catch(() => undefined);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("验收失败:", error);
    process.exit(1);
  });
