/**
 * Agent P1-A 接口层端到端验收脚本
 *
 * 用法（三个终端，缺一不可）：
 *   终端 A：npx tsx src/worker/index.mts        （Agent 循环 worker：每 3s 领一次 pending Run）
 *   终端 B：npm run dev                          （Next.js dev server：默认 http://127.0.0.1:3000）
 *   终端 C：npx tsx src/scripts/agent-api-smoke.ts
 *
 * 与 P0 的 agent-smoke.ts 的分工：那个脚本直接调服务层，验的是「循环能不能跑」；
 * 本脚本走**真 HTTP + 真 SSE + 真 worker**，验的是 P1-A 的接口契约（十个字段的首屏、
 * SSE 帧格式与去重、取消与删除的状态码矩阵）。
 *
 * 验收项（9 项，任一不通过即 exit 1）：
 *   1. 认证          无 token 访问会话列表 → 401
 *   2. 会话          POST 建会话（必须发 JSON 对象）→ 列表能看到；访问**他人**会话 → 404
 *   3. 发消息        POST messages → Run=pending、会话=running、标题按首条消息派生；紧接着再发 → 409
 *   4. SSE 完整序列  订阅 ?last_event_id=0 直到 agent_end：首帧 agent_start、末帧 agent_end、
 *                    id 严格递增；至少一帧 message_end 带非空 text（D23）；
 *                    tool_execution_end 中「对应库中 agent_tool_calls 行」的帧有非空 summary（§4.3）；
 *                    至少一帧 status
 *   5. 首屏契约      GET 详情十个字段齐全；messages 只有 user；events 有 assistant 文本；
 *                    tool_calls 每行 summary 非空；artifacts 非空且与接口 6 同源同形状；
 *                    事件 id ≤ latest_event_id 且与库一致；runs 含刚跑完的 Run
 *   6. 去重边界      以 latest_event_id 为起点重连 2 秒 → 不应收到 id ≤ latest_event_id 的帧
 *   7. 取消          终态 Run → 409、不存在的 Run → 404、pending Run → 200
 *                    （Run=cancelled / Task=failed / 会话=idle）
 *   8. 删除保护      有 pending Run 的会话 DELETE → 409；该 Run 转终态后 DELETE → 200
 *   9. 清理          脚本产生的会话全部深删、临时用户删掉，各表计数回到脚本开始前的基线
 *                    （证明脚本没有留下孤儿行；不能断言「绝对归零」——库里可能有用户自己的会话）
 *
 * 环境变量：AGENT_API_BASE 可覆盖 dev server 地址（默认 http://127.0.0.1:3000）
 */
import { prisma } from "../lib/server/core/db";
import { createAccessToken } from "../lib/server/core/security";
import { shanghaiNow } from "../lib/server/core/time";
import {
  buildRunDefaults,
  DEFAULT_CONVERSATION_TITLE,
  deleteConversationDeep,
  deriveConversationTitle,
} from "../lib/server/services/agent-service";

/** dev server 地址（可用 AGENT_API_BASE 覆盖） */
const BASE_URL = process.env.AGENT_API_BASE ?? "http://127.0.0.1:3000";

/** SSE 最长等待：真模型跑一轮通常几十秒，5 分钟只是兜底 */
const SSE_TIMEOUT_MS = 5 * 60 * 1000;

/** 首屏接口（接口 3）的十个字段 —— 少一个前端就少一块渲染来源 */
const HOME_FIELDS = [
  "conversation",
  "messages",
  "events",
  "tool_calls",
  "artifacts",
  "runs",
  "latest_event_id",
  "events_truncated",
  "tool_calls_truncated",
  "artifacts_truncated",
] as const;

/**
 * 断言：不通过就抛错 —— 验收脚本必须能失败。
 * 声明成断言函数（asserts），使「断言过 = 该条件成立」能被类型系统采纳（如 body 非空的收窄）。
 */
function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`验收未通过：${message}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------- HTTP 助手 ----------

interface ApiResult<T> {
  status: number;
  body: T;
}

/** 发一次真 HTTP 请求并解析 JSON（token 传 null 表示不带 Authorization 头） */
async function api<T>(token: string | null, path: string, init?: RequestInit): Promise<ApiResult<T>> {
  const headers = new Headers(init?.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (init?.body !== undefined && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(`${BASE_URL}${path}`, { ...init, headers, cache: "no-store" });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: response.status, body: body as T };
}

/** 打印一行响应，断言失败时能直接看到服务端说了什么 */
function describe(result: ApiResult<unknown>): string {
  return `HTTP ${result.status} ${JSON.stringify(result.body)}`;
}

// ---------- SSE 助手 ----------

interface StreamFrame {
  id: number;
  run_id: number;
  type: string;
  payload: Record<string, unknown>;
  created_at: string;
}

/**
 * 订阅 SSE 并收集帧，直到收到 agent_end 或超时。
 *
 * 只认 `data: ` 前缀的行（心跳是 `: ping`，天然被跳过）。
 * 超时/中止时**返回已收到的帧**而不是抛错 —— 让调用方的断言给出更有指向性的报错
 * （例如「没等到 agent_end，只收到 agent_start」比「AbortError」有用得多）。
 */
async function collectStream(
  token: string,
  conversationId: number,
  lastEventId: number,
  timeoutMs: number,
): Promise<StreamFrame[]> {
  const frames: StreamFrame[] = [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(
      `${BASE_URL}/api/agent/conversations/${conversationId}/events?last_event_id=${lastEventId}`,
      { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal, cache: "no-store" },
    );
    assert(response.status === 200, `SSE 订阅应返回 200，实际 HTTP ${response.status}`);
    const body = response.body;
    assert(body !== null, "SSE 响应没有 body");
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newlineIndex = buffer.indexOf("\n");
        while (newlineIndex >= 0) {
          const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
          buffer = buffer.slice(newlineIndex + 1);
          if (line.startsWith("data: ")) {
            const frame = JSON.parse(line.slice("data: ".length)) as StreamFrame;
            frames.push(frame);
            if (frame.type === "agent_end") return frames;
          }
          newlineIndex = buffer.indexOf("\n");
        }
      }
    } finally {
      // 收到 agent_end 或超时都要主动断开，否则连接会挂到服务端流自然结束
      await reader.cancel().catch(() => undefined);
    }
  } catch (error) {
    if ((error as Error).name === "AbortError") return frames;
    throw error;
  } finally {
    clearTimeout(timer);
  }
  return frames;
}

// ---------- 造数据助手（真 HTTP 建会话，prisma 造 Run）----------

interface ConversationPayload {
  id: number;
  title: string;
  status: string;
  created_at: string;
  updated_at: string;
}

interface RunPayload {
  id: number;
  conversation_id: number;
  task_id: number;
  status: string;
  step_count: number;
  max_steps: number;
  tokens_used: number;
  token_budget: number;
  error_type: string | null;
  created_at: string;
  finished_at: string | null;
}

interface SendMessagePayload {
  conversation: ConversationPayload;
  message: { id: number; role: string; content: string };
  run: RunPayload;
}

/**
 * 经接口建会话。
 * body 必须发一个 JSON 对象（哪怕是空的 `{}`）——路由的 readJson 对空 body 直接 400，
 * 这条路径是「前端建会话」的真实调用形态，不能退化成直接落库。
 */
async function createConversationViaApi(token: string): Promise<number> {
  const created = await api<ConversationPayload>(token, "/api/agent/conversations", {
    method: "POST",
    body: JSON.stringify({}),
  });
  assert(created.status === 200, `建会话应返回 200，实际 ${describe(created)}`);
  return created.body.id;
}

/**
 * 手工造一个 pending Run（连带它的 Task 与会话的 running 状态，与 createRunForMessage 同口径）。
 * 用途：取消与删除保护都需要「还没被 worker 领走」的 Run，走接口建不出来（发消息即建 Run，
 * 且 worker 每 3s 就会领走），只能直接落库，再由脚本毫秒级地抢先操作。
 */
async function createPendingRun(options: { userId: number; conversationId: number }): Promise<{ runId: number; taskId: number }> {
  const defaults = buildRunDefaults();
  const now = shanghaiNow();
  const task = await prisma.task.create({
    data: {
      userId: options.userId,
      platform: "xhs",
      taskType: "agent_run",
      status: "pending",
      progress: 0,
      payload: { conversation_id: options.conversationId },
      // createdAt 无库级默认值，必须显式传
      createdAt: now,
    },
  });
  const run = await prisma.agentRun.create({
    data: {
      conversationId: options.conversationId,
      userId: options.userId,
      taskId: task.id,
      status: defaults.status,
      stepCount: defaults.stepCount,
      tokensUsed: defaults.tokensUsed,
      maxSteps: defaults.maxSteps,
      tokenBudget: defaults.tokenBudget,
      // createdAt 无库级默认值，必须显式传
      createdAt: now,
    },
  });
  await prisma.agentConversation.update({
    where: { id: options.conversationId },
    data: { status: "running", updatedAt: now },
  });
  return { runId: run.id, taskId: task.id };
}

/** 轮询等待 Run 进入终态（被 worker 抢先时用），返回最终状态 */
async function waitForRunTerminal(runId: number, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await prisma.agentRun.findUnique({ where: { id: runId } });
    if (!run) return "missing";
    if (["succeeded", "failed", "cancelled"].includes(run.status)) return run.status;
    await sleep(500);
  }
  return "timeout";
}

// ---------- 清理 ----------

interface TrackedConversation {
  conversationId: number;
  userId: number;
  label: string;
}

/**
 * 深删一个会话。删之前要做两件事，否则会留下孤儿行或删不动：
 *   1. 把还没被领走的 pending Run 打成终态 —— 否则 deleteConversationDeep 直接返回 active_run；
 *   2. 等已被 worker 领走的 running Run 跑完 —— 事件表没有外键，会话删掉后 worker 仍会写事件行，
 *      那些行永远查不回来（库计数也就回不到基线）。
 */
async function cleanupConversation(entry: TrackedConversation): Promise<void> {
  const now = shanghaiNow();
  const pending = await prisma.agentRun.findMany({
    where: { conversationId: entry.conversationId, status: "pending" },
    select: { id: true, taskId: true },
  });
  if (pending.length > 0) {
    await prisma.agentRun.updateMany({
      where: { id: { in: pending.map((run) => run.id) } },
      data: { status: "failed", errorType: "smoke_cleanup", finishedAt: now },
    });
    await prisma.task.updateMany({
      where: { id: { in: pending.map((run) => run.taskId) } },
      data: { status: "failed", progress: 0, finishedAt: now },
    });
  }

  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const running = await prisma.agentRun.count({
      where: { conversationId: entry.conversationId, status: "running" },
    });
    if (running === 0) break;
    await sleep(1000);
  }

  const result = await deleteConversationDeep(entry.conversationId, entry.userId);
  if (result !== "deleted") console.warn(`[清理] 会话 ${entry.conversationId}（${entry.label}）删除结果：${result}`);
}

/** 脚本开始前的 Agent 表计数：结束时必须回到这个值（不能用「绝对归零」——库里可能有用户自己的会话） */
async function snapshotAgentTables(): Promise<Record<string, number>> {
  const [conversations, runs, messages, events, toolCalls, agentTasks] = await Promise.all([
    prisma.agentConversation.count(),
    prisma.agentRun.count(),
    prisma.agentMessage.count(),
    prisma.agentEvent.count(),
    prisma.agentToolCall.count(),
    prisma.task.count({ where: { taskType: "agent_run" } }),
  ]);
  return { conversations, runs, messages, events, toolCalls, agentTasks };
}

// ---------- 主流程 ----------

async function main(): Promise<void> {
  // 脚本产生的东西全部登记在这里，失败时 finally 也要尽力清掉
  const tracked: TrackedConversation[] = [];
  let tempUserId: number | null = null;

  // 在任何造数之前记录基线：第 9 项以它为「清干净」的判据，避免库里已有用户会话时误报
  const baseline = await snapshotAgentTables();
  console.log(`【基线】脚本开始前各表计数 ${JSON.stringify(baseline)}`);

  try {
    // 选一个配了默认文本模型的用户：SSE 那一步要真跑一轮 ReAct 循环，没模型只会立刻失败
    const modelConfig = await prisma.modelConfig.findFirst({
      where: { modelType: "text", isDefault: true, encryptedApiKey: { not: "" } },
      orderBy: { id: "asc" },
    });
    if (!modelConfig) throw new Error("数据库里没有默认文本模型，先在界面上配一个（否则 SSE 那步跑不出事件）");
    const user = await prisma.user.findUnique({ where: { id: modelConfig.userId } });
    if (!user) throw new Error(`默认文本模型 ${modelConfig.id} 挂在已不存在的用户上`);
    const token = createAccessToken(user.id);
    console.log(`目标：${BASE_URL}，用户 ${user.id}（${user.username}），模型 ${modelConfig.modelName}`);

    // ========== 1) 认证：无 token → 401 ==========
    const anonymous = await api<unknown>(null, "/api/agent/conversations");
    console.log(`【1/9】认证：无 token 访问会话列表 → ${describe(anonymous)}`);
    assert(anonymous.status === 401, `无 token 访问会话列表应为 401，实际 ${anonymous.status}`);
    console.log("【1/9】认证 通过：401");

    // ========== 2) 会话：建会话 + 列表可见 + 他人会话 404 ==========
    const conversationId = await createConversationViaApi(token);
    tracked.push({ conversationId, userId: user.id, label: "主会话" });
    console.log(`【2/9】会话：新建会话 ${conversationId}`);

    const list = await api<{ items: ConversationPayload[] }>(token, "/api/agent/conversations");
    assert(list.status === 200, `会话列表应返回 200，实际 ${describe(list)}`);
    const listedConversation = list.body.items.find((item) => item.id === conversationId);
    assert(listedConversation !== undefined, `会话列表里找不到刚建的会话 ${conversationId}`);
    // 只断言自己建的那一条：列表里可能还有别的会话，拿全表断言会误伤
    assert(
      listedConversation.title === DEFAULT_CONVERSATION_TITLE,
      `新建会话的标题应还是默认值「${DEFAULT_CONVERSATION_TITLE}」，实际「${listedConversation.title}」`,
    );

    // 临时用户 + 它的会话：用来验「访问他人会话一律 404」（不能泄露「存在但不是你的」）
    const tempUser = await prisma.user.create({
      data: { username: `agent_api_smoke_${Date.now()}`, passwordHash: "not-a-real-hash", createdAt: shanghaiNow() },
    });
    tempUserId = tempUser.id;
    const tempToken = createAccessToken(tempUser.id);
    const tempConversationId = await createConversationViaApi(tempToken);
    tracked.push({ conversationId: tempConversationId, userId: tempUser.id, label: "临时用户的会话" });

    // 先用临时用户自己访问一次：证明这个会话确实存在，404 是归属校验而不是「行不存在」
    const ownView = await api<unknown>(tempToken, `/api/agent/conversations/${tempConversationId}`);
    assert(ownView.status === 200, `会话属主访问自己的会话应返回 200，实际 ${describe(ownView)}`);
    const otherView = await api<unknown>(token, `/api/agent/conversations/${tempConversationId}`);
    console.log(`【2/9】会话：访问他人会话 → ${describe(otherView)}`);
    assert(otherView.status === 404, `访问他人会话应为 404，实际 ${otherView.status}`);
    console.log("【2/9】会话 通过：建会话可见、他人会话 404");

    // ========== 3) 发消息：pending + running + 标题派生，并发第二条 409 ==========
    const prompt = "帮我生成 2 个露营主题的小红书选题";
    const sent = await api<SendMessagePayload>(token, `/api/agent/conversations/${conversationId}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: prompt }),
    });
    assert(sent.status === 200, `发消息应返回 200，实际 ${describe(sent)}`);
    const runId = sent.body.run.id;
    console.log(`【3/9】发消息：run ${runId} status=${sent.body.run.status}，会话 status=${sent.body.conversation.status}，标题「${sent.body.conversation.title}」`);
    assert(sent.body.run.status === "pending", `刚建的 Run 应为 pending，实际 ${sent.body.run.status}`);
    assert(sent.body.conversation.status === "running", `建 Run 后会话应为 running，实际 ${sent.body.conversation.status}`);
    assert(
      sent.body.conversation.title !== DEFAULT_CONVERSATION_TITLE,
      `会话标题未按首条用户消息派生，仍是「${DEFAULT_CONVERSATION_TITLE}」`,
    );
    assert(
      sent.body.conversation.title === deriveConversationTitle(prompt),
      `会话标题应派生为「${deriveConversationTitle(prompt)}」，实际「${sent.body.conversation.title}」`,
    );

    const concurrent = await api<unknown>(token, `/api/agent/conversations/${conversationId}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: "第二条不该被接受" }),
    });
    console.log(`【3/9】发消息：同一会话并发第二条 → ${describe(concurrent)}`);
    assert(concurrent.status === 409, `会话执行中再发消息应为 409，实际 ${concurrent.status}`);
    console.log("【3/9】发消息 通过：pending/running/标题派生 + 并发 409");

    // ========== 4) SSE 完整事件序列 ==========
    const sseStartedAt = Date.now();
    console.log(`【4/9】SSE：订阅 ?last_event_id=0，等待 agent_end（最长 ${SSE_TIMEOUT_MS / 60000} 分钟）...`);
    const frames = await collectStream(token, conversationId, 0, SSE_TIMEOUT_MS);
    const sseElapsed = Date.now() - sseStartedAt;
    // 一次运行有上千帧（message_update 逐 token 一条），按类型聚合打印，否则刷屏看不见重点
    const typeCounts = new Map<string, number>();
    for (const frame of frames) typeCounts.set(frame.type, (typeCounts.get(frame.type) ?? 0) + 1);
    const typeSummary = [...typeCounts.entries()].map(([type, count]) => `${type}×${count}`).join(", ");
    console.log(`【4/9】SSE：${sseElapsed}ms 收到 ${frames.length} 帧（${typeSummary || "空"}）`);
    assert(frames.length > 0, "SSE 一帧都没收到");
    assert(frames[0].type === "agent_start", `首帧应为 agent_start，实际 ${frames[0].type}`);
    assert(
      frames[frames.length - 1].type === "agent_end",
      `末帧应为 agent_end（5 分钟内没等到），实际 ${frames[frames.length - 1].type}`,
    );
    const strictlyIncreasing = frames.every((frame, index) => index === 0 || frame.id > frames[index - 1].id);
    assert(strictlyIncreasing, `事件 id 应严格递增，实际 ${frames.map((frame) => frame.id).join(",")}`);

    // D23：中间过程的助手文本必须随 message_end 一起下发，否则前端刷新后看不到过程预告
    const assistantTexts = frames.filter(
      (frame) =>
        frame.type === "message_end" &&
        frame.payload.role === "assistant" &&
        typeof frame.payload.text === "string" &&
        frame.payload.text.length > 0,
    );
    assert(
      assistantTexts.length >= 1,
      `没有任何一帧 message_end 带非空 payload.text（D23 回归）：${JSON.stringify(frames.filter((frame) => frame.type === "message_end").map((frame) => frame.payload))}`,
    );

    // §4.3：tool_execution_end 的摘要由 SSE 出口补齐，前端只渲染不算。
    //
    // 为什么断言要带「能对应到库中行」这个前提：Pi 对「工具名不存在 / 参数校验失败 /
    // 输出被 length 截断」这三种情况会在走钩子之前就短路，这些调用本来不落行。
    // 现在它们已由事件回填（agent-loop.mts 的 subscribe）补上审计行与摘要，
    // 因此正常情况下每一帧都能对应到行；只有回填那次落库也失败时才会缺。
    // 这里只对「有行」的帧断言摘要（否则 DB 抖动会让一次正确的运行被判失败），
    // 另外要求整体至少有一帧有行有摘要（避免空跑通过）。
    const toolEndFrames = frames.filter((frame) => frame.type === "tool_execution_end");
    assert(toolEndFrames.length >= 1, "没有任何 tool_execution_end 帧（模型没调用工具，换个更能触发工具的提问）");
    const rowToolCallIds = new Set(
      (await prisma.agentToolCall.findMany({ where: { runId }, select: { toolCallId: true } })).map(
        (row) => row.toolCallId,
      ),
    );
    const framesWithRow = toolEndFrames.filter((frame) => rowToolCallIds.has(String(frame.payload.toolCallId)));
    assert(framesWithRow.length > 0, "没有任何 tool_execution_end 帧对应到 agent_tool_calls 行（工具调用落库没生效）");
    const missingSummary = framesWithRow.filter(
      (frame) => typeof frame.payload.summary !== "string" || !frame.payload.summary,
    );
    assert(
      missingSummary.length === 0,
      `有 ${missingSummary.length} 帧对应到库中工具调用却没有 summary（§4.3 的补齐没生效）：${JSON.stringify(missingSummary.map((frame) => frame.payload))}`,
    );

    const statusFrames = frames.filter((frame) => frame.type === "status");
    assert(statusFrames.length >= 1, "没有任何 status 帧（终态结论没下发）");
    console.log(
      `【4/9】SSE 通过：首帧 ${frames[0].type}(id=${frames[0].id}) 末帧 ${frames[frames.length - 1].type}(id=${frames[frames.length - 1].id}) 严格递增；` +
        `message_end 带文本 ${assistantTexts.length} 帧，tool_execution_end ${toolEndFrames.length} 帧（其中 ${framesWithRow.length} 帧对应库中行、summary 齐全），status ${statusFrames.length} 帧`,
    );

    // ========== 5) 首屏契约 ==========
    const home = await api<Record<string, unknown>>(token, `/api/agent/conversations/${conversationId}`);
    assert(home.status === 200, `首屏应返回 200，实际 ${describe(home)}`);
    for (const field of HOME_FIELDS) {
      assert(field in home.body, `首屏缺字段 ${field}，实际字段：${Object.keys(home.body).join(",")}`);
    }
    const homeMessages = home.body.messages as Array<{ role: string }>;
    const homeEvents = home.body.events as Array<{ id: number; run_id: number; type: string; payload: Record<string, unknown> }>;
    const homeToolCalls = home.body.tool_calls as Array<{ id: number; tool_name: string; summary: string }>;
    const homeArtifacts = home.body.artifacts as Array<Record<string, unknown>>;
    const homeRuns = home.body.runs as RunPayload[];
    const latestEventId = home.body.latest_event_id as number;

    assert(
      homeMessages.every((message) => message.role === "user"),
      `首屏 messages 只应含 user 角色（助手文本一律来自 events），实际 ${JSON.stringify(homeMessages.map((message) => message.role))}`,
    );
    assert(homeMessages.length >= 1, "首屏 messages 里没有用户消息");
    const homeAssistantTexts = homeEvents.filter(
      (event) =>
        event.type === "message_end" &&
        event.payload.role === "assistant" &&
        typeof event.payload.text === "string" &&
        event.payload.text.length > 0,
    );
    assert(
      homeAssistantTexts.length >= 1,
      `首屏 events 里没有带文本的 assistant message_end：${JSON.stringify(homeEvents.map((event) => [event.type, event.payload.role]))}`,
    );
    assert(homeToolCalls.length >= 1, "首屏 tool_calls 为空（SSE 已收到工具调用，首屏却没有）");
    const emptySummaries = homeToolCalls.filter((row) => !row.summary || row.summary.length === 0);
    assert(
      emptySummaries.length === 0,
      `${emptySummaries.length}/${homeToolCalls.length} 行 tool_calls 的 summary 为空：${JSON.stringify(emptySummaries.map((row) => row.tool_name))}`,
    );

    // 工件链路：本次提问会触发 topic_generate，必然产出 topic 工件
    assert(homeArtifacts.length > 0, "首屏 artifacts 为空（extractArtifacts → 事件 → 首屏这条链路断了）");
    const artifactList = await api<{ items: Array<Record<string, unknown>> }>(
      token,
      `/api/agent/conversations/${conversationId}/artifacts`,
    );
    assert(artifactList.status === 200, `工件接口应返回 200，实际 ${artifactList.status}`);
    // 与首屏 artifacts 同源同形状（设计稿 §4.4：两处不得各写一份序列化）
    assert(
      JSON.stringify(artifactList.body.items) === JSON.stringify(homeArtifacts),
      "工件接口与首屏 artifacts 的内容或形状不一致",
    );

    assert(
      homeEvents.every((event) => event.id <= latestEventId),
      `events 里有 id 大于 latest_event_id（${latestEventId}）的帧：${homeEvents.map((event) => event.id).join(",")}`,
    );

    // latest_event_id 必须等于库里该会话全部 Run 的最大事件 id（前端据此续传，多一格就会重复渲染）
    const conversationRuns = await prisma.agentRun.findMany({ where: { conversationId }, select: { id: true } });
    const maxEvent = await prisma.agentEvent.aggregate({
      where: { runId: { in: conversationRuns.map((run) => run.id) } },
      _max: { id: true },
    });
    assert(
      latestEventId === (maxEvent._max.id ?? 0),
      `latest_event_id 应等于库里最大事件 id ${maxEvent._max.id ?? 0}，实际 ${latestEventId}`,
    );
    assert(homeRuns.length >= 1, "首屏 runs 为空");
    const justFinished = homeRuns.find((run) => run.id === runId);
    assert(justFinished !== undefined, `首屏 runs 里找不到刚跑完的 Run ${runId}`);
    assert(
      justFinished?.status === "succeeded",
      `刚跑完的 Run 应为 succeeded，实际 ${justFinished?.status}`,
    );
    console.log(
      `【5/9】首屏：messages ${homeMessages.length} 条（全 user），events ${homeEvents.length} 条（assistant 文本 ${homeAssistantTexts.length} 条），` +
        `tool_calls ${homeToolCalls.length} 行（summary 齐全），artifacts ${homeArtifacts.length} 个（与接口 6 一致），` +
        `latest_event_id=${latestEventId}，runs ${homeRuns.length} 个`,
    );
    console.log("【5/9】首屏契约 通过：十字段齐全且内容自洽");

    // ========== 6) 去重边界：以 latest_event_id 为起点重连，不应收到旧帧 ==========
    const dedupeStartedAt = Date.now();
    const replayFrames = await collectStream(token, conversationId, latestEventId, 2000);
    const dedupeElapsed = Date.now() - dedupeStartedAt;
    const staleFrames = replayFrames.filter((frame) => frame.id <= latestEventId);
    console.log(
      `【6/9】去重：以 last_event_id=${latestEventId} 重连 ${dedupeElapsed}ms，收到 ${replayFrames.length} 帧（id ${replayFrames.map((frame) => frame.id).join(",") || "无"}）`,
    );
    assert(
      staleFrames.length === 0,
      `重连后收到了 ${staleFrames.length} 帧 id ≤ latest_event_id(${latestEventId}) 的旧事件：${staleFrames.map((frame) => frame.id).join(",")}`,
    );
    console.log("【6/9】去重边界 通过：没有回放旧帧");

    // ========== 7) 取消：409 / 404 / 200 ==========
    const cancelTerminal = await api<unknown>(token, `/api/agent/runs/${runId}/cancel`, { method: "POST" });
    console.log(`【7/9】取消：终态 Run ${runId} → ${describe(cancelTerminal)}`);
    assert(cancelTerminal.status === 409, `取消终态 Run 应为 409，实际 ${cancelTerminal.status}`);

    const cancelMissing = await api<unknown>(token, "/api/agent/runs/999999999/cancel", { method: "POST" });
    console.log(`【7/9】取消：不存在的 Run → ${describe(cancelMissing)}`);
    assert(cancelMissing.status === 404, `取消不存在的 Run 应为 404，实际 ${cancelMissing.status}`);

    // pending → 200：worker 每 3s 领一次，脚本毫秒级取消；万一被抢先（409）就换一个新会话重试
    let cancelledRunId = 0;
    let cancelAttempt = 0;
    for (cancelAttempt = 1; cancelAttempt <= 3; cancelAttempt++) {
      const pendingConversationId = await createConversationViaApi(token);
      tracked.push({ conversationId: pendingConversationId, userId: user.id, label: `取消验收 attempt ${cancelAttempt}` });
      const pending = await createPendingRun({ userId: user.id, conversationId: pendingConversationId });
      const cancelled = await api<{ run: RunPayload }>(token, `/api/agent/runs/${pending.runId}/cancel`, { method: "POST" });
      if (cancelled.status === 200) {
        assert(
          cancelled.body.run.status === "cancelled",
          `取消接口返回的 Run 状态应为 cancelled，实际 ${cancelled.body.run.status}`,
        );
        const cancelledRun = await prisma.agentRun.findUnique({ where: { id: pending.runId } });
        const cancelledTask = await prisma.task.findUnique({ where: { id: pending.taskId } });
        const cancelledConversation = await prisma.agentConversation.findUnique({ where: { id: pendingConversationId } });
        assert(cancelledRun?.status === "cancelled", `Run 落库状态应为 cancelled，实际 ${cancelledRun?.status}`);
        assert(cancelledTask?.status === "failed", `取消后 Task 应为 failed，实际 ${cancelledTask?.status}`);
        assert(
          cancelledConversation?.status === "idle",
          `取消后会话应回到 idle，实际 ${cancelledConversation?.status}`,
        );
        cancelledRunId = pending.runId;
        console.log(
          `【7/9】取消：pending Run ${pending.runId}（第 ${cancelAttempt} 次尝试）→ 200，Run=cancelled、Task=failed、会话=idle`,
        );
        break;
      }
      // 被 worker 抢先领走：等它跑完（会话会回到 idle）再换一个会话重试
      console.warn(`【7/9】取消：pending Run ${pending.runId} 被 worker 抢先（${describe(cancelled)}），等它结束后重试`);
      assert(cancelled.status === 409, `取消 pending Run 失败且不是 409：${describe(cancelled)}`);
      await waitForRunTerminal(pending.runId, 60_000);
    }
    assert(cancelledRunId > 0, "连续 3 次都没能在 worker 领取前取消掉 pending Run");
    console.log("【7/9】取消 通过：409 / 404 / 200（Run=cancelled、Task=failed、会话=idle）");

    // ========== 8) 删除保护：有 pending Run 不能删，转终态后能删 ==========
    let deleteProtectedConversationId = 0;
    let deleteProtectedRunId = 0;
    let deleteProtectedTaskId = 0;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const guardConversationId = await createConversationViaApi(token);
      tracked.push({ conversationId: guardConversationId, userId: user.id, label: `删除保护 attempt ${attempt}` });
      const pending = await createPendingRun({ userId: user.id, conversationId: guardConversationId });
      const blocked = await api<unknown>(token, `/api/agent/conversations/${guardConversationId}`, { method: "DELETE" });
      if (blocked.status === 409) {
        console.log(`【8/9】删除保护：有 pending Run 的会话 ${guardConversationId} → ${describe(blocked)}`);
        deleteProtectedConversationId = guardConversationId;
        deleteProtectedRunId = pending.runId;
        deleteProtectedTaskId = pending.taskId;
        break;
      }
      // 被 worker 领走后会话不再「执行中」判定的口径会变，换一个会话重试
      console.warn(`【8/9】删除保护：会话 ${guardConversationId} 未被挡住（${describe(blocked)}），重试`);
      await waitForRunTerminal(pending.runId, 60_000);
    }
    assert(deleteProtectedConversationId > 0, "连续 3 次都没能造出「有 pending Run 的会话」来验删除保护");

    // 把 Run 打成终态（顺带同步 Task），DELETE 应变成 200
    const now = shanghaiNow();
    await prisma.agentRun.update({
      where: { id: deleteProtectedRunId },
      data: { status: "cancelled", errorType: "smoke_terminal", finishedAt: now },
    });
    await prisma.task.update({
      where: { id: deleteProtectedTaskId },
      data: { status: "failed", progress: 0, finishedAt: now },
    });
    const deleted = await api<unknown>(token, `/api/agent/conversations/${deleteProtectedConversationId}`, {
      method: "DELETE",
    });
    console.log(`【8/9】删除保护：Run 转终态后 DELETE → ${describe(deleted)}`);
    assert(deleted.status === 200, `Run 已是终态时应能删除会话，实际 ${deleted.status}`);
    const stillThere = await prisma.agentConversation.findUnique({ where: { id: deleteProtectedConversationId } });
    assert(stillThere === null, `DELETE 返回 200 但会话 ${deleteProtectedConversationId} 还在库里`);
    // 已删掉的会话从待清理列表里摘掉，避免收尾时再删一次
    const deletedIndex = tracked.findIndex((entry) => entry.conversationId === deleteProtectedConversationId);
    if (deletedIndex >= 0) tracked.splice(deletedIndex, 1);
    console.log("【8/9】删除保护 通过：pending 时 409、终态后 200");

    // ========== 9) 清理 ==========
    for (const entry of [...tracked]) {
      await cleanupConversation(entry);
      tracked.splice(tracked.indexOf(entry), 1);
    }
    if (tempUserId !== null) {
      // 临时用户只有会话关联（ModelConfig / Task 之类它都没有）；会话已在上一步深删
      await prisma.user.delete({ where: { id: tempUserId } });
      console.log(`【9/9】清理：临时用户 ${tempUserId} 已删除`);
      tempUserId = null;
    }
    const after = await snapshotAgentTables();
    console.log(`【9/9】清理：基线计数 ${JSON.stringify(baseline)}`);
    console.log(`【9/9】清理：实际计数 ${JSON.stringify(after)}`);
    assert(
      Object.entries(after).every(([key, value]) => value === baseline[key]),
      `清理后各表计数应回到基线 ${JSON.stringify(baseline)}，实际 ${JSON.stringify(after)}`,
    );
    console.log("【9/9】清理 通过：基线 == 实际，脚本没有留下孤儿行");

    console.log(`\nP1-A 接口层验收全部通过（SSE 步骤耗时 ${sseElapsed}ms）`);
  } finally {
    // 失败路径也要尽力清干净：残留的 pending Run 会污染开发库、干扰下一次验收
    for (const entry of tracked) {
      try {
        await cleanupConversation(entry);
      } catch (error) {
        console.warn(`[清理] 会话 ${entry.conversationId}（${entry.label}）清理失败：${(error as Error).message}`);
      }
    }
    if (tempUserId !== null) {
      try {
        await prisma.user.delete({ where: { id: tempUserId } });
      } catch (error) {
        console.warn(`[清理] 临时用户 ${tempUserId} 删除失败：${(error as Error).message}`);
      }
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("验收失败:", error);
    process.exit(1);
  });
