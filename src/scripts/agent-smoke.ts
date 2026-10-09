/**
 * Agent P0 端到端验收脚本
 *
 * 用法：
 *   1. 另开终端运行 worker：npx tsx src/worker/index.mts
 *   2. 运行本脚本：npx tsx src/scripts/agent-smoke.ts
 *
 * 验收项（任一不通过即 exit 1）：
 *   1. 正常路径：Run = succeeded，事件序列完整（agent_start → … → agent_end）
 *   2. 工具调用落库：agent_tool_calls 至少一行、status=succeeded、stepIndex 从 0 连续递增
 *   3. 产出落库：真被调用的工具在它自己的业务表里留下了行
 *   4. token 计量：Run.tokensUsed > 0
 *   5. 失败路径：模型地址不可达时 Run 记为 failed，**不是** succeeded
 *   6. 崩溃清扫：卡死的 Run 与它绑定的 Task 双双变 failed
 */
import { prisma } from "../lib/server/core/db";
import { encryptText } from "../lib/server/core/security";
import { shanghaiNow } from "../lib/server/core/time";
import { appendMessage, createConversation, createRunForMessage, sweepStuckRuns } from "../lib/server/services/agent-service";

/** 断言：不通过就抛错 —— 验收脚本必须能失败 */
function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`验收未通过：${message}`);
}

/** 轮询等待 Run 结束 */
async function waitForRun(runId: number, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await prisma.agentRun.findUnique({ where: { id: runId } });
    if (run && ["succeeded", "failed", "cancelled"].includes(run.status)) return run.status;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return "timeout";
}

/** 清掉一次 Run 相关的全部行 */
async function cleanupRun(runId: number, conversationId: number, taskId: number): Promise<void> {
  await prisma.agentEvent.deleteMany({ where: { runId } });
  await prisma.agentToolCall.deleteMany({ where: { runId } });
  await prisma.agentRun.delete({ where: { id: runId } });
  await prisma.task.delete({ where: { id: taskId } }).catch(() => undefined);
  await prisma.agentMessage.deleteMany({ where: { conversationId } });
  await prisma.agentConversation.delete({ where: { id: conversationId } });
}

async function main(): Promise<void> {
  const user = await prisma.user.findFirst({ orderBy: { id: "asc" } });
  if (!user) throw new Error("数据库里没有用户，请先注册一个账号");
  console.log("使用用户:", user.id);

  // ========== 1) 正常路径 ==========
  const suggestionCountBefore = await prisma.topicSuggestion.count({ where: { userId: user.id } });
  const draftCountBefore = await prisma.aiDraft.count({ where: { userId: user.id } });

  const conversation = await createConversation(user.id);
  console.log("创建会话:", conversation.id);
  const prompt = "帮我生成 2 个露营主题的小红书选题";
  const message = await appendMessage({ conversationId: conversation.id, role: "user", content: prompt });
  const run = await createRunForMessage({
    conversationId: conversation.id,
    userId: user.id,
    messageId: message.id,
  });
  console.log("创建 Run:", run.id, "taskId:", run.taskId);

  // 建 Run 后会话必须立刻进入 running（前端据此禁用输入框、显示加载态）
  const runningConversation = await prisma.agentConversation.findUnique({ where: { id: conversation.id } });
  assert(runningConversation?.status === "running", `建 Run 后会话状态应为 running，实际 ${runningConversation?.status}`);

  console.log("等待 worker 执行（最长 5 分钟）...");
  const status = await waitForRun(run.id, 5 * 60 * 1000);
  console.log("Run 最终状态:", status);
  assert(status === "succeeded", `Run 最终状态应为 succeeded，实际 ${status}`);

  const events = await prisma.agentEvent.findMany({
    where: { runId: run.id },
    orderBy: { id: "asc" },
    select: { type: true },
  });
  const eventTypes = events.map((event) => event.type);
  console.log("事件序列:", eventTypes.join(" → "));
  assert(eventTypes[0] === "agent_start", "事件序列第一项应为 agent_start");
  assert(eventTypes.includes("tool_execution_end"), "没有任何工具被调用（事件序列里没有 tool_execution_end）");
  assert(eventTypes[eventTypes.length - 1] === "agent_end", "事件序列最后一项应为 agent_end");

  // 工具调用必须真的落到了 agent_tool_calls（C1：旧计划里这张表没有任何写入方，永远是空的）
  const toolCalls = await prisma.agentToolCall.findMany({ where: { runId: run.id }, orderBy: { stepIndex: "asc" } });
  console.log("工具调用:", toolCalls.map((row) => `${row.stepIndex}:${row.toolName}:${row.status}`).join(", ") || "（无）");
  assert(toolCalls.length >= 1, "agent_tool_calls 一行都没有（工具调用落库没生效）");
  assert(
    toolCalls.every((row) => row.status === "succeeded"),
    `工具调用状态应全为 succeeded，实际 ${toolCalls.map((row) => row.status).join(",")}`,
  );
  assert(
    toolCalls.every((row, index) => row.stepIndex === index),
    `stepIndex 应为 0..n-1 连续递增，实际 ${toolCalls.map((row) => row.stepIndex).join(",")}`,
  );
  assert(toolCalls.every((row) => row.toolCallId.length > 0), "工具调用缺少 toolCallId");

  // token 计量：没有它，P1 的预算拦截就没有基线数据
  const finishedRun = await prisma.agentRun.findUnique({ where: { id: run.id } });
  console.log("tokensUsed:", finishedRun?.tokensUsed, "stepCount:", finishedRun?.stepCount);
  assert((finishedRun?.tokensUsed ?? 0) > 0, "Run.tokensUsed 为 0（token 计量没生效）");

  // 事件里的 usage 也必须留下来 —— 否则 token 明细无法从库里复算
  const messageEndEvents = await prisma.agentEvent.findMany({
    where: { runId: run.id, type: "message_end" },
    select: { payload: true },
  });
  const hasUsage = messageEndEvents.some((event) => {
    const payload = event.payload as { role?: string; usage?: { totalTokens?: number } };
    return payload.role === "assistant" && (payload.usage?.totalTokens ?? 0) > 0;
  });
  assert(hasUsage, "agent_events 的 message_end 载荷里没有 usage（serializeEventForDb 把它丢了）");

  // 产出落库：按「实际被调用的工具」去它自己的业务表里核对
  const suggestionCountAfter = await prisma.topicSuggestion.count({ where: { userId: user.id } });
  const draftCountAfter = await prisma.aiDraft.count({ where: { userId: user.id } });
  console.log(`选题数：${suggestionCountBefore} → ${suggestionCountAfter}；草稿数：${draftCountBefore} → ${draftCountAfter}`);
  const calledTools = toolCalls.map((row) => row.toolName);
  if (calledTools.includes("topic_generate")) {
    assert(suggestionCountAfter > suggestionCountBefore, "调用了 topic_generate，但 topic_suggestions 没有新增行");
  }
  if (calledTools.includes("content_note_pack")) {
    assert(draftCountAfter > draftCountBefore, "调用了 content_note_pack，但 ai_drafts 没有新增行");
  }

  // 会话回到 idle，标题按首条用户消息派生
  const idleConversation = await prisma.agentConversation.findUnique({ where: { id: conversation.id } });
  assert(idleConversation?.status === "idle", `Run 结束后会话应回到 idle，实际 ${idleConversation?.status}`);
  assert(idleConversation?.title !== "新任务", "会话标题未按首条用户消息派生");

  await cleanupRun(run.id, conversation.id, run.taskId);
  console.log("正常路径验收通过，已清理");

  // ========== 2) 失败路径：模型地址不可达，必须记为 failed ==========
  // 用临时用户 + 指向 discard 端口的默认文本模型，走**真实的**模型失败链路：
  // streamSimple 连接失败 → Pi 把失败编码成 stopReason="error" → 循环必须判成 failed。
  // 这是 C2 的端到端验证：旧实现会把它记成 succeeded，并让 Task 变成 completed + 100%。
  const tempUser = await prisma.user.create({
    data: { username: `agent_smoke_${Date.now()}`, passwordHash: "not-a-real-hash", createdAt: shanghaiNow() },
  });
  const tempModel = await prisma.modelConfig.create({
    data: {
      userId: tempUser.id,
      name: "验收用（不可达地址）",
      modelType: "text",
      provider: "openai-compatible",
      modelName: "gpt-4o-mini",
      baseUrl: "http://127.0.0.1:9/v1", // discard 端口：连接立即被拒
      encryptedApiKey: encryptText("sk-smoke-invalid"),
      isDefault: true,
    },
  });
  const failedConversation = await createConversation(tempUser.id);
  const failedMessage = await appendMessage({ conversationId: failedConversation.id, role: "user", content: "这条一定会失败" });
  const failedRun = await createRunForMessage({
    conversationId: failedConversation.id,
    userId: tempUser.id,
    messageId: failedMessage.id,
  });
  const failedStatus = await waitForRun(failedRun.id, 2 * 60 * 1000);
  const failedRunRow = await prisma.agentRun.findUnique({ where: { id: failedRun.id } });
  console.log("故意失败的 Run 最终状态:", failedStatus, "errorType:", failedRunRow?.errorType);
  assert(failedStatus === "failed", `模型不可达时 Run 应为 failed，实际 ${failedStatus}`);
  assert(
    failedRunRow?.errorType === "model_error",
    `失败 Run 的 errorType 应为 model_error，实际 ${failedRunRow?.errorType}（若为 loop_error，说明失败发生在 prompt 前置阶段，检查 buildPiModel / getApiKey 链路）`,
  );
  const failedTask = await prisma.task.findUnique({ where: { id: failedRun.taskId } });
  assert(failedTask?.status === "failed", `失败 Run 绑定的 Task 应为 failed，实际 ${failedTask?.status}`);

  await cleanupRun(failedRun.id, failedConversation.id, failedRun.taskId);
  await prisma.modelConfig.delete({ where: { id: tempModel.id } });
  await prisma.user.delete({ where: { id: tempUser.id } });
  console.log("失败路径验收通过，已清理");

  // ========== 3) 崩溃清扫：卡死的 Run 必须连同它的 Task 一起失败 ==========
  const stuckConversation = await createConversation(user.id, "清扫验收");
  const stuckTask = await prisma.task.create({
    data: { userId: user.id, platform: "xhs", taskType: "agent_run", status: "pending", progress: 0, createdAt: shanghaiNow() },
  });
  const oneHourAgo = new Date(shanghaiNow().getTime() - 60 * 60 * 1000);
  const stuckRun = await prisma.agentRun.create({
    data: {
      conversationId: stuckConversation.id,
      userId: user.id,
      taskId: stuckTask.id,
      status: "running",
      startedAt: oneHourAgo,
      createdAt: oneHourAgo,
    },
  });
  const swept = await sweepStuckRuns(15);
  console.log("本次清扫的 Run 数量:", swept);
  assert(swept >= 1, "sweepStuckRuns 没有清扫到卡死的 Run");
  const sweptRun = await prisma.agentRun.findUnique({ where: { id: stuckRun.id } });
  assert(
    sweptRun?.status === "failed" && sweptRun.errorType === "worker_restart",
    `卡死的 Run 应被标记为 failed/worker_restart，实际 ${sweptRun?.status}/${sweptRun?.errorType}`,
  );
  const sweptTask = await prisma.task.findUnique({ where: { id: stuckTask.id } });
  assert(sweptTask?.status === "failed", `卡死 Run 关联的 Task 仍停在 ${sweptTask?.status}（Run 与 Task 不同步）`);

  await prisma.agentRun.delete({ where: { id: stuckRun.id } });
  await prisma.task.delete({ where: { id: stuckTask.id } });
  await prisma.agentConversation.delete({ where: { id: stuckConversation.id } });
  console.log("崩溃清扫验收通过，已清理");

  console.log("P0 验收全部通过");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("验收失败:", error);
    process.exit(1);
  });
