# Agent 工作台 P1-B 实现计划（前端三栏界面 + SSE 实时过程）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Agent 工作台在浏览器里可用 —— `/agent` 三栏界面（左栏会话列表 / 中栏消息流 + 工具卡 / 右栏工件面板），发消息后无需刷新即可看到助手文本、工具卡与工件逐步出现。

**Architecture:** 纯前端消费已冻结的 P1-A 接口（8 个路由，实测契约以 `HANDOFF-agent-p1a.md` §三 为准）。两个数据源严格分工（设计稿 §5.3）：首屏/重同步 = 服务端快照**整体替换**；SSE = 逐帧**身份幂等归并**。归并逻辑（快照、事件帧、SSE 缓冲解析、reducer）全部是纯函数，放 `src/lib/agent/agent-state.ts`，用现有 vitest 覆盖（D25：项目不引前端测试栈；项目 vitest 为 `environment: "node"` + `include: ["src/**/*.test.ts"]`）。

**Tech Stack:** Next.js 15.5 App Router（客户端组件）/ React 19 / antd 6 / TypeScript 5.9（strict）/ vitest 3

**设计依据:**
- `docs/superpowers/specs/2026-10-09-agent-workspace-p1-design.md`（P1 设计稿，重点 §五、§7.2、D19–D25）
- `docs/superpowers/HANDOFF-agent-p1a.md`（**接口实测契约**：§三 是唯一权威；§五 本机陷阱）
- `docs/superpowers/HANDOFF-agent-p1-remaining.md`（B 块范围与验收对账）

**前置:** A 块已完成并推送。开工前跑基线，必须是 24 文件 / 248 用例全绿、`tsc --noEmit` 干净：

```bash
npx vitest run          # 期望 Test Files 24 passed / Tests 248 passed
npx tsc --noEmit        # 期望无输出
```

> **关于各 Task 里的用例数**：下面的期望值是编写计划时的快照。每完成一个任务都会新增用例，因此**执行时以「全绿」为准**；数字对不上先确认新测试是否被收集（vitest 只收 `src/**/*.test.ts`），不要当成回归。

**本计划只覆盖 B 块**（前端）。C 块（7 个新工具）另有计划。

### 执行进度

| 任务 | 状态 | 提交 |
|---|---|---|
| Task 1 契约类型 + 首屏快照归并 | ✅ 已验收 | `1a8b1fc`（跟进项并入后续提交） |
| Task 2 SSE 增量归并（幂等） | ✅ 已验收 | `bc08ae1`（含 Task 1 审查跟进） |
| Task 3 SSE 缓冲解析 + reducer 包装 | ✅ 已验收 | `3b34104`（含 Task 2 审查跟进） |
| Task 3 补丁（质量审查修复） | ✅ 已验收 | `5ee0c40` |
| Task 4 API 封装（6 个函数） | ✅ 已验收 | `10f4bc9`（跟进项并入 Task 5） |
| Task 5 use-agent-events（SSE + 重连） | ✅ 已验收 | `a4efbd5`（含 Task 4 审查跟进） |
| Task 5 补丁（质量审查修复） | ✅ 已验收 | `3878c73` |
| Task 6 conversation-list | ✅ 已验收 | `ea5df90`（跟进项并入 Task 7） |
| Task 7 message-stream + message-bubble | ✅ 已验收 | `6b33cfb`（含 Task 6 审查跟进） |
| Task 7 补丁（质量审查修复） | ✅ 已验收 | `9faaf01` |
| Task 8 tool-call-card + thinking-indicator | ✅ 已验收 | `f702b4b` |
| Task 8 补丁（质量审查修复） | ✅ 已验收 | `fe6e425` |
| Task 9 artifact-panel + artifact-card | ✅ 已验收 | `15f90f3`（跟进项并入 Task 10） |
| Task 10 /agent 页面 + 侧边栏入口 | ✅ 已验收 | `9811360`（含 Task 9 审查跟进） |
| Task 10 补丁（质量审查修复） | ✅ 已验收 | `7973542` |
| Task 11 工具卡验收夹具（blocked / failed） | 🔶 实现完成，待补丁复审 | `ac2ec36` |
| Task 11 补丁（质量审查修复） | ⬜ 未开始 | |
| Task 12 浏览器端到端验收 + 全量回归 + 交接文档 | ⬜ 未开始 | |

**当前基线**：25 文件 / 290 用例全绿，`tsc --noEmit` 无输出。

---

## 一、必读硬约束（实测所得，违反必返工）

| # | 约束 | 出处 |
|---|---|---|
| 1 | **四条渲染规则**：① `messages` 只含 user 消息，助手文本一律来自 `events`（首屏）与 SSE；② `events` 里不含 artifact、也不含 `tool_execution_*`（首屏回放）；③ `message_end` 的 `payload.text` 是**可选**的 —— 必须同时判 `payload.role === "assistant"` 与 `text` 非空，否则出空白气泡；④ 容忍「有帧无卡」（回填落库也失败时该帧确实没有行） | P1A 交接 §3.1 |
| 2 | **工具卡按 `runId:toolCallId` 复合键归并**，不能只用 `toolCallId` —— provider 每个 Run 重置调用计数（每个 Run 都有 `call_1`），只用它会让同会话两个 Run 的卡片互相覆盖 | `stream-events.ts` 的 `toolCallSummaryKey` |
| 3 | **前端不得 import `skill-catalog.ts`**（会把 prisma 打进客户端包）；工具卡摘要一律用服务端算好的 `summary`（首屏 DTO 的 `summary` 字段 / SSE `tool_execution_end` 载荷的 `summary`） | 设计稿 D21 |
| 4 | **时间字段是「朴素上海墙钟」`YYYY-MM-DDTHH:mm:ss`**：字符串字典序即时间序；展示用 `.slice(11, 16)`，**不要 `new Date(...)` 解析**（非上海时区的浏览器会显示错） | `core/time.ts` 文件头 |
| 5 | **SSE 必须用 `fetch` + `Authorization: Bearer`**（`EventSource` 带不了自定义头）；帧格式 `data: <json>\n\n`，`id` 在 JSON 载荷里，手工解析；心跳 `: ping` 以冒号开头，解析时天然跳过 | P1A 交接 §3.2 |
| 6 | **SSE 推全部事件类型**（一次运行约 1400 帧，绝大多数是 `message_update`/`message_start` 噪声）——必须忽略未知类型；**别把 `agent_end` 滤掉**（它是前端唯一可靠的结束信号）；服务端不会主动关流 | P1A 交接 §3.2 与 §六 |
| 7 | **工具调用的 4 种状态**（`agent_tool_calls.status`）：`running` / `succeeded` / `failed` / `blocked`；短路未执行的调用是 `failed` + `error_type="not_executed"`（摘要形如「未执行：…」） | `persist.ts:149`、`agent-loop.mts` 回填 |
| 8 | **停 worker 必须按进程树清**（`TaskStop` / 杀父进程都杀不掉子 `node`；残留 worker 会用旧代码领任务，制造「改了代码行为没变」的假象） | P1A 交接 §五.1 |
| 9 | **跑 `next build` 前先停 dev server**（build 会覆盖 dev 的 `.next` → 未编译过的路由稳定 500；修法：停 dev → `rm -rf .next` → 再起 dev） | P1A 交接 §五.2 |
| 10 | **命令行传中文会损坏字节、多行 `tsx -e` 只跑首行** —— 需要中文请求体时写 UTF-8 文件再 `curl --data-binary @file` | P1A 交接 §五.3/4 |
| 11 | **风格以计划里的代码块为准**：B 块新增文件的代码块统一用**分号**、双引号、2 空格缩进、**中文注释**（与 `src/lib/api.ts` / `src/components/ui/route-guards.tsx` 一致）。仓库里 `app-shell.tsx` / `polling.ts` 的无分号是历史个例 —— **不要**据此改写代码块 | CLAUDE.md 原则 2 |
| 12 | **提交信息用 `feat(agent-ui): …` / `test(agent-ui): …` / `docs(agent): …`**；每个 Task 一次提交 | A 计划体例 |

---

## 二、与设计稿 / 交接文档的偏差（本计划为准，均已核实）

| # | 原方案 | 实际情况 | 本计划采用 |
|---|---|---|---|
| D1 | 设计稿 §5.3：「SSE 只处理 `id > latest_event_id` 的事件」（水位门） | 快照与在途帧存在竞态：重同步的响应返回时，连接里可能还有 **id 小于快照水位**的帧在飞（典型：用户恰在运行结束时刷新页面，`agent_end` 帧在途期间快照到达）。按水位丢弃会让 `agent_end` 永久丢失 —— 它是唯一可靠的结束信号，丢了 UI 就卡在「执行中」直到下一次重同步 | **改为身份幂等归并**：时间线条目按事件 id 去重、工具卡按 `runId:toolCallId` 归并、工件按 `event_id` 去重。「重复应用同一帧，状态不变」使水位门不再必要。`lastEventId` 只承担重连起点 + 单调推进（噪声帧也要推进） |
| D2 | 设计稿 §5.3 状态树 `{ messages, toolCalls, artifacts, runStatus }` | 工具卡必须与助手文本按时间**穿插**（中栏是一条流），拆成两个数组得在渲染前再做一次归并排序 | 状态树 `{ conversation, timeline, artifacts, runStatus, lastEventId, *_truncated }`，其中 `timeline` 是已排好序的四类条目（user / assistant / notice / tool）。字段语义等价 |
| D3 | 设计稿 §5.3 的 `nextPollInterval(state) → number` | A 块实现是 `nextPollInterval(hasActiveRun: boolean)`，已落地并有单测 | 前端按**布尔入参**使用：它决定 **SSE 重连间隔**（服务端用它决定查库节奏，同一函数不漂移） |
| D4 | 设计稿 §5.4「新消息到达时若用户已手动上滚，则暂停自动滚动并提示」 | 无偏差，但要落到实现细节 | `message-stream` 用「距底 40px 内视为跟随」判定 + 「有新消息 ↓」按钮 |
| D5 | 交接文档列了 8 个前端文件 | 实际还需要 3 类文件：纯函数模块与其测试（D25 明确要求）、`src/types/index.ts` 与 `src/lib/api.ts` 的追加（项目约定：API 类型与封装都在这两处，见 `fetchXhsOverview` 等 100+ 个同族函数） | 12 个新文件 + 3 个修改（见 §三） |
| D6 | §7.2 第 3 条要求「阻断」状态渲染正确但**生产不可达** | 交接文档明确「照实现即可，验收时演示不出来」 | 照实现 + 单测覆盖状态映射，**并额外提供一个验收夹具脚本**（往 dev 库插 `blocked` / `failed` 夹具行，刷新即可看到对应状态的卡，用完即删）—— 让第 3 条可见、确定地验收（`failed` 靠真实工具报错不稳定，一并夹具化） |
| D7 | 设计稿 D20 右栏常驻 + 接口 6「仅供右栏单独刷新」 | 接口 6 需要有入口才能被验收 | 工件面板右上角加一个刷新按钮（`ReloadOutlined`），接接口 6 |
| D8 | 设计稿把 SSE 当作唯一的实时通道 | 存在一个重连补不回来的毫秒级窗口：worker 先落 `agent_end`、后写 Run 终态，快照恰在窗口内返回时水位越过 `agent_end`（Task 1 质量审查发现） | 前端在执行中每 5s 发一次 `runStatus` 动作，用接口 3 的 `runs` **只校正执行状态**（不动时间线/水位、不重连）；空闲即停 |
| D9 | 计划原把工具卡的展示派生写在组件内联 | Task 8 质量审查指出：状态映射的兜底分支在编译期抓不到（`Record<string, …>`）、截断/序列化有多处边界，而「4 种状态可辨识」是 §7.2 第 3 条的验收项，却没有任何自动化守卫 | 抽成 `src/lib/agent/tool-card-view.ts` 纯函数 + vitest（D25 的取向）；组件只做渲染 |

---

## 三、文件结构

**新增（纯函数，无 React、无服务端依赖，vitest 覆盖）**

| 文件 | 职责 |
|---|---|
| `src/lib/agent/agent-state.ts` | 前端状态归并的唯一真相源：快照替换（`applyFirstScreen`）、事件帧幂等归并（`applyEventFrame`）、SSE 缓冲解析（`parseSseBuffer`）、reducer 包装（`agentReducer`）与若干纯工具 |
| `src/lib/agent/agent-state.test.ts` | 上者的单测（D25） |
| `src/lib/agent/tool-card-view.ts` | 工具卡的展示派生纯函数（状态映射 / 耗时格式 / 截断与序列化）；Task 8 审查后从组件里抽出，取得 vitest 覆盖 |
| `src/lib/agent/tool-card-view.test.ts` | 上者的单测（含 §7.2 第 3 条「4 种状态可辨识」的自动化守卫） |

**新增（前端）**

| 文件 | 职责 |
|---|---|
| `src/components/agent/use-agent-events.ts` | SSE 订阅 + 断线重连（间隔 = `nextPollInterval`） |
| `src/components/agent/conversation-list.tsx` | 左栏：会话列表 + 新建 + 执行中标记 |
| `src/components/agent/message-stream.tsx` | 中栏：时间线渲染 + 自动滚动 + 「有新消息」 |
| `src/components/agent/message-bubble.tsx` | 用户 / 助手气泡 |
| `src/components/agent/tool-call-card.tsx` | 工具卡：4 种状态、耗时、摘要、可展开详情 |
| `src/components/agent/thinking-indicator.tsx` | 执行中态 |
| `src/components/agent/artifact-panel.tsx` | 右栏：常驻 + 空态（D20）+ 单独刷新（接口 6） |
| `src/components/agent/artifact-card.tsx` | 工件卡：点击跳对应模块（用服务端给的 `href`） |
| `src/app/(protected)/agent/page.tsx` | 三栏容器 + 全部接线（首屏 / 发送 / 取消 / 重同步） |
| `src/scripts/agent-ui-seed-toolcard.ts` | 「被阻断 / 失败」工具卡的验收夹具（加/删夹具行） |

**修改**

| 文件 | 改动 |
|---|---|
| `src/types/index.ts` | 追加 Agent 工作台契约类型（snake_case，镜像 `src/app/api/agent/shared.ts` 的 `Serialized*`） |
| `src/lib/api.ts` | 追加 6 个接口封装（列表 / 新建 / 首屏 / 发消息 / 取消 / 工件） |
| `src/components/layout/app-shell.tsx` | `mainNavItems` 加一级入口「Agent 工作台」→ `/agent`（第 55-73 行的数组开头） |

---

## 四、任务

### Task 1: 契约类型 + 首屏快照归并

**Files:**
- Modify: `src/types/index.ts`（追加到文件末尾）
- Create: `src/lib/agent/agent-state.ts`
- Test: `src/lib/agent/agent-state.test.ts`

**定位**：契约类型必须与 `src/app/api/agent/shared.ts` 的 `Serialized*` 一一对应（前端不能 import 那个目录 —— 它是服务端路由层）；快照归并解决「刷新后历史完整」（§7.2 第 5 条）。

- [ ] **Step 1: 追加契约类型（`src/types/index.ts` 文件末尾）**

```ts
// ---------- Agent 工作台（P1-B）----------
// 形状与 src/app/api/agent/shared.ts 的 Serialized* 一一对应（手工同步 —— 前端不 import
// 服务端路由层）。字段一律 snake_case（P0 D13）。时间字符串是「朴素上海墙钟」
// YYYY-MM-DDTHH:mm:ss：字典序即时间序，展示直接切片，不要 new Date() 解析。

export type AgentConversation = {
  id: number;
  title: string;
  status: string; // idle | running | archived
  created_at: string;
  updated_at: string;
};

export type AgentMessageItem = {
  id: number;
  role: string;
  content: string;
  run_id: number | null;
  tool_call_id: string | null;
  created_at: string;
};

export type AgentEventItem = {
  id: number;
  run_id: number;
  type: string;
  payload: Record<string, unknown>;
  created_at: string;
};

export type AgentToolCallItem = {
  id: number;
  run_id: number;
  step_index: number;
  tool_name: string;
  tool_call_id: string;
  params: Record<string, unknown>;
  result: Record<string, unknown> | null;
  result_truncated: boolean;
  status: string; // running | succeeded | failed | blocked
  error_type: string | null;
  duration_ms: number | null;
  summary: string;
  created_at: string;
};

export type AgentArtifactItem = {
  event_id: number;
  run_id: number;
  kind: string; // draft | topic | image | review | report | script
  id: number;
  title: string;
  href: string;
  created_at: string;
};

export type AgentRunItem = {
  id: number;
  conversation_id: number;
  task_id: number;
  status: string; // pending | running | succeeded | failed | cancelled
  step_count: number;
  max_steps: number;
  tokens_used: number;
  token_budget: number;
  error_type: string | null;
  created_at: string;
  finished_at: string | null;
};

/** GET /api/agent/conversations/[id] 的首屏契约（十个字段，P1A 交接 §3.1） */
export type AgentConversationDetail = {
  conversation: AgentConversation;
  messages: AgentMessageItem[];
  events: AgentEventItem[];
  tool_calls: AgentToolCallItem[];
  artifacts: AgentArtifactItem[];
  latest_event_id: number;
  runs: AgentRunItem[];
  events_truncated: boolean;
  tool_calls_truncated: boolean;
  artifacts_truncated: boolean;
};

/** POST /api/agent/conversations/[id]/messages 的响应 */
export type AgentSendMessageResponse = {
  conversation: AgentConversation;
  message: AgentMessageItem;
  run: AgentRunItem;
};
```

- [ ] **Step 2: 先写失败测试（`src/lib/agent/agent-state.test.ts` 新建）**

```ts
import { describe, expect, it } from "vitest";
import type {
  AgentArtifactItem,
  AgentConversation,
  AgentConversationDetail,
  AgentEventItem,
  AgentMessageItem,
  AgentRunItem,
  AgentToolCallItem,
} from "@/types";
import {
  applyFirstScreen,
  createInitialState,
  isActiveRunStatus,
  toolCardKey,
  upsertConversation,
} from "./agent-state";

/** 首屏快照的测试夹具：只写用例关心的字段，其余给默认值 */
function buildDetail(overrides: Partial<AgentConversationDetail> = {}): AgentConversationDetail {
  return {
    conversation: {
      id: 1,
      title: "新任务",
      status: "idle",
      created_at: "2026-10-10T10:00:00",
      updated_at: "2026-10-10T10:00:00",
    },
    messages: [],
    events: [],
    tool_calls: [],
    artifacts: [],
    latest_event_id: 0,
    runs: [],
    events_truncated: false,
    tool_calls_truncated: false,
    artifacts_truncated: false,
    ...overrides,
  };
}

function buildUserMessage(overrides: Partial<AgentMessageItem> = {}): AgentMessageItem {
  return {
    id: 1,
    role: "user",
    content: "帮我出选题",
    run_id: 1,
    tool_call_id: null,
    created_at: "2026-10-10T10:00:01",
    ...overrides,
  };
}

function buildEvent(overrides: Partial<AgentEventItem> = {}): AgentEventItem {
  return {
    id: 10,
    run_id: 1,
    type: "message_end",
    payload: { role: "assistant", text: "我先查一下热点" },
    created_at: "2026-10-10T10:00:02",
    ...overrides,
  };
}

function buildToolCall(overrides: Partial<AgentToolCallItem> = {}): AgentToolCallItem {
  return {
    id: 100,
    run_id: 1,
    step_index: 0,
    tool_name: "hot_refresh",
    tool_call_id: "call_1",
    params: {},
    result: null,
    result_truncated: false,
    status: "succeeded",
    error_type: null,
    duration_ms: 1200,
    summary: "收录 12 条热点",
    created_at: "2026-10-10T10:00:03",
    ...overrides,
  };
}

function buildArtifact(overrides: Partial<AgentArtifactItem> = {}): AgentArtifactItem {
  return {
    event_id: 20,
    run_id: 1,
    kind: "draft",
    id: 7,
    title: "《露营装备清单》",
    href: "/platforms/xhs/drafts?id=7",
    created_at: "2026-10-10T10:00:04",
    ...overrides,
  };
}

function buildRun(overrides: Partial<AgentRunItem> = {}): AgentRunItem {
  return {
    id: 1,
    conversation_id: 1,
    task_id: 1,
    status: "succeeded",
    step_count: 0,
    max_steps: 20,
    tokens_used: 0,
    token_budget: 200000,
    error_type: null,
    created_at: "2026-10-10T10:00:00",
    finished_at: null,
    ...overrides,
  };
}

describe("applyFirstScreen（首屏快照归并）", () => {
  it("空会话：状态与截断标记都取自快照，水位取 latest_event_id", () => {
    const state = applyFirstScreen(createInitialState(), buildDetail({ latest_event_id: 42 }));
    expect(state.conversation?.id).toBe(1);
    expect(state.timeline).toEqual([]);
    expect(state.artifacts).toEqual([]);
    expect(state.lastEventId).toBe(42);
    expect(state.runStatus).toEqual({ executing: false, pendingRunIds: [] });
  });

  it("用户消息来自 messages，助手文本来自 message_end 事件（渲染规则 1）", () => {
    const state = applyFirstScreen(
      createInitialState(),
      buildDetail({ messages: [buildUserMessage()], events: [buildEvent()] }),
    );
    expect(state.timeline.map((item) => item.kind)).toEqual(["user", "assistant"]);
    expect(state.timeline[1]).toMatchObject({ kind: "assistant", text: "我先查一下热点" });
  });

  it("message_end 缺 role/text 时不产生条目（渲染规则 3：空白气泡防线）", () => {
    const state = applyFirstScreen(
      createInitialState(),
      buildDetail({
        events: [
          buildEvent({ id: 11, payload: { role: "user", trimmed: true } }),
          buildEvent({ id: 12, payload: { role: "toolResult" } }),
          buildEvent({ id: 13, payload: { role: "assistant" } }),
          buildEvent({ id: 14, payload: { role: "assistant", text: "" } }),
          buildEvent({ id: 15, payload: { role: "assistant", text: 123 } }),
        ],
      }),
    );
    expect(state.timeline).toEqual([]);
  });

  it("status / error 事件变成提示行，level 归一（未知 level → info）", () => {
    const state = applyFirstScreen(
      createInitialState(),
      buildDetail({
        events: [
          buildEvent({ id: 11, type: "status", payload: { level: "info", message: "运行完成" } }),
          buildEvent({ id: 12, type: "status", payload: { level: "warning", message: "执行超过 10 分钟，已中止" } }),
          buildEvent({ id: 13, type: "error", payload: { message: "未配置默认文本模型，无法执行" } }),
          buildEvent({ id: 14, type: "status", payload: { level: "unknown", message: "级别异常" } }),
        ],
      }),
    );
    expect(state.timeline.map((item) => (item.kind === "notice" ? item.level : "?"))).toEqual([
      "info",
      "warning",
      "error",
      "info",
    ]);
  });

  it("工具卡（含 running 行）与工件原样进状态（渲染规则 2：tool_calls 不过滤 status）", () => {
    const state = applyFirstScreen(
      createInitialState(),
      buildDetail({
        tool_calls: [
          buildToolCall({ status: "running", summary: "" }),
          buildToolCall({
            id: 101,
            tool_call_id: "call_2",
            status: "blocked",
            error_type: "guard_blocked",
            summary: "需要人工确认，已阻断",
          }),
        ],
        artifacts: [buildArtifact()],
      }),
    );
    const tools = state.timeline.filter((item) => item.kind === "tool");
    expect(tools).toHaveLength(2);
    expect(tools[0]).toMatchObject({ tool: { status: "running", toolCallId: "call_1", summary: "" } });
    expect(tools[1]).toMatchObject({ tool: { status: "blocked", errorType: "guard_blocked" } });
    expect(state.artifacts).toEqual([buildArtifact()]);
  });

  it("同秒内的展示顺序：用户消息 → 事件 → 工具卡", () => {
    const sameSecond = "2026-10-10T10:00:05";
    const state = applyFirstScreen(
      createInitialState(),
      buildDetail({
        messages: [buildUserMessage({ created_at: sameSecond })],
        events: [buildEvent({ created_at: sameSecond })],
        tool_calls: [buildToolCall({ created_at: sameSecond })],
      }),
    );
    expect(state.timeline.map((item) => item.kind)).toEqual(["user", "assistant", "tool"]);
  });

  it("跨秒按 created_at 字典序排（时间序即字典序）", () => {
    const state = applyFirstScreen(
      createInitialState(),
      buildDetail({
        messages: [buildUserMessage({ created_at: "2026-10-10T10:00:09" })],
        events: [buildEvent({ created_at: "2026-10-10T10:00:10" })],
      }),
    );
    expect(state.timeline.map((item) => item.kind)).toEqual(["user", "assistant"]);
  });

  it("有未结束的 Run → executing；只有 pending 的 Run 可取消（D19）", () => {
    const state = applyFirstScreen(
      createInitialState(),
      buildDetail({
        runs: [
          buildRun({ id: 1, status: "succeeded" }),
          buildRun({ id: 2, status: "pending" }),
          buildRun({ id: 3, status: "running" }),
        ],
      }),
    );
    expect(state.runStatus.executing).toBe(true);
    expect(state.runStatus.pendingRunIds).toEqual([2]);
  });

  it("快照是整体替换：旧时间线/工件不残留，水位回退到快照值", () => {
    const first = applyFirstScreen(
      createInitialState(),
      buildDetail({ events: [buildEvent()], artifacts: [buildArtifact()], latest_event_id: 99 }),
    );
    const second = applyFirstScreen(first, buildDetail({ latest_event_id: 3 }));
    expect(second.timeline).toEqual([]);
    expect(second.artifacts).toEqual([]);
    // 有意回退（不是取 max）：快照在途期间连接可能已推了更新的帧，那些帧会被这次替换丢掉，
    // 必须靠调用方紧接着「从快照水位重连重放」补回来。见 agent-state.ts 文件头。
    expect(second.lastEventId).toBe(3);
  });

  it("截断标记进状态", () => {
    const state = applyFirstScreen(
      createInitialState(),
      buildDetail({ events_truncated: true, tool_calls_truncated: true, artifacts_truncated: true }),
    );
    expect(state.eventsTruncated).toBe(true);
    expect(state.toolCallsTruncated).toBe(true);
    expect(state.artifactsTruncated).toBe(true);
  });

  it("跨 Run 的同名 tool_call_id 用复合键区分", () => {
    const state = applyFirstScreen(
      createInitialState(),
      buildDetail({ tool_calls: [buildToolCall({ run_id: 1 }), buildToolCall({ id: 102, run_id: 2 })] }),
    );
    const keys = state.timeline.filter((item) => item.kind === "tool").map((item) => item.key);
    expect(keys).toEqual([toolCardKey(1, "call_1"), toolCardKey(2, "call_1")]);
    expect(new Set(keys).size).toBe(2);
  });
});

describe("upsertConversation / isActiveRunStatus（小工具）", () => {
  const a: AgentConversation = {
    id: 1,
    title: "A",
    status: "idle",
    created_at: "2026-10-10T10:00:00",
    updated_at: "2026-10-10T10:00:00",
  };
  const b: AgentConversation = { ...a, id: 2, title: "B" };

  it("更新的会话置顶，且不产生重复项", () => {
    const updated = { ...a, title: "A2" };
    const result = upsertConversation([a, b], updated);
    expect(result.map((item) => item.title)).toEqual(["A2", "B"]);
    expect(result).toHaveLength(2);
  });

  it("pending / running 都算未结束", () => {
    expect(isActiveRunStatus("pending")).toBe(true);
    expect(isActiveRunStatus("running")).toBe(true);
    expect(isActiveRunStatus("succeeded")).toBe(false);
    expect(isActiveRunStatus("cancelled")).toBe(false);
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

```bash
npx vitest run src/lib/agent/agent-state.test.ts
```

Expected: FAIL —— `Failed to resolve import "./agent-state"`（模块还不存在）。

- [ ] **Step 4: 实现（`src/lib/agent/agent-state.ts` 新建）**

```ts
/**
 * Agent 工作台前端状态归并（纯函数，D25：不引前端测试栈，逻辑抽出来用现有 vitest 覆盖）
 *
 * 两个输入源严格分工（设计稿 §5.3），否则会重复渲染：
 *   applyFirstScreen —— 首屏 / 重同步：服务端快照是权威，整体替换状态
 *   applyEventFrame  —— SSE 增量：按身份幂等归并（不是按事件顺序追加）
 *
 * 【为什么不做「id ≤ latest_event_id 就丢弃」的水位门】
 * 快照与在途帧存在竞态：重同步的响应返回时，连接里可能还有 id 小于快照水位的帧在飞
 * （典型场景：用户恰在运行结束时刷新页面，agent_end 帧在途期间快照到达）。按水位丢弃
 * 会让 agent_end 永久丢失 —— 它是前端唯一可靠的结束信号，丢了 UI 就卡在「执行中」。
 * 改为身份幂等：时间线条目按事件 id 去重、工具卡按 runId:toolCallId 归并、工件按 event_id
 * 去重。「重复应用同一帧，状态不变」使水位门不再必要；lastEventId 只承担重连起点与
 * 单调推进（噪声帧也要推进，否则重连会把它们整批再拉一次）。
 *
 * 【快照替换后必须重连 SSE】applyFirstScreen 把水位回退到快照的 latest_event_id
 * （不是取 max —— 快照在途期间连接推的更新帧会被替换丢掉，只能靠「从快照水位重放」补）。
 * 所以调用方在应用快照后必须立刻重连（页面的 resync 会把 streamKey +1）。
 */
import type {
  AgentArtifactItem,
  AgentConversation,
  AgentConversationDetail,
  AgentEventItem,
  AgentMessageItem,
  AgentRunItem,
  AgentToolCallItem,
} from "@/types";

/** 工具卡归并键：`runId:toolCallId` 复合键。
 *  provider 常按 Run 重置工具调用计数（每个 Run 都有 call_1），只用 toolCallId 会让同会话
 *  两个 Run 的卡片互相覆盖 —— 与服务端 toolCallSummaryKey 同口径。 */
export function toolCardKey(runId: number, toolCallId: string): string {
  return `${runId}:${toolCallId}`;
}

/** Run 是否未结束（pending / running 都算执行中） */
export function isActiveRunStatus(status: string): boolean {
  return status === "pending" || status === "running";
}

/** 工具卡的展示数据（首屏 DTO 与 SSE 帧都会归并成它） */
export interface AgentToolCard {
  runId: number;
  toolCallId: string;
  toolName: string;
  /** 本次 Run 内的调用序号；SSE 起点新建的卡片拿不到（重同步后才有） */
  stepIndex: number | null;
  /** running | succeeded | failed | blocked */
  status: string;
  summary: string;
  params: Record<string, unknown>;
  result: Record<string, unknown> | null;
  resultTruncated: boolean;
  errorType: string | null;
  durationMs: number | null;
}

/** 中栏时间线的条目：用户消息 / 助手过程文本 / 提示行 / 工具卡 */
export type AgentTimelineItem =
  | { kind: "user"; key: string; created_at: string; content: string }
  | { kind: "assistant"; key: string; created_at: string; text: string }
  | { kind: "notice"; key: string; created_at: string; level: "info" | "warning" | "error"; message: string }
  | { kind: "tool"; key: string; created_at: string; tool: AgentToolCard };

export interface AgentRunStatusView {
  /** 是否有未结束的 Run（禁用输入框、显示执行指示器、决定重连降速） */
  executing: boolean;
  /** 可取消的 Run（仅 pending，D19 只允许取消 pending）—— 决定「取消任务」按钮显隐 */
  pendingRunIds: number[];
}

export interface AgentUiState {
  conversation: AgentConversation | null;
  timeline: AgentTimelineItem[];
  artifacts: AgentArtifactItem[];
  runStatus: AgentRunStatusView;
  /** SSE 续传起点：已处理的最大事件 id（单调不减） */
  lastEventId: number;
  eventsTruncated: boolean;
  toolCallsTruncated: boolean;
  artifactsTruncated: boolean;
}

export function createInitialState(): AgentUiState {
  return {
    conversation: null,
    timeline: [],
    artifacts: [],
    runStatus: { executing: false, pendingRunIds: [] },
    lastEventId: 0,
    eventsTruncated: false,
    toolCallsTruncated: false,
    artifactsTruncated: false,
  };
}

/** 收窄 unknown → 普通对象（帧载荷里的 args / result 都可能缺失或非对象） */
function toRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function messageKey(id: number): string {
  return `m:${id}`;
}

/** 事件 id → 时间线条目键（幂等去重靠它） */
function eventKey(id: number): string {
  return `e:${id}`;
}

function normalizeLevel(value: unknown): "info" | "warning" | "error" {
  return value === "warning" || value === "error" ? value : "info";
}

/**
 * 事件行 → 时间线条目（助手文本 / 提示行）；不可渲染的返回 null。
 *
 * message_end 的 text 是**可选**的（渲染规则 3）：Pi 对 user / toolResult / system 也发
 * message_end，且升级前落库的旧行只有 { role, trimmed } —— 必须同时判 role 与 text，
 * 否则会出空白气泡。
 */
function timelineItemFromEvent(event: AgentEventItem): AgentTimelineItem | null {
  if (event.type === "message_end") {
    if (event.payload.role !== "assistant") return null;
    const text = event.payload.text;
    if (typeof text !== "string" || text.length === 0) return null;
    return { kind: "assistant", key: eventKey(event.id), created_at: event.created_at, text };
  }
  if (event.type === "status") {
    const message = typeof event.payload.message === "string" ? event.payload.message : "";
    if (!message) return null;
    return {
      kind: "notice",
      key: eventKey(event.id),
      created_at: event.created_at,
      level: normalizeLevel(event.payload.level),
      message,
    };
  }
  if (event.type === "error") {
    const message = typeof event.payload.message === "string" ? event.payload.message : "";
    if (!message) return null;
    return { kind: "notice", key: eventKey(event.id), created_at: event.created_at, level: "error", message };
  }
  return null;
}

function toolCardFromDto(row: AgentToolCallItem): AgentToolCard {
  return {
    runId: row.run_id,
    toolCallId: row.tool_call_id,
    toolName: row.tool_name,
    stepIndex: row.step_index,
    status: row.status,
    summary: row.summary,
    params: row.params,
    result: row.result,
    resultTruncated: row.result_truncated,
    errorType: row.error_type,
    durationMs: row.duration_ms,
  };
}

/**
 * 同秒内的展示次序：用户消息 → 事件（助手文本 / 提示）→ 工具卡。
 * created_at 只到秒（YYYY-MM-DDTHH:mm:ss），同秒碰撞时靠 rank + 各自表内的自增 id
 * 排出确定性顺序。
 * 已知局限：同秒内「工具执行完 → 下一条助手文本」仍会把文本排在卡片前
 * （只影响首屏 / 重同步回放的观感；直播流按到达顺序追加，不受影响）。
 */
const SOURCE_RANK = { user: 0, event: 1, tool: 2 } as const;

function buildTimeline(detail: AgentConversationDetail): AgentTimelineItem[] {
  const sortables: Array<{
    created_at: string;
    rank: number;
    id: number;
    item: AgentTimelineItem | null;
  }> = [];

  for (const message of detail.messages) {
    sortables.push({
      created_at: message.created_at,
      rank: SOURCE_RANK.user,
      id: message.id,
      item: {
        kind: "user",
        key: messageKey(message.id),
        created_at: message.created_at,
        content: message.content,
      },
    });
  }
  for (const event of detail.events) {
    sortables.push({
      created_at: event.created_at,
      rank: SOURCE_RANK.event,
      id: event.id,
      item: timelineItemFromEvent(event),
    });
  }
  for (const toolCall of detail.tool_calls) {
    sortables.push({
      created_at: toolCall.created_at,
      rank: SOURCE_RANK.tool,
      id: toolCall.id,
      item: {
        kind: "tool",
        key: toolCardKey(toolCall.run_id, toolCall.tool_call_id),
        created_at: toolCall.created_at,
        tool: toolCardFromDto(toolCall),
      },
    });
  }

  sortables.sort((left, right) => {
    if (left.created_at !== right.created_at) return left.created_at < right.created_at ? -1 : 1;
    if (left.rank !== right.rank) return left.rank - right.rank;
    return left.id - right.id;
  });

  return sortables.filter((entry) => entry.item !== null).map((entry) => entry.item as AgentTimelineItem);
}

/** 首屏 / 重同步：服务端快照是权威，整体替换（含水位与截断标记） */
export function applyFirstScreen(state: AgentUiState, detail: AgentConversationDetail): AgentUiState {
  return {
    conversation: detail.conversation,
    timeline: buildTimeline(detail),
    artifacts: detail.artifacts,
    runStatus: {
      executing: detail.runs.some((run) => isActiveRunStatus(run.status)),
      pendingRunIds: detail.runs.filter((run) => run.status === "pending").map((run) => run.id),
    },
    // 有意回退（不是 Math.max）：见文件头「快照替换后必须重连 SSE」
    lastEventId: detail.latest_event_id,
    eventsTruncated: detail.events_truncated,
    toolCallsTruncated: detail.tool_calls_truncated,
    artifactsTruncated: detail.artifacts_truncated,
  };
}

/** 会话列表的局部更新（新建 / 发消息后标题派生 / 列表刷新）：更新的会话置顶（按 updated_at 倒序） */
export function upsertConversation(items: AgentConversation[], conversation: AgentConversation): AgentConversation[] {
  return [conversation, ...items.filter((item) => item.id !== conversation.id)];
}

/**
 * 时间线里按键查重（幂等插入的前提）。
 * 帧的量级：一轮约 1400 帧、时间线至多几百条 —— 线性扫描足够，不必建索引。
 */
function hasTimelineKey(state: AgentUiState, key: string): boolean {
  return state.timeline.some((item) => item.key === key);
}
```

> 说明：`hasTimelineKey` 在 Task 2 才会被用到 —— 一起写进来避免 Task 2 再改文件头。
> 上面的 `@/types` import 列表**一次性写全**（`AgentMessageItem` / `AgentRunItem` 到 Task 3 的
> `AgentAction` 才用到）—— 不要因为「暂时没用到」把它们删掉，Task 3 会直接用。

- [ ] **Step 5: 跑测试确认通过**

```bash
npx vitest run src/lib/agent/agent-state.test.ts
```

Expected: PASS（13 个用例）。若报 `hasTimelineKey is declared but never used` 之类的提示：本项目没开 `noUnusedLocals`，可忽略。

- [ ] **Step 6: 类型检查**

```bash
npx tsc --noEmit
```

Expected: 无输出。

- [ ] **Step 7: 提交**

```bash
git add src/types/index.ts src/lib/agent/agent-state.ts src/lib/agent/agent-state.test.ts
git commit -m "feat(agent-ui): 首屏快照归并（契约类型 + 时间线构建/排序）"
```

---

### Task 2: SSE 增量归并（身份幂等）

**Files:**
- Modify: `src/lib/agent/agent-state.ts`（文件末尾追加）
- Test: `src/lib/agent/agent-state.test.ts`（追加 describe）

**定位**：这是「无需刷新即可看到工具卡与助手文字逐步出现」（§7.2 第 2 条）的核心：帧 → 状态。幂等规则见文件头。

- [ ] **Step 0: 先落地 Task 1 质量审查的 4 项跟进（与 Task 2 同一次提交）**

这四项来自 Task 1 的代码质量审查（结论是 Yes，跟进项随本任务落地）：

**(a) 补一条排序兜底用例** —— 排序三元组的第三段（同秒同 rank 时按各自自增 id 升序）目前没有用例覆盖，而它正是生产里最常见的同秒碰撞分支。在测试文件里追加：

```ts
describe("同秒同 rank 的兜底排序（id 升序）", () => {
  it("同秒内的多条消息/多条事件按各自自增 id 升序排，且键带各自的命名空间前缀", () => {
    const sameSecond = "2026-10-10T10:00:07";
    const state = applyFirstScreen(
      createInitialState(),
      buildDetail({
        // 传入顺序故意打乱：排序必须按 id，而不是依赖数组顺序
        events: [
          buildEvent({ id: 21, created_at: sameSecond, payload: { role: "assistant", text: "晚一点的事件" } }),
          buildEvent({ id: 20, created_at: sameSecond, payload: { role: "assistant", text: "早一点的事件" } }),
        ],
        messages: [
          buildUserMessage({ id: 1, created_at: sameSecond }),
          buildUserMessage({ id: 2, created_at: sameSecond, content: "第二条" }),
        ],
      }),
    );
    expect(state.timeline.map((item) => item.kind)).toEqual(["user", "user", "assistant", "assistant"]);
    expect(state.timeline.map((item) => item.key)).toEqual(["m:1", "m:2", "e:20", "e:21"]);
    const assistantTexts = state.timeline.flatMap((item) => (item.kind === "assistant" ? [item.text] : []));
    expect(assistantTexts).toEqual(["早一点的事件", "晚一点的事件"]);
  });
});
```

**(b) 去掉 `buildTimeline` 末尾的类型断言**（把 filter+map+cast 换成一行 flatMap，让 TS 自己收窄）。把 `agent-state.ts` 里这一行：

```ts
  return sortables.filter((entry) => entry.item !== null).map((entry) => entry.item as AgentTimelineItem);
```

换成：

```ts
  return sortables.flatMap((entry) => (entry.item === null ? [] : [entry.item]));
```

**(c) 修正 `upsertConversation` 的注释**（原文说「按 updated_at 倒序」，但实现是无条件置顶 —— 注释与实现不符）。把：

```ts
/** 会话列表的局部更新（新建 / 发消息后标题派生 / 列表刷新）：更新的会话置顶（按 updated_at 倒序） */
```

换成：

```ts
/**
 * 会话列表的局部更新（新建 / 发消息后标题派生 / 列表刷新）：把更新的会话置顶。
 * 不做按 updated_at 重排 —— 现有调用方传入的必然是刚活跃的会话（新建或刚发过消息），
 * 置顶即正确；真要做通用排序另说（YAGNI）。
 */
```

**(d) 在 messages 映射处记录「不判 role 是有意为之」**（`messages` 按服务端契约只含 user 行；加 role 判断反而会掩盖契约破坏）。给 `buildTimeline` 里 messages 的循环加一行注释：

```ts
  // messages 只含 role="user" 的行（服务端契约 listConversationUserMessages）；
  // 这里**不**再判 role —— 判了只会掩盖契约破坏，而重复渲染会立刻暴露它
  for (const message of detail.messages) {
```

- [ ] **Step 1: 更新测试文件的 import，并追加失败测试（`agent-state.test.ts`）**

先把文件顶部的 import 列表改成（新增 `applyEventFrame`、服务端 `Serialized*` 类型）：

```ts
import { describe, expect, it } from "vitest";
import type {
  SerializedAgentConversation,
  SerializedAgentEvent,
  SerializedAgentMessage,
  SerializedAgentRun,
  SerializedArtifact,
  SerializedToolCall,
} from "@/app/api/agent/shared";
import type {
  AgentArtifactItem,
  AgentConversation,
  AgentConversationDetail,
  AgentEventItem,
  AgentMessageItem,
  AgentRunItem,
  AgentToolCallItem,
} from "@/types";
import {
  applyEventFrame,
  applyFirstScreen,
  createInitialState,
  isActiveRunStatus,
  toolCardKey,
  upsertConversation,
} from "./agent-state";
```

然后在文件**末尾**追加下面两个块。

**(1) 契约镜像的编译期断言** —— `src/types/index.ts` 是手工镜像 `src/app/api/agent/shared.ts` 的，加一道类型级闸门：只要服务端契约漂移（改名/必填字段增删/类型变化/键集合变化），`tsc` 直接失败，而不是等到运行时才发现：

```ts
/**
 * 契约镜像（类型级断言：本文件能编译通过即为通过）
 *
 * `import type` 在编译期完全擦除、不产生运行时依赖（shared.ts 本身也不含 prisma），
 * 所以这里只借用服务端的类型做结构比对，不会把服务端代码带进客户端包。
 */
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type SameKeys<A, B> = keyof A extends keyof B ? (keyof B extends keyof A ? true : false) : false;
/** 互为可赋值 + 键集合一致 = 结构同构（服务端新增可选字段也会被 keyof 比对拦下） */
type Mirror<A, B> = MutuallyAssignable<A, B> extends true ? SameKeys<A, B> : false;

describe("契约镜像（编译期断言）", () => {
  it("前端契约类型与服务端 shared.ts 的 Serialized* 同构（漂移 → tsc 失败）", () => {
    const mirrors: [
      Mirror<AgentConversation, SerializedAgentConversation>,
      Mirror<AgentMessageItem, SerializedAgentMessage>,
      Mirror<AgentEventItem, SerializedAgentEvent>,
      Mirror<AgentToolCallItem, SerializedToolCall>,
      Mirror<AgentArtifactItem, SerializedArtifact>,
      Mirror<AgentRunItem, SerializedAgentRun>,
    ] = [true, true, true, true, true, true];
    expect(mirrors.every(Boolean)).toBe(true);
  });
});
```

**(2) 事件帧归并用例**：

```ts
function buildFrame(overrides: Partial<AgentEventItem> = {}): AgentEventItem {
  return {
    id: 50,
    run_id: 1,
    type: "message_end",
    payload: { role: "assistant", text: "我先查一下热点" },
    created_at: "2026-10-10T10:01:00",
    ...overrides,
  };
}

function buildToolCardState() {
  return applyFirstScreen(createInitialState(), buildDetail({ latest_event_id: 40 }));
}

describe("applyEventFrame（SSE 增量归并）", () => {
  it("助手文本帧追加条目并推进水位", () => {
    const state = applyEventFrame(buildToolCardState(), buildFrame());
    expect(state.timeline).toHaveLength(1);
    expect(state.timeline[0]).toMatchObject({ kind: "assistant", text: "我先查一下热点" });
    expect(state.lastEventId).toBe(50);
  });

  it("噪声帧（message_start / message_update）不改状态但推进水位", () => {
    const before = buildToolCardState();
    const after = applyEventFrame(
      applyEventFrame(before, buildFrame({ id: 51, type: "message_start", payload: { role: "assistant" } })),
      buildFrame({ id: 52, type: "message_update", payload: { role: "assistant", trimmed: true } }),
    );
    expect(after.timeline).toEqual(before.timeline);
    expect(after.lastEventId).toBe(52);
  });

  it("水位单调：更旧的帧不回退水位", () => {
    const state = applyEventFrame(buildToolCardState(), buildFrame({ id: 10 }));
    expect(state.lastEventId).toBe(40);
  });

  it("重复应用同一帧状态不变（快照与在途帧重叠时的幂等）", () => {
    const withSnapshotEvent = applyFirstScreen(
      createInitialState(),
      buildDetail({ events: [buildEvent({ id: 50 })], latest_event_id: 50 }),
    );
    const again = applyEventFrame(withSnapshotEvent, buildFrame({ id: 50 }));
    expect(again.timeline).toEqual(withSnapshotEvent.timeline);
    expect(again).toEqual(withSnapshotEvent);
  });

  it("user / toolResult 的 message_end 不产生条目（渲染规则 3）", () => {
    const state = applyEventFrame(
      buildToolCardState(),
      buildFrame({ payload: { role: "user", trimmed: true } }),
    );
    expect(state.timeline).toEqual([]);
  });

  it("status / error 帧变提示行", () => {
    const state = applyEventFrame(
      applyEventFrame(buildToolCardState(), buildFrame({ id: 51, type: "status", payload: { level: "error", message: "运行超过墙钟上限被中止" } })),
      buildFrame({ id: 52, type: "error", payload: { message: "未配置默认文本模型，无法执行" } }),
    );
    expect(state.timeline.map((item) => (item.kind === "notice" ? item.level : "?"))).toEqual(["error", "error"]);
  });

  it("tool_execution_start 建一张运行中的卡（工具名取帧载荷）", () => {
    const state = applyEventFrame(
      buildToolCardState(),
      buildFrame({
        id: 60,
        type: "tool_execution_start",
        payload: { toolCallId: "call_1", toolName: "hot_refresh", args: { limit: 50 } },
        created_at: "2026-10-10T10:01:02",
      }),
    );
    expect(state.timeline).toHaveLength(1);
    expect(state.timeline[0]).toMatchObject({
      kind: "tool",
      key: "1:call_1",
      tool: { status: "running", toolName: "hot_refresh", params: { limit: 50 }, stepIndex: null },
    });
  });

  it("tool_execution_end 更新既有卡：状态、摘要、耗时；并吞掉 result.details", () => {
    const started = applyEventFrame(
      buildToolCardState(),
      buildFrame({ id: 60, type: "tool_execution_start", payload: { toolCallId: "call_1", toolName: "hot_refresh", args: {} } }),
    );
    const ended = applyEventFrame(
      started,
      buildFrame({
        id: 61,
        type: "tool_execution_end",
        payload: {
          toolCallId: "call_1",
          toolName: "hot_refresh",
          result: { details: { collected: 12 }, content: [] },
          isError: false,
          durationMs: 2100,
          summary: "收录 12 条热点",
        },
      }),
    );
    expect(ended.timeline).toHaveLength(1);
    expect(ended.timeline[0]).toMatchObject({
      tool: { status: "succeeded", summary: "收录 12 条热点", durationMs: 2100, result: { collected: 12 } },
    });
  });

  it("tool_execution_end 没有既有卡时新建（跨边界 / 有帧无卡的容忍）", () => {
    const state = applyEventFrame(
      buildToolCardState(),
      buildFrame({
        id: 62,
        type: "tool_execution_end",
        payload: { toolCallId: "call_9", toolName: "topic_generate", result: {}, isError: true, durationMs: 300, summary: "未执行：Tool xxx not found" },
      }),
    );
    expect(state.timeline).toHaveLength(1);
    expect(state.timeline[0]).toMatchObject({
      kind: "tool",
      key: "1:call_9",
      tool: { status: "failed", summary: "未执行：Tool xxx not found", result: null },
    });
  });

  it("旧 start 帧不会把终态卡降级回运行中", () => {
    const succeeded = applyFirstScreen(
      createInitialState(),
      buildDetail({ tool_calls: [buildToolCall({ status: "succeeded", summary: "收录 12 条热点" })] }),
    );
    const state = applyEventFrame(
      succeeded,
      buildFrame({ id: 63, type: "tool_execution_start", payload: { toolCallId: "call_1", toolName: "hot_refresh", args: {} } }),
    );
    expect(state.timeline[0]).toMatchObject({ tool: { status: "succeeded", summary: "收录 12 条热点" } });
  });

  it("artifact 帧追加工件，按 event_id 幂等", () => {
    const frame = buildFrame({
      id: 70,
      type: "artifact",
      payload: { kind: "draft", id: 7, title: "《露营装备清单》", href: "/platforms/xhs/drafts?id=7" },
    });
    const once = applyEventFrame(buildToolCardState(), frame);
    const twice = applyEventFrame(once, frame);
    expect(once.artifacts).toEqual([
      {
        event_id: 70,
        run_id: 1,
        kind: "draft",
        id: 7,
        title: "《露营装备清单》",
        href: "/platforms/xhs/drafts?id=7",
        created_at: "2026-10-10T10:01:00",
      },
    ]);
    expect(twice.artifacts).toHaveLength(1);
  });

  it("agent_end 解除执行中并清空可取消列表", () => {
    const executing = applyFirstScreen(
      createInitialState(),
      buildDetail({ runs: [buildRun({ id: 9, status: "running" })] }),
    );
    expect(executing.runStatus.executing).toBe(true);
    const ended = applyEventFrame(executing, buildFrame({ id: 80, type: "agent_end", payload: {} }));
    expect(ended.runStatus).toEqual({ executing: false, pendingRunIds: [] });
  });

  it("跨 Run 的同名 tool_call_id 归到不同卡片（不做覆盖）", () => {
    const state = applyEventFrame(
      applyFirstScreen(
        createInitialState(),
        buildDetail({ tool_calls: [buildToolCall({ run_id: 1, status: "succeeded" })] }),
      ),
      buildFrame({
        id: 90,
        run_id: 2,
        type: "tool_execution_start",
        payload: { toolCallId: "call_1", toolName: "hot_refresh", args: {} },
      }),
    );
    const tools = state.timeline.filter((item) => item.kind === "tool");
    expect(tools).toHaveLength(2);
    expect(tools.map((item) => item.key)).toEqual(["1:call_1", "2:call_1"]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npx vitest run src/lib/agent/agent-state.test.ts
```

Expected: FAIL —— 13 个新的帧归并用例全是 `applyEventFrame is not a function`；Task 1 的 13 个 + 排序补测 + 契约镜像共 15 个应通过。

- [ ] **Step 3: 实现（`src/lib/agent/agent-state.ts` 末尾追加）**

```ts
/** 工具卡补丁：字段缺省表示「本次不动」（不是清空） */
interface ToolCardPatch {
  toolName: string;
  status: string;
  params?: Record<string, unknown>;
  summary?: string;
  durationMs?: number | null;
  result?: Record<string, unknown> | null;
}

/** 按 `runId:toolCallId` 归并工具卡：不存在则新建，存在则原地更新 */
function upsertToolCard(
  state: AgentUiState,
  frame: AgentEventItem,
  toolCallId: string,
  patch: ToolCardPatch,
): AgentUiState {
  const key = toolCardKey(frame.run_id, toolCallId);
  const index = state.timeline.findIndex((item) => item.key === key);

  if (index === -1) {
    // 无卡片时新建：跨边界（start 早于快照分界、end 晚于分界）与「有帧无卡」都要能出卡
    const card: AgentToolCard = {
      runId: frame.run_id,
      toolCallId,
      toolName: patch.toolName,
      stepIndex: null,
      status: patch.status,
      summary: patch.summary ?? "",
      params: patch.params ?? {},
      result: patch.result ?? null,
      resultTruncated: false,
      errorType: null,
      durationMs: patch.durationMs ?? null,
    };
    return {
      ...state,
      timeline: [...state.timeline, { kind: "tool", key, created_at: frame.created_at, tool: card }],
    };
  }

  const existing = state.timeline[index];
  if (existing.kind !== "tool") return state;
  // 永不把终态卡片降级回「运行中」：重连重放旧 start 帧时不能让卡片退回
  if (patch.status === "running" && existing.tool.status !== "running") return state;

  const merged: AgentToolCard = {
    ...existing.tool,
    toolName: patch.toolName,
    status: patch.status,
    ...(patch.params !== undefined ? { params: patch.params } : {}),
    ...(patch.summary !== undefined ? { summary: patch.summary } : {}),
    ...(patch.durationMs !== undefined ? { durationMs: patch.durationMs } : {}),
    ...(patch.result !== undefined ? { result: patch.result } : {}),
  };
  const timeline = [...state.timeline];
  timeline[index] = { ...existing, tool: merged };
  return { ...state, timeline };
}

/** artifact 帧 → 工件条目（与服务端 serializeArtifact 同源：载荷来自 extractArtifacts） */
function appendArtifact(state: AgentUiState, frame: AgentEventItem): AgentUiState {
  const id = Number(frame.payload.id);
  if (!Number.isFinite(id) || id <= 0) return state;
  // 幂等：工件以事件 id 去重（首屏 artifacts 与 SSE artifact 帧同源同 event_id）
  if (state.artifacts.some((item) => item.event_id === frame.id)) return state;
  const artifact: AgentArtifactItem = {
    event_id: frame.id,
    run_id: frame.run_id,
    kind: typeof frame.payload.kind === "string" ? frame.payload.kind : "",
    id,
    title: typeof frame.payload.title === "string" ? frame.payload.title : "",
    href: typeof frame.payload.href === "string" ? frame.payload.href : "",
    created_at: frame.created_at,
  };
  return { ...state, artifacts: [...state.artifacts, artifact] };
}

/** SSE 增量帧：按身份幂等归并（见文件头：为什么不做水位门） */
export function applyEventFrame(state: AgentUiState, frame: AgentEventItem): AgentUiState {
  // 水位单调前进：噪声帧也要推进，否则重连会把它们整批再拉一次
  const base = frame.id > state.lastEventId ? { ...state, lastEventId: frame.id } : state;

  if (frame.type === "message_end" || frame.type === "status" || frame.type === "error") {
    const item = timelineItemFromEvent(frame);
    // 幂等：同一事件（同 key）已在首屏或前一帧里出现就不再插入
    if (!item || hasTimelineKey(base, item.key)) return base;
    return { ...base, timeline: [...base.timeline, item] };
  }

  if (frame.type === "tool_execution_start") {
    const toolCallId = typeof frame.payload.toolCallId === "string" ? frame.payload.toolCallId : "";
    if (!toolCallId) return base;
    const toolName = typeof frame.payload.toolName === "string" ? frame.payload.toolName : toolCallId;
    return upsertToolCard(base, frame, toolCallId, {
      toolName,
      params: toRecord(frame.payload.args),
      status: "running",
    });
  }

  if (frame.type === "tool_execution_end") {
    const toolCallId = typeof frame.payload.toolCallId === "string" ? frame.payload.toolCallId : "";
    if (!toolCallId) return base;
    const toolName = typeof frame.payload.toolName === "string" ? frame.payload.toolName : toolCallId;
    const details = toRecord(toRecord(frame.payload.result).details);
    return upsertToolCard(base, frame, toolCallId, {
      toolName,
      status: frame.payload.isError === true ? "failed" : "succeeded",
      summary: typeof frame.payload.summary === "string" ? frame.payload.summary : "",
      durationMs: typeof frame.payload.durationMs === "number" ? frame.payload.durationMs : null,
      result: Object.keys(details).length > 0 ? details : null,
    });
  }

  if (frame.type === "artifact") {
    return appendArtifact(base, frame);
  }

  if (frame.type === "agent_end") {
    // 循环结束的唯一可靠信号（服务端不主动关流，不能把它当噪声滤掉）。
    // 立刻解除「执行中」；pendingRunIds 一并清空 —— 结束的 Run 不可能还在 pending。
    return { ...base, runStatus: { executing: false, pendingRunIds: [] } };
  }

  // 其余（message_start / message_update / 未来新增类型）是噪声或不由本 reducer 承担
  return base;
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
npx vitest run src/lib/agent/agent-state.test.ts
```

Expected: PASS（28 个用例：Task 1 的 13 + Step 0 的排序补测 1 + 契约镜像 1 + 帧归并 13）。本任务自包含、不依赖后续任务，必须**全绿**再提交。

- [ ] **Step 5: 提交**

```bash
git add src/lib/agent/agent-state.ts src/lib/agent/agent-state.test.ts
git commit -m "feat(agent-ui): SSE 事件帧身份幂等归并（含 Task 1 审查跟进：契约镜像断言/排序补测）"
```

---

### Task 3: SSE 缓冲解析 + reducer 包装 + 右栏工件刷新

**Files:**
- Modify: `src/lib/agent/agent-state.ts`（文件末尾追加）
- Test: `src/lib/agent/agent-state.test.ts`（追加 describe）

- [ ] **Step 0: 先落地 Task 2 质量审查的 3 项跟进（与 Task 3 同一次提交）**

来自 Task 2 的代码质量审查（结论 Yes）。核心目的是把本模块赖以成立的两条性质用断言钉死，并记下直播与首屏的一处已知差异。

**(a)+(b) 加强「end 帧更新既有卡」用例**：原用例的 start 帧传 `args: {}`，导致「end 补丁不会清掉 start 的数据」这条性质没被断言；同时补一条不可变性断言（copy-on-write 是整个身份归并设计的前提）。把测试文件里 `tool_execution_end 更新既有卡：状态、摘要、耗时；并吞掉 result.details` 这条用例整体替换为：

```ts
  it("tool_execution_end 更新既有卡：状态、摘要、耗时；不吞掉 start 的数据，也不改旧状态", () => {
    const started = applyEventFrame(
      buildToolCardState(),
      buildFrame({
        id: 60,
        type: "tool_execution_start",
        payload: { toolCallId: "call_1", toolName: "hot_refresh", args: { limit: 50 } },
      }),
    );
    const ended = applyEventFrame(
      started,
      buildFrame({
        id: 61,
        type: "tool_execution_end",
        payload: {
          toolCallId: "call_1",
          toolName: "hot_refresh",
          result: { details: { collected: 12 }, content: [] },
          isError: false,
          durationMs: 2100,
          summary: "收录 12 条热点",
        },
      }),
    );
    expect(ended.timeline).toHaveLength(1);
    expect(ended.timeline[0]).toMatchObject({
      tool: {
        status: "succeeded",
        summary: "收录 12 条热点",
        durationMs: 2100,
        result: { collected: 12 },
        // 补丁里没带的字段必须原样保留（「缺省=不动」）：
        params: { limit: 50 },
        stepIndex: null,
      },
    });
    // 不可变性：上一版状态的卡片原封不动（copy-on-write 是身份归并的前提）
    expect(started.timeline[0]).toMatchObject({ tool: { status: "running", summary: "" } });
    expect(ended.timeline[0]).not.toBe(started.timeline[0]);
  });
```

**(c) 补一条「必写字段」用例**：end 补丁对 `summary` / `durationMs` / `result` 是**必写**（与其它字段的「缺省=不动」相反：非字符串摘要归一成空串、缺失耗时归一成 null）—— 这是有意的不对称，需要一条用例记录意图。追加：

```ts
  it("end 帧的摘要/耗时/结果是必写字段：非法摘要归一成空串、缺失耗时归一成 null", () => {
    const started = applyEventFrame(
      buildToolCardState(),
      buildFrame({
        id: 60,
        type: "tool_execution_start",
        payload: { toolCallId: "call_1", toolName: "hot_refresh", args: {} },
      }),
    );
    const ended = applyEventFrame(
      started,
      buildFrame({
        id: 61,
        type: "tool_execution_end",
        payload: { toolCallId: "call_1", toolName: "hot_refresh", result: {}, isError: false, summary: 123 },
      }),
    );
    expect(ended.timeline[0]).toMatchObject({
      tool: { status: "succeeded", summary: "", durationMs: null, result: null },
    });
  });
```

**(d) 在 `applyEventFrame` 的 end 分支记一处已知差异**（帧里没有 `status` / `error_type`，护栏阻断在直播期间会先显示为「失败」，重同步换成 DTO 后才是「被阻断」）。在 `status: frame.payload.isError === true ? "failed" : "succeeded",` 这一行**上方**加注释：

```ts
    // 帧里没有 status / error_type（服务端只在 agent_tool_calls 里落，SSE 出口只补 summary）：
    // 被护栏阻断的调用在直播期间会先显示为「失败」（摘要仍含「已阻断」字样），
    // 首屏 / 重同步换成 DTO 后才是「被阻断」+ 错误类型。同类差异：失败调用的展开详情
    // （错误文本）也只有 DTO 里有 —— 两处都由重同步收敛，登记在交接文档。
```

**(e) 在文件头补一句话**（旧帧按到达顺序追加在末尾，不插回 `created_at` 位置）：追加到文件头注释块**末尾**（Step 3 的 (ii) 还会在中间插一段，两处互不影响）：

```
 * 【旧帧按到达顺序追加】id ≤ 水位的旧帧若内容不在快照里仍会被归并，但它追加在时间线**末尾**
 * 而不是插回 created_at 位置 —— 实际只影响「重连后补到的边角旧帧」，它们本就贴近时间线末端。
```

- [ ] **Step 1: 更新测试文件的 import，并追加失败测试（`agent-state.test.ts` 末尾）**

先把顶部 import 列表改成（新增 `applyArtifacts`、`parseSseBuffer`）：

```ts
import { describe, expect, it } from "vitest";
import type {
  SerializedAgentConversation,
  SerializedAgentEvent,
  SerializedAgentMessage,
  SerializedAgentRun,
  SerializedArtifact,
  SerializedToolCall,
} from "@/app/api/agent/shared";
import type {
  AgentArtifactItem,
  AgentConversation,
  AgentConversationDetail,
  AgentEventItem,
  AgentMessageItem,
  AgentRunItem,
  AgentToolCallItem,
} from "@/types";
import {
  agentReducer,
  applyArtifacts,
  applyEventFrame,
  applyFirstScreen,
  createInitialState,
  isActiveRunStatus,
  parseSseBuffer,
  toolCardKey,
  upsertConversation,
} from "./agent-state";
```

然后追加：

```ts
describe("parseSseBuffer（SSE 缓冲解析，与 crawlXhsDataStream 同范式）", () => {
  it("拆出完整帧，半帧留在 rest", () => {
    const buffer = 'data: {"id":1,"run_id":1,"type":"status","payload":{"message":"a"},"created_at":"t"}\n\ndata: {"id":2,';
    const { frames, rest } = parseSseBuffer(buffer);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ id: 1, type: "status" });
    expect(rest).toBe('data: {"id":2,');
  });

  it("心跳与坏帧被跳过，不影响后续帧", () => {
    const buffer =
      ': ping\n\ndata: {bad json}\n\ndata: {"id":3,"run_id":1,"type":"agent_end","payload":{},"created_at":"t"}\n\n';
    const { frames, rest } = parseSseBuffer(buffer);
    expect(frames).toHaveLength(1);
    expect(frames[0].id).toBe(3);
    expect(rest).toBe("");
  });

  it("缺少 id / type 的对象不算帧", () => {
    const buffer = 'data: {"type":"status"}\n\ndata: null\n\n';
    expect(parseSseBuffer(buffer).frames).toEqual([]);
  });
});

describe("applyArtifacts / agentReducer（右栏刷新与 action 包装）", () => {
  it("右栏单独刷新：整体替换工件列表", () => {
    const state = applyArtifacts(applyFirstScreen(createInitialState(), buildDetail({ artifacts: [buildArtifact()] })), [
      buildArtifact({ event_id: 99, id: 8, title: "《新草稿》" }),
    ]);
    expect(state.artifacts).toEqual([buildArtifact({ event_id: 99, id: 8, title: "《新草稿》" })]);
  });

  it("runCreated：用户消息上屏、会话更新、进入执行中（可取消的是新 Run）", () => {
    const state = agentReducer(createInitialState(), {
      type: "runCreated",
      conversation: buildDetail().conversation,
      message: buildUserMessage(),
      run: buildRun({ id: 9, status: "pending" }),
    });
    expect(state.timeline).toEqual([
      { kind: "user", key: "m:1", created_at: "2026-10-10T10:00:01", content: "帮我出选题" },
    ]);
    expect(state.runStatus).toEqual({ executing: true, pendingRunIds: [9] });
  });

  it("runCreated 重复应用不会插入两条相同的用户消息（按 message id 幂等）", () => {
    const action = {
      type: "runCreated" as const,
      conversation: buildDetail().conversation,
      message: buildUserMessage(),
      run: buildRun({ id: 9, status: "pending" }),
    };
    const state = agentReducer(agentReducer(createInitialState(), action), action);
    expect(state.timeline).toHaveLength(1);
  });

  it("runCancelled：回到空闲", () => {
    const executing = agentReducer(createInitialState(), {
      type: "runCreated",
      conversation: buildDetail().conversation,
      message: buildUserMessage(),
      run: buildRun({ id: 9, status: "pending" }),
    });
    expect(agentReducer(executing, { type: "runCancelled" }).runStatus).toEqual({
      executing: false,
      pendingRunIds: [],
    });
  });

  it("clear：切会话时回到初始态（不残留上一个会话的工件与时间线）", () => {
    const dirty = applyFirstScreen(
      createInitialState(),
      buildDetail({ events: [buildEvent()], artifacts: [buildArtifact()], latest_event_id: 9 }),
    );
    expect(agentReducer(dirty, { type: "clear" })).toEqual(createInitialState());
  });

  it("runStatus 动作：只按 runs 校正执行状态，不动时间线 / 水位 / 工件（页面兜底重同步用）", () => {
    const state = applyFirstScreen(
      createInitialState(),
      buildDetail({
        events: [buildEvent({ id: 30 })],
        latest_event_id: 50,
        runs: [buildRun({ id: 1, status: "running" })],
      }),
    );
    expect(state.runStatus.executing).toBe(true);
    // 服务端说这个 Run 已经结束了（worker 补写完终态）——只校正执行状态
    const settled = agentReducer(state, { type: "runStatus", runs: [buildRun({ id: 1, status: "succeeded" })] });
    expect(settled.runStatus).toEqual({ executing: false, pendingRunIds: [] });
    expect(settled.timeline).toEqual(state.timeline);
    expect(settled.lastEventId).toBe(50);
    expect(settled.artifacts).toEqual(state.artifacts);
  });

  it("snapshot / frame 走对应的纯函数", () => {
    const withSnapshot = agentReducer(createInitialState(), {
      type: "snapshot",
      detail: buildDetail({ events: [buildEvent()], latest_event_id: 50 }),
    });
    expect(withSnapshot.timeline).toHaveLength(1);
    const withFrame = agentReducer(withSnapshot, { type: "frame", frame: buildFrame({ id: 51 }) });
    expect(withFrame.timeline).toHaveLength(2);
    expect(withFrame.lastEventId).toBe(51);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npx vitest run src/lib/agent/agent-state.test.ts
```

Expected: FAIL —— `parseSseBuffer is not a function`、`applyArtifacts is not a function`、`agentReducer is not a function`。

- [ ] **Step 3: 实现（`src/lib/agent/agent-state.ts` 末尾追加）**

```ts
/**
 * 解析 SSE 缓冲：返回完整帧与剩余半帧（与 lib/api.ts 的 crawlXhsDataStream 同范式）。
 * 服务端帧格式 `data: <json>\n\n`；心跳是 `: ping\n\n`（以冒号开头，天然不匹配 data: 前缀）。
 * 坏帧跳过：单帧损坏（截断 / 非法 JSON）不应中断整条流。
 */
export function parseSseBuffer(buffer: string): { frames: AgentEventItem[]; rest: string } {
  const lines = buffer.split("\n");
  const rest = lines.pop() ?? "";
  const frames: AgentEventItem[] = [];
  for (const line of lines) {
    if (!line.startsWith("data: ")) continue;
    try {
      const parsed: unknown = JSON.parse(line.slice(6));
      if (isAgentEventItem(parsed)) frames.push(parsed);
    } catch {
      // 坏帧跳过
    }
  }
  return { frames, rest };
}

function isAgentEventItem(value: unknown): value is AgentEventItem {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as { id?: unknown; type?: unknown };
  return typeof candidate.id === "number" && typeof candidate.type === "string";
}

/** 右栏单独刷新（接口 6 /artifacts）的结果：整体替换工件列表 */
export function applyArtifacts(state: AgentUiState, items: AgentArtifactItem[]): AgentUiState {
  return { ...state, artifacts: items };
}

/** 页面的 action 联合：都只是把纯函数接到 React 的 useReducer 上 */
export type AgentAction =
  | { type: "snapshot"; detail: AgentConversationDetail }
  | { type: "frame"; frame: AgentEventItem }
  | { type: "artifacts"; items: AgentArtifactItem[] }
  | { type: "runCreated"; conversation: AgentConversation; message: AgentMessageItem; run: AgentRunItem }
  | { type: "runCancelled" }
  | { type: "runStatus"; runs: AgentRunItem[] }
  | { type: "clear" };

export function agentReducer(state: AgentUiState, action: AgentAction): AgentUiState {
  switch (action.type) {
    case "snapshot":
      return applyFirstScreen(state, action.detail);
    case "frame":
      return applyEventFrame(state, action.frame);
    case "artifacts":
      return applyArtifacts(state, action.items);
    case "runCreated": {
      // 用户消息立刻上屏（POST 响应就是权威数据，不做乐观插入）；过程随后由 SSE 接管
      const item: AgentTimelineItem = {
        kind: "user",
        key: messageKey(action.message.id),
        created_at: action.message.created_at,
        content: action.message.content,
      };
      const timeline = state.timeline.some((entry) => entry.key === item.key)
        ? state.timeline
        : [...state.timeline, item];
      return {
        ...state,
        conversation: action.conversation,
        timeline,
        runStatus: { executing: true, pendingRunIds: [action.run.id] },
      };
    }
    case "runCancelled":
      // P1 一次只允许一个活跃 Run（服务端有 409 兜底）：取消成功即回空闲
      return { ...state, runStatus: { executing: false, pendingRunIds: [] } };
    case "runStatus":
      // 兜底校正（页面在执行中定时调用）：只按服务端最新 runs 校正执行状态 ——
      // 不动时间线 / 水位 / 工件，因此不需要重连 SSE（动机见 page.tsx 的 settleRunStatus）
      return { ...state, runStatus: runStatusFromRuns(action.runs) };
    case "clear":
      // 切会话：清空上一个会话的时间线/工件，避免加载期间显示串台数据
      return createInitialState();
    default:
      return state;
  }
}
```

**另外两处外科手术**（改的是 Task 1 已验收的代码，改完跑 Task 1 的用例确认没回归）：

**(i) 抽出 `runStatusFromRuns`，让 `applyFirstScreen` 复用它**（DRY：`runStatus` 动作也要同一套推导，两处各写一份必然漂移）。把 `applyFirstScreen` 里的：

```ts
    runStatus: {
      executing: detail.runs.some((run) => isActiveRunStatus(run.status)),
      pendingRunIds: detail.runs.filter((run) => run.status === "pending").map((run) => run.id),
    },
```

换成：

```ts
    runStatus: runStatusFromRuns(detail.runs),
```

并在 `applyFirstScreen` **上方**新增：

```ts
/** 由 Run 列表推导执行状态（applyFirstScreen 与 runStatus 动作共用，避免两处各写一份） */
export function runStatusFromRuns(runs: AgentRunItem[]): AgentRunStatusView {
  return {
    executing: runs.some((run) => isActiveRunStatus(run.status)),
    pendingRunIds: runs.filter((run) => run.status === "pending").map((run) => run.id),
  };
}
```

**(ii) 文件头补一段**（放在「快照替换后必须重连 SSE」那段之后）—— 把「竞态已被身份幂等解决」的说法限定到「连接存活期间」，并指向页面的兜底校正：

```
 * 【快照可能错过 agent_end —— 由页面的兜底校正收敛】身份幂等只覆盖「连接存活期间」的帧；
 * 还有一类跨边界的窗口救不回来：快照水位取 latest_event_id，它计入所有事件类型，而 worker
 * 先落 agent_end、后写 Run 终态（finishRun）—— 若快照恰在这个毫秒级窗口返回，会出现
 * 「executing=true 且水位已越过 agent_end」，重连也补不回结束信号。页面在执行中每 5s
 * 用 runStatus 动作按服务端 runs 校正一次（见 page.tsx 的 settleRunStatus），窗口由此收敛。
```

- [ ] **Step 4: 跑测试确认通过**

```bash
npx vitest run src/lib/agent/agent-state.test.ts
```

Expected: PASS（约 39 个用例：Task 2 收尾后的 28 + Step 0(c) 的 1 + 本任务新增的 10）。

- [ ] **Step 5: 全量单测 + 类型检查**

```bash
npx vitest run          # 期望 25 文件全绿
npx tsc --noEmit        # 期望无输出
```

- [ ] **Step 6: 提交**

```bash
git add src/lib/agent/agent-state.ts src/lib/agent/agent-state.test.ts
git commit -m "feat(agent-ui): SSE 缓冲解析 + reducer 包装 + runStatus 校正（含 Task 2 审查跟进）"
```

---

### Task 3 补丁：质量审查修复（独立提交）

**Files:**
- Modify: `src/lib/agent/agent-state.ts`
- Modify: `src/lib/agent/agent-state.test.ts`

**为什么独立提交**：Task 3 已提交（`3b34104`）后才出的质量审查结论（1 项 Important + 2 项 Minor），为可追溯性单独一笔。

- [ ] **Step 1: 修复三处**

**(1) 加强 `isAgentEventItem`**（Important：现在只判 `id`/`type`，缺 `payload` 的帧会通过守卫，然后在 `applyEventFrame` 里被解引用 → `TypeError` 让整个工作台白屏 —— 页面没有 error boundary）。把：

```ts
function isAgentEventItem(value: unknown): value is AgentEventItem {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as { id?: unknown; type?: unknown };
  return typeof candidate.id === "number" && typeof candidate.type === "string";
}
```

换成：

```ts
/**
 * 帧守卫：id / type / payload 三样齐备才算帧。
 * payload 必须是普通对象 —— applyEventFrame 会直接解引用 frame.payload.*，
 * 而页面没有 error boundary：一帧缺载荷会让整个工作台白屏（而不是跳过这一帧）。
 * 口径与 applyFirstScreen 侧用的 toRecord 一致（非 null、对象、非数组）。
 */
function isAgentEventItem(value: unknown): value is AgentEventItem {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as { id?: unknown; type?: unknown; payload?: unknown };
  return (
    typeof candidate.id === "number" &&
    typeof candidate.type === "string" &&
    candidate.payload !== null &&
    typeof candidate.payload === "object" &&
    !Array.isArray(candidate.payload)
  );
}
```

**(2) `runCreated` 改用统一推导**（Minor：action 带整个 `AgentRunItem` 却只读 `id` 并硬编码 `pendingRunIds`，签名与行为不符）。把 `agentReducer` 的 `runCreated` 分支里：

```ts
      return {
        ...state,
        conversation: action.conversation,
        timeline,
        runStatus: { executing: true, pendingRunIds: [action.run.id] },
      };
```

换成：

```ts
      return {
        ...state,
        conversation: action.conversation,
        timeline,
        // 用统一推导而不是硬编码 pendingRunIds: [run.id] —— 服务端保证新 Run 是 pending，
        // 但万一将来返回的是终态行，这里也不会把 UI 卡在错误的「执行中」
        runStatus: runStatusFromRuns([action.run]),
      };
```

**(3) 补三条用例**（Minor：把常态路径与边界钉死）：

在 `parseSseBuffer` 的 describe 里追加：

```ts
  it("缺 payload / payload 为 null 的帧被跳过（不会在 reducer 里解引用崩掉整页）", () => {
    const buffer =
      'data: {"id":1,"run_id":1,"type":"status","created_at":"t"}\n\ndata: {"id":2,"run_id":1,"type":"status","payload":null,"created_at":"t"}\n\n';
    expect(parseSseBuffer(buffer).frames).toEqual([]);
  });

  it("一次读入多帧：全部按序返回且 rest 为空（重连后单块最多 200 帧，这是常态路径）", () => {
    const frame = (id: number) =>
      `data: {"id":${id},"run_id":1,"type":"status","payload":{},"created_at":"t"}\n\n`;
    const { frames, rest } = parseSseBuffer(`${frame(1)}${frame(2)}${frame(3)}`);
    expect(frames.map((item) => item.id)).toEqual([1, 2, 3]);
    expect(rest).toBe("");
  });
```

在 `applyArtifacts / agentReducer` 的 describe 里追加：

```ts
  it("runStatus 传空 runs：回到空闲（服务端一条 Run 都没有的边界）", () => {
    const executing = agentReducer(createInitialState(), {
      type: "runCreated",
      conversation: buildDetail().conversation,
      message: buildUserMessage(),
      run: buildRun({ id: 9, status: "pending" }),
    });
    expect(agentReducer(executing, { type: "runStatus", runs: [] }).runStatus).toEqual({
      executing: false,
      pendingRunIds: [],
    });
  });
```

- [ ] **Step 2: 跑测试 + 全量 + 类型检查**

```bash
npx vitest run src/lib/agent/agent-state.test.ts   # 期望 42 passed
npx vitest run                                      # 期望 25 文件全绿
npx tsc --noEmit                                    # 期望无输出
```

- [ ] **Step 3: 提交**

```bash
git add src/lib/agent/agent-state.ts src/lib/agent/agent-state.test.ts
git commit -m "fix(agent-ui): 帧守卫补 payload 校验并补测（Task 3 质量审查修复）"
```

---

### Task 4: API 封装（`src/lib/api.ts` 追加）

**Files:**
- Modify: `src/lib/api.ts`（追加到文件末尾；import 处追加类型）

**定位**：走项目统一的 axios 实例（自动带 `Authorization`、401 自动刷新、错误统一 toast —— 页面里**不要**再重复 toast）。SSE 不走这里（流式响应必须用 fetch，见 Task 5）。

- [ ] **Step 1: 在 `src/lib/api.ts` 的 `@/types` import 列表里追加类型**

在现有 import 列表（约第 5-106 行；列表按功能分组、**不严格按字母序**）中插入 —— 把这 5 个类型作为一组放在列表**开头**（`AuthPayload` 之前）：

```ts
  AgentArtifactItem,
  AgentConversation,
  AgentConversationDetail,
  AgentRunItem,
  AgentSendMessageResponse,
```

- [ ] **Step 2: 在文件末尾追加 6 个封装**

```ts
// ---------- Agent 工作台（P1-B）----------

/** GET /api/agent/conversations 会话列表（左栏，按更新时间倒序） */
export async function fetchAgentConversations(): Promise<AgentConversation[]> {
  const response = await http.get<{ items: AgentConversation[] }>("/agent/conversations");
  return response.data.items;
}

/**
 * POST /api/agent/conversations 新建会话。
 * 请求体必须发 `{}` —— 空 body 会被 zod 判成非法（P1A 交接 §三 接口 2）。
 */
export async function createAgentConversation(title?: string): Promise<AgentConversation> {
  const response = await http.post<AgentConversation>("/agent/conversations", title ? { title } : {});
  return response.data;
}

/** GET /api/agent/conversations/[id] 首屏契约（十个字段） */
export async function fetchAgentConversation(conversationId: number): Promise<AgentConversationDetail> {
  const response = await http.get<AgentConversationDetail>(`/agent/conversations/${conversationId}`);
  return response.data;
}

/** POST /api/agent/conversations/[id]/messages 发消息建 Run；会话执行中 → 409 */
export async function sendAgentMessage(conversationId: number, content: string): Promise<AgentSendMessageResponse> {
  const response = await http.post<AgentSendMessageResponse>(`/agent/conversations/${conversationId}/messages`, {
    content,
  });
  return response.data;
}

/** POST /api/agent/runs/[runId]/cancel 取消 Run（仅 pending → 200；running / 终态 → 409） */
export async function cancelAgentRun(runId: number): Promise<AgentRunItem> {
  const response = await http.post<{ run: AgentRunItem }>(`/agent/runs/${runId}/cancel`);
  return response.data.run;
}

/** GET /api/agent/conversations/[id]/artifacts 工件列表（右栏单独刷新用） */
export async function fetchAgentArtifacts(conversationId: number): Promise<AgentArtifactItem[]> {
  const response = await http.get<{ items: AgentArtifactItem[] }>(`/agent/conversations/${conversationId}/artifacts`);
  return response.data.items;
}
```

- [ ] **Step 3: 类型检查**

```bash
npx tsc --noEmit
```

Expected: 无输出。

- [ ] **Step 4: 提交**

```bash
git add src/lib/api.ts
git commit -m "feat(agent-ui): Agent 接口封装（列表/新建/首屏/发消息/取消/工件）"
```

---

### Task 5: `use-agent-events.ts`（SSE 订阅 + 重连降速）

**Files:**
- Create: `src/components/agent/use-agent-events.ts`
- Modify: `src/lib/api.ts`（Step 0 的 Task 4 审查跟进）

**定位**：连接、解析、按 `nextPollInterval` 降速重连。**不用 EventSource**（带不了 Authorization 头）。

- [ ] **Step 0: 先落地 Task 4 质量审查的 3 项修复（`src/lib/api.ts`，与 Task 5 同一次提交）**

来自 Task 4 的代码质量审查（结论 Yes；三项都是 Minor 但值得修：一处注释指错了失败层、一处会给 5s 轮询叠 toast、一处纯空白标题会弹英文 zod 报文）。

**(1) `createAgentConversation`：修注释 + 加 trim 守卫**。把：

```ts
/**
 * POST /api/agent/conversations 新建会话。
 * 请求体必须发 `{}` —— 空 body 会被 zod 判成非法（P1A 交接 §三 接口 2）。
 */
export async function createAgentConversation(title?: string): Promise<AgentConversation> {
  const response = await http.post<AgentConversation>("/agent/conversations", title ? { title } : {});
  return response.data;
}
```

换成：

```ts
/**
 * POST /api/agent/conversations 新建会话。
 * 请求体必须发 `{}` —— 空 body 会先死在 readJson 的 JSON 解析上（400，P1A 交接 §三 接口 2），
 * 到不了 zod。
 * 标题做 trim 守卫：服务端是 `z.string().trim().min(1)`，纯空白会 422 并弹出英文 zod 报文。
 */
export async function createAgentConversation(title?: string): Promise<AgentConversation> {
  const trimmed = title?.trim();
  const response = await http.post<AgentConversation>("/agent/conversations", trimmed ? { title: trimmed } : {});
  return response.data;
}
```

**(2) `fetchAgentConversation`：加 silent 逃生口**（它会被页面执行中每 5s 的兜底轮询调用，网络抖动会每拍叠一个 toast）。把：

```ts
/** GET /api/agent/conversations/[id] 首屏契约（十个字段） */
export async function fetchAgentConversation(conversationId: number): Promise<AgentConversationDetail> {
  const response = await http.get<AgentConversationDetail>(`/agent/conversations/${conversationId}`);
  return response.data;
}
```

换成（`{ _silent } as never` 与 `fetchSavedNote` 的既有写法一致）：

```ts
/**
 * GET /api/agent/conversations/[id] 首屏契约（十个字段）。
 * silent=true 时不弹错误 toast（页面执行中的 5s 兜底轮询用；静默失败靠下一拍自愈）——
 * 与 fetchSavedNote 的 silent 逃生口同一写法。
 */
export async function fetchAgentConversation(
  conversationId: number,
  silent = false,
): Promise<AgentConversationDetail> {
  const response = await http.get<AgentConversationDetail>(`/agent/conversations/${conversationId}`, {
    _silent: silent,
  } as never);
  return response.data;
}
```

> 渲染开销说明（Task 2 质量审查的提醒）：每个帧都会让 `applyEventFrame` 返回新状态对象（噪声帧也一样），所以「一帧一次 dispatch」在理论上是一帧一次渲染 —— React 18+ 的自动批处理会把**同一个 read 块内**同步循环里的 dispatch 合并成一次渲染（一次运行的 1400 帧来自几百个块，重连后单块最多 200 帧），实测工作量可接受；`lastEventId` 走 ref（不进渲染路径）也是为此。**不要**为了「优化」把帧攒起来延迟处理 —— 那会破坏实时性。

- [ ] **Step 1: 实现**

```ts
"use client";
/**
 * Agent SSE 订阅（P1 设计稿 §4.1 / D25）
 *
 * 只用 fetch + ReadableStream，不用 EventSource —— 后者无法携带 Authorization 头
 * （P0 设计稿 §9.1 已定）。逐行解析范式与 lib/api.ts 的 crawlXhsDataStream 一致。
 *
 * 职责：
 *   1. 连接 /api/agent/conversations/[id]/events?last_event_id=N，把 data: 帧交给 onEvent
 *   2. 断线重连：间隔由 nextPollInterval(hasActiveRun) 决定（与 SSE 服务端同一个纯函数）
 *   3. agent_end 帧回调 onRunEnded（循环结束的唯一可靠信号）
 *
 * 【为什么不把 lastEventId / hasActiveRun / 回调写进依赖】
 * 它们每次渲染都会变，写进依赖会导致「每一帧都重连」。用「最新值 ref」模式：
 * 渲染期同步、重连时读取；重连只由 conversationId（会话切换/快照同步完成）与
 * streamKey（发送消息后、快照替换后主动重启）触发。
 */
import { useEffect, useRef } from "react";

import { parseSseBuffer } from "@/lib/agent/agent-state";
import { nextPollInterval } from "@/lib/agent/polling";
import { getAccessToken, refreshAccessToken } from "@/lib/api";
import type { AgentEventItem } from "@/types";

interface UseAgentEventsOptions {
  /** null = 不订阅（还没选中会话、或首屏快照尚未应用） */
  conversationId: number | null;
  /** 变化即重连（abort 旧流、用当前水位新开一条） */
  streamKey: number;
  /** 重连起点：只收 id 大于它的事件（首屏快照的 latest_event_id 或已处理的最大 id） */
  lastEventId: number;
  /** 是否还有未结束的 Run —— 决定重连间隔（500ms / 5s） */
  hasActiveRun: boolean;
  onEvent: (frame: AgentEventItem) => void;
  onRunEnded: () => void;
}

export function useAgentEvents(options: UseAgentEventsOptions): void {
  // 「最新值 ref」：渲染期同步，重连时读取；这些值的更新都不触发重连
  const lastEventIdRef = useRef(options.lastEventId);
  lastEventIdRef.current = options.lastEventId;
  const hasActiveRunRef = useRef(options.hasActiveRun);
  hasActiveRunRef.current = options.hasActiveRun;
  const onEventRef = useRef(options.onEvent);
  onEventRef.current = options.onEvent;
  const onRunEndedRef = useRef(options.onRunEnded);
  onRunEndedRef.current = options.onRunEnded;

  const { conversationId, streamKey } = options;

  useEffect(() => {
    if (!conversationId) return;
    const controller = new AbortController();
    let disposed = false;

    /** 可被 cleanup 中断的等待（卸载后不残留定时器） */
    const sleep = (ms: number): Promise<void> =>
      new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        controller.signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });

    const readStreamOnce = async (): Promise<void> => {
      const token = getAccessToken();
      console.info(`[agent] SSE 订阅会话 ${conversationId}（last_event_id=${lastEventIdRef.current}）`);
      const response = await fetch(
        `/api/agent/conversations/${conversationId}/events?last_event_id=${lastEventIdRef.current}`,
        { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: controller.signal },
      );

      if (response.status === 401) {
        // 长连接期间 access token 可能过期：刷新一次，交给外层循环重连。
        // 刷新失败（refresh token 也没了）就停流，交给路由守卫跳登录。
        try {
          await refreshAccessToken();
        } catch {
          disposed = true;
        }
        return;
      }
      if (!response.ok || !response.body) throw new Error(`SSE HTTP ${response.status}`);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        while (!disposed) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const { frames, rest } = parseSseBuffer(buffer);
          buffer = rest;
          for (const frame of frames) {
            if (disposed) return;
            onEventRef.current(frame);
            if (frame.type === "agent_end") onRunEndedRef.current();
          }
        }
      } finally {
        try {
          reader.releaseLock();
        } catch {
          // 已在关闭流程中（有挂起的 read 时 releaseLock 会抛）
        }
      }
    };

    const run = async (): Promise<void> => {
      while (!disposed) {
        try {
          await readStreamOnce();
        } catch (error) {
          if (disposed) return;
          // aborted（切会话 / 重启流）也会走到这里：disposed 已置位时会提前返回
          if (!controller.signal.aborted) console.warn("[agent] SSE 连接中断，将重连", error);
        }
        if (disposed) return;
        // 降速重连：会话空闲 5s、执行中 500ms（与 SSE 服务端共用同一个纯函数，见 lib/agent/polling.ts）
        const delay = nextPollInterval(hasActiveRunRef.current);
        console.info(`[agent] ${delay}ms 后重连 SSE（会话 ${conversationId}）`);
        await sleep(delay);
      }
    };

    void run();

    return () => {
      disposed = true;
      controller.abort();
    };
  }, [conversationId, streamKey]);
}
```

- [ ] **Step 2: 类型检查**

```bash
npx tsc --noEmit
```

Expected: 无输出。

- [ ] **Step 3: 提交**

```bash
git add src/components/agent/use-agent-events.ts src/lib/api.ts
git commit -m "feat(agent-ui): SSE 订阅 hook（含 Task 4 审查跟进：silent 逃生口与标题 trim）"
```

---

### Task 5 补丁：质量审查修复（独立提交）

**Files:**
- Modify: `src/components/agent/use-agent-events.ts`

**为什么独立提交**：Task 5 已提交（`a4efbd5`）后才出的质量审查结论（2 项 Important + 2 项 Minor，其中 Important 一项是注释与真实行为不符、一项是实测确认的监听器累积）。

- [ ] **Step 1: 修复三处**

**(1) 401 分支：改成与真实行为一致的注释 + 可读告警，并给 404/403 与非 SSE 响应加上明确处理**（Important：原注释声称「交给路由守卫跳登录」，但 `clearAuthTokens()` 不通知 `use-auth`，守卫不会重定向 —— 实际是「流停止、页面其余部分照旧」，恢复手段是手动刷新）。把：

```ts
      if (response.status === 401) {
        // 长连接期间 access token 可能过期：刷新一次，交给外层循环重连。
        // 刷新失败（refresh token 也没了）就停流，交给路由守卫跳登录。
        try {
          await refreshAccessToken();
        } catch {
          disposed = true;
        }
        return;
      }
      if (!response.ok || !response.body) throw new Error(`SSE HTTP ${response.status}`);
```

换成：

```ts
      if (response.status === 401) {
        // 长连接期间 access token 可能过期：刷新一次，交给外层循环重连。
        // 刷新失败就停流（fail-safe）：注意**路由守卫不会因此重定向** —— clearAuthTokens()
        // 不通知 use-auth，守卫只在重新 bootstrap 时才会判到未登录。所以这里的实际用户可见
        // 行为是「SSE 停止、页面其余部分照旧」，恢复手段是手动刷新页面（登记在交接文档）。
        try {
          await refreshAccessToken();
        } catch {
          console.warn("[agent] 登录状态刷新失败，SSE 已停止；刷新页面可恢复");
          disposed = true;
        }
        return;
      }
      if (response.status === 404 || response.status === 403) {
        // 会话已不存在 / 无权访问（例如在另一个标签页被删除）：停流，别做无谓的空转重连
        disposed = true;
        return;
      }
      if (!response.ok || !response.body) throw new Error(`SSE HTTP ${response.status}`);
      // 非 SSE 响应（例如 dev 环境返回了错误页）会让解析器一帧都拿不到、只剩静默重连 —— 提前给出可读原因
      if (!response.headers.get("content-type")?.includes("text/event-stream")) {
        throw new Error(`SSE 响应不是事件流：${response.headers.get("content-type") ?? "无 Content-Type"}`);
      }
```

**(2) `sleep` 的 abort 监听不要累积**（Important：`{ once: true }` 只在 abort 触发时才移除监听，而 `sleep` 每次重连都会挂一个 —— 持续断线场景下按重连频率线性累积，实测无任何告警）。把：

```ts
    /** 可被 cleanup 中断的等待（卸载后不残留定时器） */
    const sleep = (ms: number): Promise<void> =>
      new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        controller.signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
```

换成：

```ts
    /**
     * 可被 cleanup 中断的等待：正常结束时就地摘掉 abort 监听 —— 只依赖 { once: true }
     * 时监听器要等 abort 才移除，持续断线会让它按重连频率线性累积（且无任何告警）。
     */
    const sleep = (ms: number): Promise<void> =>
      new Promise((resolve) => {
        const onAbort = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          controller.signal.removeEventListener("abort", onAbort);
          resolve();
        }, ms);
        controller.signal.addEventListener("abort", onAbort, { once: true });
      });
```

**(3) 给「最新值 ref」模式补一句防误改注释**（Minor：防止后来者把它「修正」成依赖数组，那会让每帧重连）。把文件头的：

```
 * 它们每次渲染都会变，写进依赖会导致「每一帧都重连」。用「最新值 ref」模式：
 * 渲染期同步、重连时读取；重连只由 conversationId（会话切换/快照同步完成）与
 * streamKey（发送消息后、快照替换后主动重启）触发。
```

换成：

```
 * 它们每次渲染都会变，写进依赖会导致「每一帧都重连」。用「最新值 ref」模式：
 * 渲染期同步、重连时读取；重连只由 conversationId（会话切换/快照同步完成）与
 * streamKey（发送消息后、快照替换后主动重启）触发。
 * **不要**把 ref 同步改回 useEffect、更不要把值加进依赖数组 —— 后者会让每帧重连。
```

- [ ] **Step 2: 验证 + 提交**

```bash
npx tsc --noEmit        # 期望无输出
npx vitest run          # 期望 25 文件 / 290 用例（本补丁不改纯函数）

git add src/components/agent/use-agent-events.ts
git commit -m "fix(agent-ui): SSE hook 401/404 处理与 sleep 监听器泄漏（Task 5 质量审查修复）"
```

---

### Task 6: 左栏 `conversation-list.tsx`

**Files:**
- Create: `src/components/agent/conversation-list.tsx`

**验证方式**：本任务与 Task 7-9 的组件是纯展示层，验证 = `tsc` + 代码审查；**浏览器验收统一在 Task 10 接线后、Task 12 执行**。

- [ ] **Step 1: 实现**

```tsx
"use client";
/**
 * 左栏：会话列表 + 新建（P1 设计稿 §5.2）
 *
 * updated_at 是「朴素上海墙钟」字符串，直接切片展示 —— 用 new Date() 解析会在
 * 非上海时区的浏览器上显示错。
 */
import { PlusOutlined } from "@ant-design/icons";
import { Badge, Button, Empty, Typography } from "antd";

import type { AgentConversation } from "@/types";

const { Text } = Typography;

interface ConversationListProps {
  items: AgentConversation[];
  selectedId: number | null;
  loading: boolean;
  creating: boolean;
  onSelect: (id: number) => void;
  onCreate: () => void;
}

/** "2026-10-10T14:23:05" → "10-10 14:23" */
function formatListTime(value: string): string {
  return value.length >= 16 ? `${value.slice(5, 10)} ${value.slice(11, 16)}` : value;
}

export function ConversationList(props: ConversationListProps) {
  const { items, selectedId, loading, creating, onSelect, onCreate } = props;

  return (
    <div
      style={{
        width: 260,
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
        background: "#fff",
        border: "1px solid #f0f0f0",
        borderRadius: 10,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "10px 12px",
          borderBottom: "1px solid #f0f0f0",
        }}
      >
        <Text strong style={{ fontSize: 14 }}>
          会话
        </Text>
        <Button size="small" type="primary" icon={<PlusOutlined />} loading={creating} onClick={onCreate}>
          新建
        </Button>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: 8 }}>
        {!loading && items.length === 0 && (
          <div style={{ paddingTop: 32 }}>
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有会话" />
          </div>
        )}
        {items.map((item) => {
          const selected = item.id === selectedId;
          return (
            <div
              key={item.id}
              onClick={() => onSelect(item.id)}
              style={{
                padding: "8px 10px",
                marginBottom: 4,
                borderRadius: 8,
                cursor: "pointer",
                background: selected ? "#ecf0ff" : "transparent",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                {item.status === "running" && <Badge status="processing" />}
                <Text
                  ellipsis
                  style={{ flex: 1, fontSize: 13, fontWeight: selected ? 600 : 400, minWidth: 0 }}
                >
                  {item.title}
                </Text>
              </div>
              <Text type="secondary" style={{ fontSize: 11 }}>
                {formatListTime(item.updated_at)}
              </Text>
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 类型检查 + 提交**

```bash
npx tsc --noEmit
git add src/components/agent/conversation-list.tsx
git commit -m "feat(agent-ui): 左栏会话列表组件（新建 / 选中 / 执行中标记）"
```

---

### Task 7: 中栏 `message-stream.tsx` + `message-bubble.tsx`

**Files:**
- Create: `src/components/agent/message-bubble.tsx`
- Create: `src/components/agent/message-stream.tsx`
- Modify: `src/components/agent/conversation-list.tsx`（Step 0 的 Task 6 审查跟进）

**定位**：自动滚动 + 「有新消息」（设计稿 §5.4）。滚动判定用 **ref 而非 state 闭包**：effect 只在内容变化时执行，读 state 会拿到旧值。

- [ ] **Step 0: 先落地 Task 6 质量审查的 2 项跟进（`conversation-list.tsx`，与 Task 7 同一次提交）**

**(1) 截断的标题加原生 title 属性**（antd 的纯布尔 `ellipsis` 走 CSS-only 路径、不挂 tooltip；标题上限 40 字必然截断，用户悬停也读不全）。给列表项的标题 `Text` 加一个属性：

```tsx
                <Text
                  ellipsis
                  title={item.title}
                  style={{ flex: 1, fontSize: 13, fontWeight: selected ? 600 : 400, minWidth: 0 }}
                >
                  {item.title}
                </Text>
```

**(2) 首次加载显示 Spin**（面板正文在加载期间全白；项目其它列表页惯例是 `<Spin />`）。把：

```tsx
        {!loading && items.length === 0 && (
          <div style={{ paddingTop: 32 }}>
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有会话" />
          </div>
        )}
```

换成：

```tsx
        {loading && items.length === 0 && (
          <div style={{ paddingTop: 32, textAlign: "center" }}>
            <Spin size="small" />
          </div>
        )}
        {!loading && items.length === 0 && (
          <div style={{ paddingTop: 32 }}>
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有会话" />
          </div>
        )}
```

并把 antd 的 import 改成 `import { Badge, Button, Empty, Spin, Typography } from "antd";`。

- [ ] **Step 1: 实现 `message-bubble.tsx`**

```tsx
"use client";
/**
 * 用户 / 助手气泡
 *
 * created_at 是「朴素上海墙钟」字符串：直接切片 HH:mm 展示，不要 new Date() 解析。
 */
import { Typography } from "antd";

const { Text } = Typography;

interface MessageBubbleProps {
  role: "user" | "assistant";
  text: string;
  created_at: string;
}

export function MessageBubble({ role, text, created_at }: MessageBubbleProps) {
  const isUser = role === "user";
  return (
    <div style={{ display: "flex", justifyContent: isUser ? "flex-end" : "flex-start", marginBottom: 12 }}>
      <div style={{ maxWidth: "85%", minWidth: 0 }}>
        <div
          style={{
            background: isUser ? "#386bff" : "#ffffff",
            color: isUser ? "#ffffff" : "#1a1a1a",
            border: isUser ? "none" : "1px solid #f0f0f0",
            borderRadius: 10,
            padding: "8px 12px",
            fontSize: 13,
            lineHeight: 1.7,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {text}
        </div>
        <Text
          type="secondary"
          style={{ fontSize: 11, display: "block", marginTop: 2, textAlign: isUser ? "right" : "left" }}
        >
          {created_at.length >= 16 ? created_at.slice(11, 16) : ""}
        </Text>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 实现 `message-stream.tsx`**

```tsx
"use client";
/**
 * 中栏：消息流 + 自动滚动（P1 设计稿 §5.2 / §5.4）
 *
 * 自动滚动规则：用户距底 40px 内视为「跟随」，新内容到达时自动滚到底；
 * 否则暂停跟随并显示「有新消息 ↓」按钮。
 *
 * 「是否跟随」存 ref 而不是 state：滚动 effect 只在内容变化时跑，读 state 会拿到旧闭包值。
 */
import { useEffect, useRef, useState } from "react";
import { Alert, Button, Empty, Spin, Typography } from "antd";

import type { AgentTimelineItem } from "@/lib/agent/agent-state";
import { MessageBubble } from "./message-bubble";
import { ThinkingIndicator } from "./thinking-indicator";
import { ToolCallCard } from "./tool-call-card";

const { Text } = Typography;

interface MessageStreamProps {
  items: AgentTimelineItem[];
  executing: boolean;
  /** 事件或工具卡被服务端截断（只保留了最新一批） */
  truncated: boolean;
  loading: boolean;
}

export function MessageStream({ items, executing, truncated, loading }: MessageStreamProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const [hasNew, setHasNew] = useState(false);

  const handleScroll = () => {
    const element = containerRef.current;
    if (!element) return;
    const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
    atBottomRef.current = nearBottom;
    if (nearBottom) setHasNew(false);
  };

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    if (atBottomRef.current) {
      element.scrollTop = element.scrollHeight;
    } else {
      setHasNew(true);
    }
  }, [items, executing]);

  const scrollToBottom = () => {
    const element = containerRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
    atBottomRef.current = true;
    setHasNew(false);
  };

  return (
    <div style={{ flex: 1, minHeight: 0, position: "relative", display: "flex", flexDirection: "column" }}>
      <div ref={containerRef} onScroll={handleScroll} style={{ flex: 1, overflowY: "auto", padding: "16px 16px 4px" }}>
        {truncated && (
          <div style={{ textAlign: "center", marginBottom: 12 }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              更早的记录已省略（服务端仅保留最新一批事件与工具卡）
            </Text>
          </div>
        )}

        {loading && items.length === 0 && (
          <div style={{ textAlign: "center", paddingTop: 48 }}>
            <Spin />
          </div>
        )}

        {!loading && items.length === 0 && (
          <div style={{ paddingTop: 48 }}>
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有消息，输入第一条任务开始" />
          </div>
        )}

        {items.map((item) => {
          if (item.kind === "user") {
            return <MessageBubble key={item.key} role="user" text={item.content} created_at={item.created_at} />;
          }
          if (item.kind === "assistant") {
            return <MessageBubble key={item.key} role="assistant" text={item.text} created_at={item.created_at} />;
          }
          if (item.kind === "notice") {
            return (
              <Alert
                key={item.key}
                type={item.level === "error" ? "error" : item.level === "warning" ? "warning" : "info"}
                message={item.message}
                showIcon
                style={{ marginBottom: 12 }}
              />
            );
          }
          return <ToolCallCard key={item.key} tool={item.tool} />;
        })}

        {executing && <ThinkingIndicator />}
      </div>

      {hasNew && (
        <Button
          size="small"
          type="primary"
          onClick={scrollToBottom}
          style={{ position: "absolute", bottom: 12, left: "50%", transform: "translateX(-50%)" }}
        >
          有新消息 ↓
        </Button>
      )}
    </div>
  );
}
```

- [ ] **Step 3: 类型检查 + 提交**

```bash
npx tsc --noEmit      # 此时 message-stream 依赖的 tool-call-card / thinking-indicator 还没建 → 会报模块缺失，Task 8 完成后消失
```
> 若报 `Cannot find module './tool-call-card'`：**预期**，Task 8 会补上；先提交，最后一起看 tsc。

```bash
git add src/components/agent/message-bubble.tsx src/components/agent/message-stream.tsx src/components/agent/conversation-list.tsx
git commit -m "feat(agent-ui): 中栏消息流与气泡（含 Task 6 审查跟进：标题 tooltip 与加载态）"
```

---

### Task 7 补丁：质量审查修复（独立提交）

**Files:**
- Modify: `src/components/agent/message-stream.tsx`

**为什么独立提交**：Task 7 已提交（`6b33cfb`）后才出的质量审查结论（2 项 Important 都在滚动行为上，各有自包含的小修法）。

- [ ] **Step 1: 修复两处（一处是组件头部的整段替换，一处是滚动容器那一行）**

**(1) 头部整段替换**（Important 1：切会话后跟随状态不复位 → 新会话停在历史顶部并谎报「有新消息」；Minor 3：`executing` 变化或内容等价的 resync 也会弹提示 —— 用内容指纹只在真的变多时提示）。把 `message-stream.tsx` 里的：

```tsx
export function MessageStream({ items, executing, truncated, loading }: MessageStreamProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const [hasNew, setHasNew] = useState(false);

  const handleScroll = () => {
    const element = containerRef.current;
    if (!element) return;
    const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
    atBottomRef.current = nearBottom;
    if (nearBottom) setHasNew(false);
  };

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    if (atBottomRef.current) {
      element.scrollTop = element.scrollHeight;
    } else {
      setHasNew(true);
    }
  }, [items, executing]);

  const scrollToBottom = () => {
    const element = containerRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
    atBottomRef.current = true;
    setHasNew(false);
  };
```

换成：

```tsx
export function MessageStream({ items, executing, truncated, loading }: MessageStreamProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  /** 上一次渲染的内容指纹（条数 + 末条 key）：只有内容真的变多才提示「有新消息」 */
  const contentRef = useRef("");
  const [hasNew, setHasNew] = useState(false);

  const handleScroll = () => {
    const element = containerRef.current;
    if (!element) return;
    const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
    atBottomRef.current = nearBottom;
    if (nearBottom) setHasNew(false);
  };

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    // 切会话会先清空时间线（agentReducer 的 clear）：把跟随状态一并复位 ——
    // 否则在旧会话里上滚过的话，新会话会停在历史顶部并谎报「有新消息」
    // （items 为空只出现在「切会话清空」与「空会话」两种情形，运行中不会出现）
    if (items.length === 0) {
      atBottomRef.current = true;
      contentRef.current = "";
      setHasNew(false);
      return;
    }
    const fingerprint = `${items.length}:${items[items.length - 1].key}`;
    const contentChanged = fingerprint !== contentRef.current;
    contentRef.current = fingerprint;
    if (atBottomRef.current) {
      element.scrollTop = element.scrollHeight;
    } else if (contentChanged) {
      setHasNew(true);
    }
  }, [items, executing]);

  const scrollToBottom = () => {
    const element = containerRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
    atBottomRef.current = true;
    setHasNew(false);
  };
```

**(2) 滚动容器那一行：加 `onWheel` 同步信号 + 底部内边距 4→12**（Important 2：`atBottomRef` 只由异步的 scroll 事件驱动，用户上滚可能被 effect 读到旧值抹掉；Minor 4：底部留白偏挤）。把：

```tsx
      <div ref={containerRef} onScroll={handleScroll} style={{ flex: 1, overflowY: "auto", padding: "16px 16px 4px" }}>
```

换成：

```tsx
      <div
        ref={containerRef}
        onScroll={handleScroll}
        // 滚轮上滚是**同步**信号：scroll 事件要等浏览器渲染阶段才派发，若一帧恰落在
        // 「用户已改 scrollTop」与「scroll 事件派发」之间，effect 会读到旧值把上滚抹掉。
        // 所以不让 atBottomRef 只由异步 scroll 事件驱动（滚回底部仍由 handleScroll 重新开启跟随）。
        onWheel={(event) => {
          if (event.deltaY < 0) {
            atBottomRef.current = false;
          }
        }}
        style={{ flex: 1, overflowY: "auto", padding: "16px 16px 12px" }}
      >
```

- [ ] **Step 2: 验证 + 提交**

```bash
npx tsc --noEmit        # 期望仍只有那两条预期模块缺失（Task 8 未做）
npx vitest run          # 期望 25 文件 / 290 用例

git add src/components/agent/message-stream.tsx
git commit -m "fix(agent-ui): 消息流切会话复位跟随状态与上滚同步信号（Task 7 质量审查修复）"
```

---

### Task 8: `tool-call-card.tsx` + `thinking-indicator.tsx`

**Files:**
- Create: `src/components/agent/tool-call-card.tsx`
- Create: `src/components/agent/thinking-indicator.tsx`

**定位**：工具卡的 **4 种状态**必须都渲染（§7.2 第 3 条）：`running` / `succeeded` / `failed` / `blocked`。`blocked` 的数据来源是 `agent_tool_calls.status="blocked"`（首屏 DTO）。`error_type="not_executed"`（短路未执行）归在「失败」样式里，摘要自带「未执行：」前缀。

- [ ] **Step 1: 实现 `tool-call-card.tsx`**

```tsx
"use client";
/**
 * 工具卡（D21：摘要卡片，摘要由服务端算好）
 *
 * 4 种状态都要渲染正确（§7.2 第 3 条）：运行中 / 成功 / 失败 / 被护栏阻断。
 * 状态来自 agent_tool_calls.status；摘要来自服务端（前端不得 import skill-catalog）。
 */
import { useState } from "react";
import type { CSSProperties } from "react";
import { Button, Card, Tag, Typography } from "antd";

import type { AgentToolCard } from "@/lib/agent/agent-state";

const { Text } = Typography;

/** 详情区展示上限（首屏的 result 已由服务端截到 4000 字符；SSE 帧的 result 未截，这里兜底） */
const DETAIL_TEXT_LIMIT = 4000;

const STATUS_VIEW: Record<string, { color: string; label: string }> = {
  running: { color: "processing", label: "运行中" },
  succeeded: { color: "success", label: "成功" },
  failed: { color: "error", label: "失败" },
  blocked: { color: "warning", label: "被阻断" },
};

function stringifyForDisplay(value: Record<string, unknown> | null): string {
  if (!value) return "（无）";
  const text = JSON.stringify(value, null, 2);
  return text.length > DETAIL_TEXT_LIMIT ? `${text.slice(0, DETAIL_TEXT_LIMIT)}\n…（已省略）` : text;
}

export function ToolCallCard({ tool }: { tool: AgentToolCard }) {
  const [expanded, setExpanded] = useState(false);
  const view = STATUS_VIEW[tool.status] ?? { color: "default", label: tool.status };

  return (
    <Card size="small" style={{ marginBottom: 12 }} styles={{ body: { padding: 10 } }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Tag color={view.color} style={{ marginRight: 0 }}>
          {view.label}
        </Tag>
        <Text code style={{ fontSize: 12 }}>
          {tool.toolName}
        </Text>
        {tool.durationMs !== null && (
          <Text type="secondary" style={{ fontSize: 12 }}>
            {(tool.durationMs / 1000).toFixed(1)}s
          </Text>
        )}
        <span style={{ flex: 1 }} />
        <Button type="text" size="small" onClick={() => setExpanded((value) => !value)}>
          {expanded ? "收起" : "详情"}
        </Button>
      </div>

      {tool.summary && (
        <div style={{ marginTop: 6, fontSize: 13, lineHeight: 1.6 }}>{tool.summary}</div>
      )}

      {expanded && (
        <div style={{ marginTop: 8, borderTop: "1px solid #f0f0f0", paddingTop: 8 }}>
          {tool.errorType && (
            <div style={{ marginBottom: 6 }}>
              <Text type="secondary" style={{ fontSize: 12 }}>
                错误类型：{tool.errorType}
              </Text>
            </div>
          )}
          <Text type="secondary" style={{ fontSize: 12 }}>
            入参
          </Text>
          <pre style={preStyle}>{stringifyForDisplay(tool.params)}</pre>
          <Text type="secondary" style={{ fontSize: 12 }}>
            结果{tool.resultTruncated ? "（服务端已截断到 4000 字符）" : ""}
          </Text>
          <pre style={preStyle}>{stringifyForDisplay(tool.result)}</pre>
        </div>
      )}
    </Card>
  );
}

const preStyle: CSSProperties = {
  margin: "4px 0 10px",
  padding: 8,
  background: "#fafafa",
  border: "1px solid #f0f0f0",
  borderRadius: 6,
  fontSize: 12,
  lineHeight: 1.5,
  maxHeight: 240,
  overflow: "auto",
  whiteSpace: "pre-wrap",
  wordBreak: "break-all",
};
```

- [ ] **Step 2: 实现 `thinking-indicator.tsx`**

```tsx
"use client";
/** 执行中态（§5.2：思考指示器） */
import { Spin, Typography } from "antd";

const { Text } = Typography;

export function ThinkingIndicator({ label = "正在执行…" }: { label?: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
      <Spin size="small" />
      <Text type="secondary" style={{ fontSize: 13 }}>
        {label}
      </Text>
    </div>
  );
}
```

- [ ] **Step 3: 类型检查 + 提交**

```bash
npx tsc --noEmit      # 期望：只剩「/agent 页面还不存在」之外的错误清零；message-stream 的模块缺失此时应已消失
git add src/components/agent/tool-call-card.tsx src/components/agent/thinking-indicator.tsx
git commit -m "feat(agent-ui): 工具卡（4 种状态 + 展开详情）与执行指示器"
```

---

### Task 8 补丁：质量审查修复（独立提交）

**Files:**
- Create: `src/lib/agent/tool-card-view.ts`
- Create: `src/lib/agent/tool-card-view.test.ts`
- Modify: `src/components/agent/tool-call-card.tsx`

**为什么独立提交**：Task 8 已提交（`f702b4b`）后才出的质量审查结论（1 项 Important：服务端截断结果被二次转义且暴露内部字段名；4 项 Minor 值得顺手修）。抽出展示派生模块见 §二 D9。

- [ ] **Step 1: 新建 `src/lib/agent/tool-card-view.ts`**

```ts
/**
 * 工具卡的展示派生（纯函数，D25：可被 vitest 覆盖的视图逻辑）
 *
 * 放在 lib/agent/ 下与 agent-state.ts 并列：本文件不含 React / 服务端依赖，客户端可安全 import。
 * 抽出来的理由：状态映射的兜底分支在编译期抓不到（Record<string, …>），截断/序列化有多处边界，
 * 而「4 种状态可辨识」是 §7.2 第 3 条的验收项 —— 需要自动化守卫（Task 8 质量审查建议）。
 */
import type { AgentToolCard } from "./agent-state";

/**
 * 详情区展示上限（首屏的 result 已由服务端按**紧凑 JSON** 截到 4000 字符；
 * 这里的 4000 是**pretty-print 后**的字符数 —— 两者口径不同，不要「顺手统一」）。
 */
export const DETAIL_TEXT_LIMIT = 4000;

export interface ToolStatusView {
  color: string;
  label: string;
}

/** 状态 → 展示：4 种状态都必须可辨识（§7.2 第 3 条）；新增状态要在这里补一行 */
const STATUS_VIEW: Record<string, ToolStatusView> = {
  running: { color: "processing", label: "运行中" },
  succeeded: { color: "success", label: "成功" },
  failed: { color: "error", label: "失败" },
  blocked: { color: "warning", label: "被阻断" },
};

export function statusViewFor(status: string): ToolStatusView {
  return STATUS_VIEW[status] ?? { color: "default", label: status || "未知" };
}

/** 耗时（毫秒）→ 「1.2s」；非数字返回 null（不显示）—— 不用 `!== null` 判，防 undefined 漏进来变成「NaNs」 */
export function formatToolDuration(durationMs: number | null | undefined): string | null {
  return typeof durationMs === "number" ? `${(durationMs / 1000).toFixed(1)}s` : null;
}

/** 截断到上限；截断点落在代理对中间时退一格，避免渲染出 U+FFFD */
export function cutForDisplay(text: string, limit: number = DETAIL_TEXT_LIMIT): string {
  if (text.length <= limit) return text;
  let cut = text.slice(0, limit);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut}…（已省略）`;
}

/** 任意产出 → 展示文本 */
export function stringifyForDisplay(value: Record<string, unknown> | null): string {
  if (!value) return "（无）";
  let text: string;
  try {
    text = JSON.stringify(value, null, 2);
  } catch {
    // 理论上到不了（值都来自 JSON.parse）；兜一手是因为页面没有 error boundary，
    // 一次序列化异常会让整个工作台白屏
    return "（无法序列化）";
  }
  return cutForDisplay(text);
}

/**
 * 结果的展示文本。
 * 服务端截断时 result 是 `{ truncated_text: <紧凑 JSON 的前 4000 字符> }` ——
 * 直接展示那串文本：再 stringify 一次会多一层转义、并暴露内部字段名
 * （Task 8 质量审查发现的实际渲染问题）。
 */
export function resultTextForDisplay(tool: AgentToolCard): string {
  if (tool.resultTruncated && typeof tool.result?.truncated_text === "string") {
    return tool.result.truncated_text;
  }
  return stringifyForDisplay(tool.result);
}
```

- [ ] **Step 2: 新建 `src/lib/agent/tool-card-view.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import type { AgentToolCard } from "./agent-state";
import {
  cutForDisplay,
  DETAIL_TEXT_LIMIT,
  formatToolDuration,
  resultTextForDisplay,
  statusViewFor,
  stringifyForDisplay,
} from "./tool-card-view";

function buildToolCard(overrides: Partial<AgentToolCard> = {}): AgentToolCard {
  return {
    runId: 1,
    toolCallId: "call_1",
    toolName: "hot_refresh",
    stepIndex: 0,
    status: "succeeded",
    summary: "",
    params: {},
    result: null,
    resultTruncated: false,
    errorType: null,
    durationMs: null,
    ...overrides,
  };
}

describe("statusViewFor（4 种状态 + 兜底）", () => {
  it("四种状态各有可辨识的颜色与中文标签（§7.2 第 3 条）", () => {
    expect(statusViewFor("running")).toEqual({ color: "processing", label: "运行中" });
    expect(statusViewFor("succeeded")).toEqual({ color: "success", label: "成功" });
    expect(statusViewFor("failed")).toEqual({ color: "error", label: "失败" });
    expect(statusViewFor("blocked")).toEqual({ color: "warning", label: "被阻断" });
  });

  it("未知状态兜底显示原始值，空串显示「未知」（不留空白徽标）", () => {
    expect(statusViewFor("cancelled")).toEqual({ color: "default", label: "cancelled" });
    expect(statusViewFor("")).toEqual({ color: "default", label: "未知" });
  });
});

describe("formatToolDuration", () => {
  it("毫秒转秒保留一位小数；null / undefined 都不显示（不会出现「NaNs」）", () => {
    expect(formatToolDuration(2100)).toBe("2.1s");
    expect(formatToolDuration(0)).toBe("0.0s");
    expect(formatToolDuration(null)).toBeNull();
    expect(formatToolDuration(undefined)).toBeNull();
  });
});

describe("cutForDisplay / stringifyForDisplay", () => {
  it("未超上限原样返回；超上限截断并带省略标记", () => {
    expect(cutForDisplay("abc", 5)).toBe("abc");
    expect(cutForDisplay("abcdef", 3)).toBe("abc…（已省略）");
  });

  it("截断点落在代理对中间时退一格（不产生孤立代理项）", () => {
    // "😀" 占两个 UTF-16 单元：limit=2 时正好切在中间
    const out = cutForDisplay("a😀b", 2);
    expect(out).toBe("a…（已省略）");
    expect(/[\uD800-\uDBFF]/.test(out)).toBe(false);
  });

  it("null 显示「（无）」；对象 pretty-print", () => {
    expect(stringifyForDisplay(null)).toBe("（无）");
    expect(stringifyForDisplay({ collected: 12 })).toBe('{\n  "collected": 12\n}');
  });

  it(`超过 ${DETAIL_TEXT_LIMIT} 字符时截断（SSE 帧的 result 未截，这里兜底）`, () => {
    const out = stringifyForDisplay({ text: "a".repeat(DETAIL_TEXT_LIMIT) });
    expect(out.endsWith("…（已省略）")).toBe(true);
  });
});

describe("resultTextForDisplay（服务端截断的结果）", () => {
  it("resultTruncated 时直接展示 truncated_text（不再二次转义、不暴露内部字段名）", () => {
    const tool = buildToolCard({
      resultTruncated: true,
      result: { truncated_text: '{"text":"AAAA' },
    });
    expect(resultTextForDisplay(tool)).toBe('{"text":"AAAA');
  });

  it("未截断时走 pretty-print；result 为 null 显示「（无）」", () => {
    expect(resultTextForDisplay(buildToolCard({ result: { collected: 12 } }))).toBe('{\n  "collected": 12\n}');
    expect(resultTextForDisplay(buildToolCard({ result: null }))).toBe("（无）");
  });
});
```

- [ ] **Step 3: 改写 `tool-call-card.tsx`（整文件替换）**

```tsx
"use client";
/**
 * 工具卡（D21：摘要卡片，摘要由服务端算好）
 *
 * 4 种状态都要渲染正确（§7.2 第 3 条）：运行中 / 成功 / 失败 / 被护栏阻断。
 * 状态来自 agent_tool_calls.status；摘要来自服务端（前端不得 import skill-catalog）。
 * 展示派生（状态映射 / 耗时格式 / 截断与序列化）抽在 lib/agent/tool-card-view.ts，有 vitest 覆盖。
 */
import { memo, useState } from "react";
import type { CSSProperties } from "react";
import { Button, Card, Tag, Typography } from "antd";

import type { AgentToolCard } from "@/lib/agent/agent-state";
import {
  formatToolDuration,
  resultTextForDisplay,
  statusViewFor,
  stringifyForDisplay,
} from "@/lib/agent/tool-card-view";

const { Text } = Typography;

/**
 * memo：工具卡的更新是按 `tool` 对象身份保留的（upsertToolCard 只替换被更新的那张卡），
 * 其余卡片对象引用不变 —— 包一层可跳过一次流事件里其余卡片的整棵子树重渲染。
 */
export const ToolCallCard = memo(function ToolCallCard({ tool }: { tool: AgentToolCard }) {
  const [expanded, setExpanded] = useState(false);
  const view = statusViewFor(tool.status);
  const duration = formatToolDuration(tool.durationMs);

  return (
    <Card size="small" style={{ marginBottom: 12 }} styles={{ body: { padding: 10 } }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Tag color={view.color} style={{ marginRight: 0 }}>
          {view.label}
        </Tag>
        <Text code style={{ fontSize: 12 }}>
          {tool.toolName}
        </Text>
        {duration !== null && (
          <Text type="secondary" style={{ fontSize: 12 }}>
            {duration}
          </Text>
        )}
        <span style={{ flex: 1 }} />
        <Button type="text" size="small" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
          {expanded ? "收起" : "详情"}
        </Button>
      </div>

      {tool.summary && <div style={{ marginTop: 6, fontSize: 13, lineHeight: 1.6 }}>{tool.summary}</div>}

      {expanded && (
        <div style={{ marginTop: 8, borderTop: "1px solid #f0f0f0", paddingTop: 8 }}>
          {tool.errorType && (
            <div style={{ marginBottom: 6 }}>
              <Text type="secondary" style={{ fontSize: 12 }}>
                错误类型：{tool.errorType}
              </Text>
            </div>
          )}
          <Text type="secondary" style={{ fontSize: 12 }}>
            入参
          </Text>
          <pre style={preStyle}>{stringifyForDisplay(tool.params)}</pre>
          <Text type="secondary" style={{ fontSize: 12 }}>
            结果{tool.resultTruncated ? "（服务端已截断，仅存前 4000 字符的紧凑 JSON）" : ""}
          </Text>
          <pre style={preStyle}>{resultTextForDisplay(tool)}</pre>
        </div>
      )}
    </Card>
  );
});

const preStyle: CSSProperties = {
  margin: "4px 0 10px",
  padding: 8,
  background: "#fafafa",
  border: "1px solid #f0f0f0",
  borderRadius: 6,
  fontSize: 12,
  lineHeight: 1.5,
  maxHeight: 240,
  overflow: "auto",
  whiteSpace: "pre-wrap",
  wordBreak: "break-all",
};
```

- [ ] **Step 4: 验证 + 提交**

```bash
npx vitest run src/lib/agent/tool-card-view.test.ts   # 期望全绿（新增 9 个用例）
npx vitest run                                        # 期望 26 文件全绿
npx tsc --noEmit                                      # 期望无输出

git add src/lib/agent/tool-card-view.ts src/lib/agent/tool-card-view.test.ts src/components/agent/tool-call-card.tsx
git commit -m "fix(agent-ui): 工具卡展示派生抽模块并修服务端截断结果的二次转义（Task 8 质量审查修复）"
```

---

### Task 9: 右栏 `artifact-panel.tsx` + `artifact-card.tsx`

**Files:**
- Create: `src/components/agent/artifact-card.tsx`
- Create: `src/components/agent/artifact-panel.tsx`

**定位**：D20 常驻 + 空态；接口 6 的刷新入口（D7 偏差表）。跳转直接用服务端给的 `href`（如 `/platforms/xhs/drafts?id=7`），前端不做 kind→路由映射。

- [ ] **Step 1: 实现 `artifact-card.tsx`**

```tsx
"use client";
/**
 * 工件卡：点击跳对应模块
 *
 * href 由服务端拼好（skill-catalog 的 artifact.hrefPrefix + id），前端不复制映射表。
 */
import { useRouter } from "next/navigation";
import { Card, Tag, Typography } from "antd";

import type { AgentArtifactItem } from "@/types";

const { Text } = Typography;

const KIND_VIEW: Record<string, { color: string; label: string }> = {
  draft: { color: "blue", label: "草稿" },
  topic: { color: "purple", label: "选题" },
  image: { color: "magenta", label: "图片" },
  review: { color: "orange", label: "审校" },
  report: { color: "cyan", label: "报告" },
  script: { color: "geekblue", label: "脚本" },
};

export function ArtifactCard({ artifact }: { artifact: AgentArtifactItem }) {
  const router = useRouter();
  const view = KIND_VIEW[artifact.kind] ?? { color: "default", label: artifact.kind || "产出" };
  const clickable = Boolean(artifact.href);

  return (
    <Card
      size="small"
      hoverable={clickable}
      onClick={clickable ? () => router.push(artifact.href) : undefined}
      style={{ marginBottom: 8, cursor: clickable ? "pointer" : "default" }}
      styles={{ body: { padding: 10 } }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <Tag color={view.color} style={{ marginRight: 0 }}>
          {view.label}
        </Tag>
        <Text ellipsis style={{ flex: 1, fontSize: 13, minWidth: 0 }}>
          {artifact.title || `#${artifact.id}`}
        </Text>
      </div>
      <Text type="secondary" style={{ fontSize: 11 }}>
        {artifact.created_at.length >= 16 ? artifact.created_at.slice(11, 16) : ""}
      </Text>
    </Card>
  );
}
```

- [ ] **Step 2: 实现 `artifact-panel.tsx`**

```tsx
"use client";
/**
 * 右栏：工件面板（D20 常驻 + 空态；接口 6 仅供右栏单独刷新）
 */
import { ReloadOutlined } from "@ant-design/icons";
import { Button, Empty, Typography } from "antd";

import type { AgentArtifactItem } from "@/types";
import { ArtifactCard } from "./artifact-card";

const { Text } = Typography;

interface ArtifactPanelProps {
  artifacts: AgentArtifactItem[];
  truncated: boolean;
  refreshing: boolean;
  onRefresh: () => void;
}

export function ArtifactPanel({ artifacts, truncated, refreshing, onRefresh }: ArtifactPanelProps) {
  // 最新的排最上面（服务端按时间升序返回，展示时反转）
  const ordered = [...artifacts].reverse();

  return (
    <div
      style={{
        width: 320,
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
        background: "#fff",
        border: "1px solid #f0f0f0",
        borderRadius: 10,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "10px 12px",
          borderBottom: "1px solid #f0f0f0",
        }}
      >
        <Text strong style={{ fontSize: 14 }}>
          产出物
        </Text>
        <Button type="text" size="small" icon={<ReloadOutlined />} loading={refreshing} onClick={onRefresh} />
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: 8 }}>
        {ordered.length === 0 && (
          <div style={{ paddingTop: 32 }}>
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="本次会话还没有产出物" />
          </div>
        )}
        {ordered.map((artifact) => (
          <ArtifactCard key={artifact.event_id} artifact={artifact} />
        ))}
        {truncated && (
          <div style={{ textAlign: "center", padding: "8px 0" }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              仅显示最新 200 条产出物
            </Text>
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: 类型检查 + 提交**

```bash
npx tsc --noEmit
git add src/components/agent/artifact-panel.tsx src/components/agent/artifact-card.tsx
git commit -m "feat(agent-ui): 右栏工件面板与工件卡（常驻 + 空态 + 单独刷新 + 跳转）"
```

---

### Task 10: `/agent` 页面 + 侧边栏入口

**Files:**
- Create: `src/app/(protected)/agent/page.tsx`
- Modify: `src/components/layout/app-shell.tsx:55-73`（`mainNavItems` 数组开头插入一项）
- Modify: `src/components/agent/artifact-panel.tsx` / `artifact-card.tsx`（Step 0 的 Task 9 审查跟进）

**定位**：全部接线。三条关键规则（写代码前先读 `agent-state.ts` 文件头）：
1. **快照与连接配对**：应用快照后必须重连（`streamKey + 1`），从快照水位重放；
2. **发送 / 取消 / agent_end 之后的重同步**：`agent_end` 延迟 800ms 再拉（worker 才写完 Run 终态与会话 idle）；发送 409 / 取消 409 时也重同步，把本地「执行中」状态对齐；
3. **错误提示不重复**：axios 拦截器已统一 toast，页面只在需要恢复状态时 `resync`，不再 `message.error`。

- [ ] **Step 0: 先落地 Task 9 质量审查的 5 项跟进（`artifact-panel.tsx` + `artifact-card.tsx`，与 Task 10 同一次提交）**

来自 Task 9 的代码质量审查（结论 Yes；其中「面板每帧全量重渲染」经 Profiler 实测：N=20 时每轮约多烧 4.7s CPU —— memo 后降到 ~0）。

**(1) `artifact-panel.tsx` 整文件替换**（memo + `loading` + `disabled` 两个新 prop，见下方 Step 2 调用点的配套改动）：

```tsx
"use client";
/**
 * 右栏：工件面板（D20 常驻 + 空态；接口 6 仅供右栏单独刷新）
 *
 * memo：页面每帧 SSE 都会重渲染，而 artifacts 的数组引用只在「工件帧 / 快照 / 右栏刷新」时
 * 变化（噪声帧只推进水位）—— 与 MemoMessageStream / ToolCallCard 同一取舍。
 * 依赖调用方传稳定引用（页面的 handleRefreshArtifacts 是 useCallback），内联箭头会让它永远失效。
 */
import { memo } from "react";
import { ReloadOutlined } from "@ant-design/icons";
import { Button, Empty, Spin, Typography } from "antd";

import type { AgentArtifactItem } from "@/types";
import { ArtifactCard } from "./artifact-card";

const { Text } = Typography;

interface ArtifactPanelProps {
  artifacts: AgentArtifactItem[];
  truncated: boolean;
  /** 快照加载中（未选中会话时为 false）：只在列表为空时展示 spinner，避免「还没有产出物」谎报 */
  loading: boolean;
  refreshing: boolean;
  /** 未选中会话时禁用刷新（否则点了没有任何反馈） */
  disabled: boolean;
  onRefresh: () => void;
}

export const ArtifactPanel = memo(function ArtifactPanel({
  artifacts,
  truncated,
  loading,
  refreshing,
  disabled,
  onRefresh,
}: ArtifactPanelProps) {
  // 最新的排最上面（服务端按时间升序返回，展示时反转）
  const ordered = [...artifacts].reverse();

  return (
    <div
      style={{
        width: 320,
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
        background: "#fff",
        border: "1px solid #f0f0f0",
        borderRadius: 10,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "10px 12px",
          borderBottom: "1px solid #f0f0f0",
        }}
      >
        <Text strong style={{ fontSize: 14 }}>
          产出物
        </Text>
        <Button
          type="text"
          size="small"
          icon={<ReloadOutlined />}
          loading={refreshing}
          disabled={disabled}
          onClick={onRefresh}
        />
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: 8 }}>
        {loading && ordered.length === 0 && (
          <div style={{ paddingTop: 32, textAlign: "center" }}>
            <Spin size="small" />
          </div>
        )}
        {!loading && ordered.length === 0 && (
          <div style={{ paddingTop: 32 }}>
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="本次会话还没有产出物" />
          </div>
        )}
        {ordered.map((artifact) => (
          <ArtifactCard key={artifact.event_id} artifact={artifact} />
        ))}
        {truncated && (
          <div style={{ textAlign: "center", padding: "8px 0" }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              仅显示最新 200 条产出物
            </Text>
          </div>
        )}
      </div>
    </div>
  );
});
```

**(2) `artifact-card.tsx` 三处小改**：

标题加原生 tooltip（截断后可读全，与 `conversation-list` 一致）：

```tsx
        <Text ellipsis title={artifact.title} style={{ flex: 1, fontSize: 13, minWidth: 0 }}>
          {artifact.title || `#${artifact.id}`}
        </Text>
```

去掉多余的 cursor（antd 的 `hoverable` 已经给了 pointer，不 hoverable 时自然是 default）：

```tsx
      style={{ marginBottom: 8 }}
```
（即把 `style={{ marginBottom: 8, cursor: clickable ? "pointer" : "default" }}` 换成上面一行）

时间行改成条件渲染（`formatDateTime` 恒为 19 字符，原来的三元兜底是死分支，且会渲染一个空的 11px 文本行）：

```tsx
      {artifact.created_at.length >= 16 && (
        <Text type="secondary" style={{ fontSize: 11 }}>
          {artifact.created_at.slice(11, 16)}
        </Text>
      )}
```

- [ ] **Step 1: 侧边栏入口（`app-shell.tsx`）**

在 `mainNavItems` 数组最前面插入一项（第 55-57 行之间）：

```tsx
const mainNavItems: MenuProps["items"] = [
  // Agent 是跨模块总入口，不埋在 xhs 平台下（P0 D6 / P1 设计稿 §5.1）
  { key: "/agent", icon: <RobotOutlined />, label: "Agent 工作台" },
  { key: "/platforms/xhs/dashboard", icon: <DashboardOutlined />, label: "总览" },
  // …其余项不变
];
```

> `RobotOutlined` 已在文件顶部 import（footerNavItems 的「模型配置」在用），无需新增 import。

- [ ] **Step 2: 实现页面（`src/app/(protected)/agent/page.tsx` 新建）**

```tsx
"use client";
/**
 * Agent 工作台（P1-B：三栏界面 + SSE 实时过程）
 *
 * 数据来源严格分工（设计稿 §5.3）：
 *   首屏 / 重同步：fetchAgentConversation → 快照整体替换（agentReducer 的 snapshot）
 *   SSE 增量：useAgentEvents → 逐帧身份幂等归并（agentReducer 的 frame）
 *
 * 【快照与连接必须配对】agent-state.ts 的 applyFirstScreen 会把水位回退到快照的
 * latest_event_id（快照在途期间连接推的更新帧会被替换丢掉），所以每次应用快照之后
 * 都要 `streamKey + 1` 重连、从快照水位重放（幂等归并不会重复渲染）。
 * 【agent_end 后延迟重同步】worker 在循环结束后才写 Run 终态与会话 idle，
 * 立刻重拉可能读到「还在 running」的旧快照。
 * 【执行中每 5s 兜底校正】见下面的 settleRunStatus —— 覆盖「快照恰落在 agent_end 与
 * finishRun 之间」的毫秒级窗口（该窗口重连补不回结束信号，见 agent-state.ts 文件头）。
 */
import { memo, useCallback, useEffect, useReducer, useRef, useState } from "react";
import { SendOutlined } from "@ant-design/icons";
import { Button, Empty, Input, Space, Tag, Typography, message } from "antd";

import { ArtifactPanel } from "@/components/agent/artifact-panel";
import { ConversationList } from "@/components/agent/conversation-list";
import { MessageStream } from "@/components/agent/message-stream";
import { useAgentEvents } from "@/components/agent/use-agent-events";
import { agentReducer, createInitialState, upsertConversation } from "@/lib/agent/agent-state";
import {
  cancelAgentRun,
  createAgentConversation,
  fetchAgentArtifacts,
  fetchAgentConversation,
  fetchAgentConversations,
  sendAgentMessage,
} from "@/lib/api";
import type { AgentConversation } from "@/types";

const { Text } = Typography;

/** agent_end 之后延迟多久重同步（等 worker 写完 Run 终态与会话 idle） */
const RESYNC_AFTER_RUN_END_MS = 800;

/**
 * memo 包一层（Task 7 质量审查的量化的建议）：SSE 每帧都会产生新的 state 对象 →
 * 页面每帧重渲染，而约 95% 的帧 `items` 引用完全没变（噪声帧只推进水位）。
 * 没有这层，每帧都会重建整棵时间线（数百个 antd 组件）—— 一轮 1400 帧是几十万次
 * 无谓的渲染。四个 props 全是布尔或稳定引用，memo 命中率高。
 * Task 12 可用 React Profiler 做一次开/关对照实测。
 */
const MemoMessageStream = memo(MessageStream);

export default function AgentWorkspacePage() {
  const [conversations, setConversations] = useState<AgentConversation[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  /** 已应用过快照、可以订阅 SSE 的会话 id（null = 同步中，不连接） */
  const [syncedId, setSyncedId] = useState<number | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [streamKey, setStreamKey] = useState(0);
  const [sending, setSending] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [refreshingArtifacts, setRefreshingArtifacts] = useState(false);
  const [draft, setDraft] = useState("");
  const [state, dispatch] = useReducer(agentReducer, undefined, createInitialState);

  /** 当前选中的会话 id（异步回调里读最新值，避免把旧闭包的结果写回状态） */
  const selectionRef = useRef<number | null>(null);

  const executing = state.runStatus.executing;
  const pendingRunId = state.runStatus.pendingRunIds.length > 0 ? state.runStatus.pendingRunIds[0] : null;

  const refreshList = useCallback(async () => {
    try {
      setConversations(await fetchAgentConversations());
    } catch {
      // 刷新失败不打断使用（拦截器已提示）
    }
  }, []);

  /** 重同步：拉首屏快照整体替换，然后重连 SSE 从快照水位重放（见文件头） */
  const resync = useCallback(async () => {
    const id = selectionRef.current;
    if (id === null) return;
    try {
      const detail = await fetchAgentConversation(id);
      if (selectionRef.current !== id) return; // 已切到别的会话，丢弃过期响应
      dispatch({ type: "snapshot", detail });
      setStreamKey((key) => key + 1);
    } catch {
      // 静默：下一次交互会再同步
    }
  }, []);

  const loadDetail = useCallback(async (id: number) => {
    setDetailLoading(true);
    try {
      const detail = await fetchAgentConversation(id);
      if (selectionRef.current !== id) return;
      dispatch({ type: "snapshot", detail });
      setSyncedId(id);
    } catch {
      if (selectionRef.current === id) setSyncedId(null);
    } finally {
      if (selectionRef.current === id) setDetailLoading(false);
    }
  }, []);

  const handleSelect = useCallback(
    (id: number) => {
      selectionRef.current = id;
      setSelectedId(id);
      setSyncedId(null); // 断开旧会话的 SSE（effect 依赖变化 → abort），清空串台数据
      dispatch({ type: "clear" });
      setDraft("");
      void loadDetail(id);
      // 顺手刷列表：会话行的「执行中」标记只来自列表接口，切走期间别的会话跑完了不会自动更新 ——
      // 不刷的话「点回旧会话」会出现「中栏说空闲、左栏还在转」的自相矛盾（Task 6 质量审查发现）
      void refreshList();
    },
    [loadDetail, refreshList],
  );

  // 首屏：拉会话列表，自动选中最近一个
  useEffect(() => {
    void (async () => {
      try {
        const items = await fetchAgentConversations();
        setConversations(items);
        if (items.length > 0) handleSelect(items[0].id);
      } catch {
        // 拦截器已提示
      } finally {
        setListLoading(false);
      }
    })();
  }, [handleSelect]);

  // SSE：会话切换 / 主动重启（streamKey）时重连
  useAgentEvents({
    conversationId: syncedId,
    streamKey,
    lastEventId: state.lastEventId,
    hasActiveRun: executing,
    onEvent: (frame) => dispatch({ type: "frame", frame }),
    onRunEnded: () => {
      // agent_end：循环已结束。稍等再重同步 —— worker 紧接着才写 Run 终态与会话 idle。
      // 重连后 agent_end 可能被重放一次（水位落后一个提交时）→ 至多多一次无害的重同步，
      // 不做去重。
      window.setTimeout(() => {
        void resync();
        // 首轮结束后标题会按首条消息派生，updated_at 排序也可能变
        void refreshList();
      }, RESYNC_AFTER_RUN_END_MS);
    },
  });

  /**
   * 兜底校正执行状态（仅执行中，每 5s 一次）。
   *
   * 动机：worker 先落 agent_end、后写 Run 终态（finishRun）—— 若某次快照恰在这个
   * 毫秒级窗口返回，水位已越过 agent_end，重连补不回结束信号，UI 会卡在「执行中」
   * （输入框禁用、也没有取消按钮）。定时读一次服务端 runs 把状态收敛。
   * 只发 runStatus 动作（不动时间线 / 水位 / 工件），因此不需要重连 SSE。
   * 执行中每 5s 一个轻量 GET，空闲即停（与设计稿「空闲降速」的取向一致）。
   *
   * 已知无害竞态（登记在交接文档，不做机制兜底）：一次在途的请求若在新一轮
   * 「发送 → runCreated」之后才落地，会把 executing 短暂抹回 false（新 Run 不在
   * 那份过期响应里）—— 用户若立刻再发会吃到 409，拦截器提示并自动重同步，自愈。
   */
  const settleRunStatus = useCallback(async () => {
    const id = selectionRef.current;
    if (id === null) return;
    try {
      // silent=true：失败不弹 toast（每 5s 一拍，抖动连发会刷屏），靠下一拍自愈
      const detail = await fetchAgentConversation(id, true);
      if (selectionRef.current !== id) return;
      dispatch({ type: "runStatus", runs: detail.runs });
    } catch {
      // 静默：下一拍再试
    }
  }, []);

  useEffect(() => {
    if (!executing || syncedId === null) return;
    const timer = window.setInterval(() => void settleRunStatus(), 5000);
    return () => window.clearInterval(timer);
  }, [executing, syncedId, settleRunStatus]);

  const handleCreate = useCallback(async () => {
    setCreating(true);
    try {
      const conversation = await createAgentConversation();
      setConversations((items) => upsertConversation(items, conversation));
      handleSelect(conversation.id);
    } catch {
      // 拦截器已提示
    } finally {
      setCreating(false);
    }
  }, [handleSelect]);

  const handleSend = useCallback(async () => {
    const id = selectionRef.current;
    const content = draft.trim();
    if (id === null || !content || sending || executing) return;
    setSending(true);
    try {
      const result = await sendAgentMessage(id, content);
      dispatch({
        type: "runCreated",
        conversation: result.conversation,
        message: result.message,
        run: result.run,
      });
      setConversations((items) => upsertConversation(items, result.conversation));
      setDraft("");
      // 重连一次：空闲时服务端 SSE 循环要 5s 才醒，重连让它立刻看到 pending 的 Run、切回 500ms 快查
      setStreamKey((key) => key + 1);
    } catch {
      // 409（会话正在执行）等错误已由拦截器提示；重同步把「执行中」状态对齐
      void resync();
    } finally {
      setSending(false);
    }
  }, [draft, executing, resync, sending]);

  const handleCancel = useCallback(async () => {
    if (pendingRunId === null) return;
    setCancelling(true);
    try {
      await cancelAgentRun(pendingRunId);
      dispatch({ type: "runCancelled" });
      message.success("已取消等待中的任务");
    } catch {
      // 409：已被 worker 领走开始执行 —— 重同步对齐状态（按钮随之隐藏）
      void resync();
    } finally {
      setCancelling(false);
    }
  }, [pendingRunId, resync]);

  const handleRefreshArtifacts = useCallback(async () => {
    const id = selectionRef.current;
    if (id === null) return;
    setRefreshingArtifacts(true);
    try {
      dispatch({ type: "artifacts", items: await fetchAgentArtifacts(id) });
    } catch {
      // 拦截器已提示
    } finally {
      setRefreshingArtifacts(false);
    }
  }, []);

  return (
    <div style={{ display: "flex", gap: 16, height: "calc(100vh - 96px)" }}>
      <ConversationList
        items={conversations}
        selectedId={selectedId}
        loading={listLoading}
        creating={creating}
        onSelect={handleSelect}
        onCreate={() => void handleCreate()}
      />

      <div
        style={{
          flex: 1,
          // 两栏固定 260 + 320、左右 sider 与内边距约 300 —— 窄视口下给中栏留一个下限，
          // 靠 Content 的 overflow 出横向滚动条，而不是把消息流挤成一条缝
          minWidth: 420,
          display: "flex",
          flexDirection: "column",
          background: "#fff",
          border: "1px solid #f0f0f0",
          borderRadius: 10,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "10px 16px",
            borderBottom: "1px solid #f0f0f0",
          }}
        >
          <Text strong ellipsis style={{ fontSize: 14, flex: 1, minWidth: 0 }}>
            {state.conversation?.title ?? "Agent 工作台"}
          </Text>
          {executing && <Tag color="processing">执行中</Tag>}
        </div>

        {selectedId === null ? (
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Empty description={listLoading ? "加载中…" : "选择或新建一个会话开始"} />
          </div>
        ) : (
          <>
            <MemoMessageStream
              items={state.timeline}
              executing={executing}
              truncated={state.eventsTruncated || state.toolCallsTruncated}
              loading={detailLoading}
            />

            <div style={{ borderTop: "1px solid #f0f0f0", padding: 12 }}>
              <Input.TextArea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void handleSend();
                  }
                }}
                placeholder="描述你的任务（Enter 发送，Shift+Enter 换行）"
                autoSize={{ minRows: 1, maxRows: 4 }}
                maxLength={4000}
                disabled={executing}
              />
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginTop: 8,
                }}
              >
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {executing ? "执行中，完成后可继续对话" : ""}
                </Text>
                <Space>
                  {pendingRunId !== null && (
                    <Button size="small" loading={cancelling} onClick={() => void handleCancel()}>
                      取消任务
                    </Button>
                  )}
                  <Button
                    type="primary"
                    size="small"
                    icon={<SendOutlined />}
                    loading={sending}
                    disabled={executing || !draft.trim()}
                    onClick={() => void handleSend()}
                  >
                    发送
                  </Button>
                </Space>
              </div>
            </div>
          </>
        )}
      </div>

      <ArtifactPanel
        artifacts={state.artifacts}
        truncated={state.artifactsTruncated}
        loading={detailLoading}
        refreshing={refreshingArtifacts}
        disabled={selectedId === null}
        onRefresh={handleRefreshArtifacts}
      />
    </div>
  );
}
```

- [ ] **Step 3: 类型检查 + 全量单测**

```bash
npx tsc --noEmit        # 期望无输出（Task 7 遗留的模块缺失此时应已消除）
npx vitest run          # 期望 25 文件全绿
```

- [ ] **Step 4: dev server 起页面，肉眼确认不报错**

```bash
npm run dev
```

浏览器打开 `http://localhost:3000/agent`：三栏出现、侧边栏有「Agent 工作台」（选中态高亮）、空态文案正确、浏览器控制台无报错。

- [ ] **Step 5: 提交**

```bash
git add "src/app/(protected)/agent/page.tsx" src/components/layout/app-shell.tsx src/components/agent/artifact-panel.tsx src/components/agent/artifact-card.tsx
git commit -m "feat(agent-ui): /agent 三栏页面接线与侧边栏入口（含 Task 9 审查跟进：面板 memo 与加载/禁用态）"
```

---

### Task 10 补丁：质量审查修复（独立提交）

**Files:**
- Modify: `src/app/(protected)/agent/page.tsx`

**为什么独立提交**：Task 10 已提交（`9811360`）后才出的质量审查结论 —— 审查者用 9 个 jsdom 挂载探针实测复现了 **2 项 Critical + 3 项 Important**（全在 React 接线层的竞态守卫上）：① 发送后立刻切会话 → A 的消息/执行中状态泄漏进 B 且清掉 B 的草稿；② **中文输入法合成态按 Enter 会直接发送半成品任务**；③ 首屏加载失败后 `resync` 不会重新武装订阅 → 永久失去直播与 5s 兜底；④ 右栏刷新响应不检查会话 → A 的工件长期显示在 B；⑤ 取消回调会改写新选中会话的执行状态。

- [ ] **Step 1: 修复五处（都在 `page.tsx`）**

**(1) 抽 `applySnapshot`，把「快照 + 重连 + 武装订阅」三件事收进一处（修 I1 的主入口）**

先把类型 import 那行改成：

```tsx
import type { AgentConversation, AgentConversationDetail } from "@/types";
```

在 `refreshList` 之后、`resync` 之前新增：

```tsx
  /**
   * 应用快照：三件事必须一起做（见文件头的不变量）——
   *   1) 整体替换状态（snapshot）
   *   2) 重连 SSE 从快照水位重放（bump streamKey）
   *   3) 武装订阅（syncedId）—— 漏了这步，首屏失败后 resync 成功了也永远不订阅
   *      （Task 10 质量审查 I1：页面会永久失去直播通道与 5s 兜底）
   */
  const applySnapshot = useCallback((id: number, detail: AgentConversationDetail) => {
    dispatch({ type: "snapshot", detail });
    setStreamKey((key) => key + 1);
    setSyncedId(id);
  }, []);
```

把 `resync` 换成：

```tsx
  /** 重同步：拉首屏快照整体替换，然后重连 SSE 从快照水位重放（见文件头） */
  const resync = useCallback(async () => {
    const id = selectionRef.current;
    if (id === null) return;
    try {
      const detail = await fetchAgentConversation(id);
      if (selectionRef.current !== id) return; // 已切到别的会话，丢弃过期响应
      applySnapshot(id, detail);
    } catch {
      // 静默：下一次交互会再同步
    }
  }, [applySnapshot]);
```

把 `loadDetail` 换成（**注意 catch 里不再置 `setSyncedId(null)`** —— 修 I1 的第二个入口：若 `resync` 先成功（快照已应用、订阅已武装），这里失败再置 null 会把直播通道与兜底一起关掉；而正常路径下 `handleSelect` 本来就先置了 null）：

```tsx
  const loadDetail = useCallback(
    async (id: number) => {
      setDetailLoading(true);
      try {
        const detail = await fetchAgentConversation(id);
        if (selectionRef.current !== id) return;
        applySnapshot(id, detail);
      } catch {
        // 不在这里卸 syncedId（原因见上）；handleSelect 已经把订阅关掉过了
      } finally {
        if (selectionRef.current === id) setDetailLoading(false);
      }
    },
    [applySnapshot],
  );
```

**(2) `handleSend`：await 之后补守卫（修 C1 —— 串台 + 丢草稿）**

把：

```tsx
      const result = await sendAgentMessage(id, content);
      dispatch({
        type: "runCreated",
        conversation: result.conversation,
        message: result.message,
        run: result.run,
      });
      setConversations((items) => upsertConversation(items, result.conversation));
      setDraft("");
```

换成：

```tsx
      const result = await sendAgentMessage(id, content);
      // 已切走：A 的消息与执行中状态不能写进 B 的时间线，更不能清掉 B 的草稿（Task 10 审查 C1）
      if (selectionRef.current !== id) return;
      dispatch({
        type: "runCreated",
        conversation: result.conversation,
        message: result.message,
        run: result.run,
      });
      setConversations((items) => upsertConversation(items, result.conversation));
      setDraft("");
```

**(3) `handleCancel`：await 之后补守卫（修 I3）**

把：

```tsx
  const handleCancel = useCallback(async () => {
    if (pendingRunId === null) return;
    setCancelling(true);
    try {
      await cancelAgentRun(pendingRunId);
      dispatch({ type: "runCancelled" });
      message.success("已取消等待中的任务");
```

换成：

```tsx
  const handleCancel = useCallback(async () => {
    if (pendingRunId === null) return;
    const id = selectionRef.current;
    setCancelling(true);
    try {
      await cancelAgentRun(pendingRunId);
      // 已切走：A 的取消结果不能改写 B 的执行中状态（Task 10 审查 I3）
      if (selectionRef.current !== id) return;
      dispatch({ type: "runCancelled" });
      message.success("已取消等待中的任务");
```

**(4) `handleRefreshArtifacts`：await 之后补守卫（修 I2 —— 右栏串台且长期不消失）**

把：

```tsx
    setRefreshingArtifacts(true);
    try {
      dispatch({ type: "artifacts", items: await fetchAgentArtifacts(id) });
    } catch {
```

换成：

```tsx
    setRefreshingArtifacts(true);
    try {
      const items = await fetchAgentArtifacts(id);
      // 已切走：A 的工件不能写进 B 的右栏（Task 10 审查 I2）
      if (selectionRef.current !== id) return;
      dispatch({ type: "artifacts", items });
    } catch {
```

**(5) 输入框：Enter 提交排除输入法合成态（修 C2 —— 中文用户回车确认候选词会误发）**

把：

```tsx
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void handleSend();
                  }
                }}
```

换成：

```tsx
                onKeyDown={(event) => {
                  // 输入法合成态里的 Enter 是「确认候选词」，不是提交 —— 误发的代价是让 Agent
                  // 拿半句话去执行工具（Task 10 审查 C2）。keyCode 229 是部分输入法在
                  // 合成期的另一种上报方式，一并挡掉。
                  if (
                    event.key === "Enter" &&
                    !event.shiftKey &&
                    !event.nativeEvent.isComposing &&
                    event.nativeEvent.keyCode !== 229
                  ) {
                    event.preventDefault();
                    void handleSend();
                  }
                }}
```

**(6) 两处注释修正（审查 Minor M3/M2）**

`settleRunStatus` 的注释里那句「一个轻量 GET」不准确 —— 拉的其实是完整首屏契约。把它换成：

```tsx
   * 只发 runStatus 动作（不动时间线 / 水位 / 工件），因此不需要重连 SSE。
   * 这一拍拉的是**完整首屏契约**（接口 3，只为读 runs）——执行中每 5s 一次是可接受的代价，
   * 真嫌重再考虑给接口 3 加字段过滤（登记在交接文档）。
```

首屏 effect 上方补一行约束说明：

```tsx
  // 首屏只跑一次：依赖里的 handleSelect 必须是稳定引用（空依赖 useCallback）——
  // 任何为 loadDetail 加依赖的改动都会让首屏 effect 重跑，把用户强制拉回列表第一项（审查 M2）
  useEffect(() => {
```

- [ ] **Step 2: 验证 + 提交**

```bash
npx tsc --noEmit        # 期望无输出
npx vitest run          # 期望 26 文件 / 299 用例

git add "src/app/(protected)/agent/page.tsx"
git commit -m "fix(agent-ui): 页面补五个竞态守卫（切会话丢弃过期响应/输入法回车/失败后重新武装订阅）（Task 10 质量审查修复）"
```

---

### Task 11: 工具卡验收夹具（`blocked` / `failed`）

**Files:**
- Create: `src/scripts/agent-ui-seed-toolcard.ts`

**定位**：`blocked` 状态在 P1 生产不可达（没有 `publish` 级技能），`failed` 靠真实工具报错又不稳定 —— 但 §7.2 第 3 条要求 4 种状态渲染正确。这个夹具往 dev 库插一条指定状态的工具卡（挂在最新一个已结束的 Run 上），刷新页面即可看到橙色「被阻断」/ 红色「失败」卡，验完删除。

- [ ] **Step 1: 实现**

```ts
/**
 * 验收夹具：给最新一个已结束的 Run 补一条指定状态的工具卡（§7.2 第 3 条的 4 种状态渲染）。
 *
 * 用法：
 *   npx tsx src/scripts/agent-ui-seed-toolcard.ts add          # 插一条「被阻断」卡（默认）
 *   npx tsx src/scripts/agent-ui-seed-toolcard.ts add failed   # 插一条「失败」卡
 *   npx tsx src/scripts/agent-ui-seed-toolcard.ts remove       # 删除全部夹具行
 *
 * 注意：这是人工构造的验收数据（blocked 在 P1 生产不可达；failed 想确定性复现也不方便）。
 */
import { prisma } from "../lib/server/core/db";
import { shanghaiNow } from "../lib/server/core/time";

/** 夹具行的 toolCallId 前缀（删除时按前缀清理全部夹具） */
const FIXTURE_PREFIX = "manual_fixture";

const FIXTURES = {
  blocked: {
    toolName: "publish_note",
    status: "blocked",
    errorType: "guard_blocked",
    summary: "「发布笔记」需要人工确认，已阻断（人工构造的验收数据）",
  },
  failed: {
    toolName: "content_note_pack",
    status: "failed",
    errorType: "tool_error",
    summary: "生成失败：文本模型未配置（人工构造的验收数据）",
  },
} as const;

type FixtureStatus = keyof typeof FIXTURES;

async function addFixture(status: FixtureStatus): Promise<void> {
  const fixture = FIXTURES[status];
  const toolCallId = `${FIXTURE_PREFIX}_${status}`;
  const run = await prisma.agentRun.findFirst({
    where: { status: { in: ["succeeded", "failed", "cancelled"] } },
    orderBy: { id: "desc" },
  });
  if (!run) throw new Error("库里没有已结束的 Run，先在 /agent 里跑一轮任务");

  const existing = await prisma.agentToolCall.findFirst({ where: { runId: run.id, toolCallId } });
  if (existing) {
    console.log(`夹具行已存在（id=${existing.id}），直接刷新页面即可`);
    return;
  }

  const created = await prisma.agentToolCall.create({
    data: {
      runId: run.id,
      // 序号排在该 Run 现有卡片的最后，保证出现在时间线末尾
      stepIndex: await prisma.agentToolCall.count({ where: { runId: run.id } }),
      toolName: fixture.toolName,
      toolCallId,
      params: {},
      status: fixture.status,
      errorType: fixture.errorType,
      summary: fixture.summary,
      createdAt: shanghaiNow(),
    },
  });
  console.log(`已为 Run #${run.id}（会话 #${run.conversationId}）插入「${status}」卡片 id=${created.id}`);
  console.log("打开 http://localhost:3000/agent 选中该会话并刷新，即可看到对应状态的卡片");
}

async function removeFixtures(): Promise<void> {
  const result = await prisma.agentToolCall.deleteMany({ where: { toolCallId: { startsWith: FIXTURE_PREFIX } } });
  console.log(`已删除 ${result.count} 条夹具行`);
}

async function main(): Promise<void> {
  const action = process.argv[2];
  if (action === "add") {
    const status = (process.argv[3] ?? "blocked") as FixtureStatus;
    if (!(status in FIXTURES)) {
      throw new Error(`未知状态：${status}（可用：${Object.keys(FIXTURES).join(" / ")}）`);
    }
    return addFixture(status);
  }
  if (action === "remove") return removeFixtures();
  throw new Error("用法：npx tsx src/scripts/agent-ui-seed-toolcard.ts add [blocked|failed] | remove");
}

main()
  .catch((error) => {
    console.error((error as Error).message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
```

- [ ] **Step 2: 手工验证（需要 dev server 与真实数据）**

```bash
npx tsx src/scripts/agent-ui-seed-toolcard.ts add blocked
# 浏览器刷新 /agent 选中对应会话：出现橙色「被阻断」卡片，摘要为「「发布笔记」需要人工确认，已阻断（人工构造的验收数据）」
npx tsx src/scripts/agent-ui-seed-toolcard.ts add failed
# 刷新：再出现一张红色「失败」卡片
npx tsx src/scripts/agent-ui-seed-toolcard.ts remove
# 刷新：两张夹具卡片消失
```

Expected：`add` 输出「已为 Run #N（会话 #M）插入「blocked」卡片」；`remove` 输出「已删除 2 条夹具行」。

- [ ] **Step 3: 类型检查 + 提交**

```bash
npx tsc --noEmit
git add src/scripts/agent-ui-seed-toolcard.ts
git commit -m "test(agent-ui): 工具卡验收夹具（blocked / failed，add 与 remove）"
```

---

### Task 11 补丁：质量审查修复（独立提交）

**Files:**
- Modify: `src/scripts/agent-ui-seed-toolcard.ts`

**为什么独立提交**：Task 11 已提交（`ac2ec36`）后才出的质量审查结论（结论 Yes，6 项 Minor 值得顺手改 —— 其中「空终态 Run 的报错会误导刚发过消息的用户」与「failed 夹具断言了具体原因、与 Task 12 真实运行自相矛盾」会影响 Task 12 的人工验收体验）。

- [ ] **Step 1: 六处小改**

**(1)** 原型链守卫（`status in FIXTURES` 对 `toString` 等为 true）：

```ts
    if (!Object.hasOwn(FIXTURES, status)) {
```

**(2)** 让 `finally` 的 `$disconnect` 不再成为死代码：

```ts
main()
  .catch((error) => {
    console.error((error as Error).message);
    // 用 exitCode 而不是 process.exit(1)：后者会让下面的 finally（$disconnect）成为死代码
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
```

**(3)** stepIndex 的注释因果修正（排序靠 `created_at`，与 stepIndex 无关）：

```ts
      // 序号只作审计透传（前端不排序、不展示）；卡片落在时间线末尾靠的是 createdAt 取当前时刻
      stepIndex: await prisma.agentToolCall.count({ where: { runId: run.id } }),
```

**(4)** 没有终态 Run 时的报错别误导刚发过消息的用户：

```ts
  if (!run) throw new Error("库里没有已结束的 Run（若刚发过消息，等这一轮跑完再执行本脚本），先在 /agent 里跑一轮任务");
```

**(5)** 幂等提示带上位置（否则用户不知道卡在哪个会话里）：

```ts
  if (existing) {
    console.log(`夹具行已存在（id=${existing.id}，Run #${run.id} / 会话 #${run.conversationId}），直接刷新页面即可`);
    return;
  }
```

**(6)** `failed` 夹具的原因改中性（原「文本模型未配置」与 Task 12 用真模型跑出来的运行自相矛盾）：

```ts
  failed: {
    toolName: "content_note_pack",
    status: "failed",
    errorType: "tool_error",
    summary: "生成失败：模型调用超时（人工构造的验收数据）",
  },
```

- [ ] **Step 2: 验证 + 提交**

```bash
npx tsc --noEmit
npx tsx src/scripts/agent-ui-seed-toolcard.ts add bogus    # 期望：未知状态：bogus（可用：blocked / failed），exit 1
npx tsx src/scripts/agent-ui-seed-toolcard.ts remove       # 期望：已删除 0 条夹具行（空库）

git add src/scripts/agent-ui-seed-toolcard.ts
git commit -m "fix(agent-ui): 验收夹具脚本守卫与文案（Task 11 质量审查修复）"
```

---

### Task 12: 浏览器端到端验收 + 全量回归 + 交接文档

**Files:**
- Create: `docs/superpowers/HANDOFF-agent-p1b.md`
- Modify: `docs/superpowers/HANDOFF-agent-p1-remaining.md`（§一 状态行、§五 验收总清单）

**运行环境（三终端）** —— 先按 §一 硬约束 8/9 清环境：

```
终端 A：残留 worker 先按进程树清干净（P1A 交接 §五.1 的 PowerShell 命令），再 npx tsx src/worker/index.mts
终端 B：npm run dev（若刚跑过 next build：停 dev → rm -rf .next → 再起）
终端 C：浏览器 http://localhost:3000/agent（F12 打开控制台与网络面板）
```

- [ ] **Step 1: §7.2 第 1 条 —— `/agent` 出现在侧边栏且可访问**

点击侧边栏「Agent 工作台」→ URL 变 `/agent`，菜单项高亮，三栏布局出现（左会话列表 / 中消息流 / 右产出物面板）。
Expected：无 404、无白屏、控制台无报错。

- [ ] **Step 2: §7.2 第 2 条 —— 发消息后无需刷新即可看到工具卡与助手文字逐步出现**

1. 点「新建」→ 新会话被选中（标题「新任务」）。
2. 输入框发送：`帮我写一篇关于周末露营装备清单的小红书笔记`（会触发 `content_note_pack` —— 它只依赖文本模型，最稳；输出草稿工件）。
   - 备选（依赖账号 Cookie，可能因 Cookie 失效而失败）：`帮我采集一下当前热点，然后生成 2 个露营主题的选题`。
3. **不刷新页面**，观察中栏：用户气泡出现 → 出现「正在执行…」→ 助手文本气泡逐步出现 → 工具卡从「运行中」变「成功」（带摘要与耗时）。

Expected：过程实时可见；工具卡摘要形如「已保存草稿 #N：《…》」；会话标题在首轮后变为从首条消息派生的标题。

> 两个**不是 bug** 的预期现象（别当缺陷上报）：① 重复点击已选中的会话会让中栏短暂清空再填回（`handleSelect` 有意无条件重载快照）；② 「新建」在途时点列表项，选中会被创建完成后的新会话覆盖（纯外观问题）。
>
> **额外两条针对性手测**（Task 10 质量审查用 jsdom 探针复现过的竞态，修完后要在真浏览器里确认修好；都不依赖真实模型）：
> ① **发送后立刻切会话**：在 A 里点「发送」，200ms 内点左栏 B —— A 的用户气泡**不能**出现在 B 的中栏、B 的输入框草稿**不能**被清空、B 不能出现不属于它的「执行中」。
> ② **中文输入法回车**：用中文输入法在输入框打字，候选词框弹出时按 Enter（确认候选词）—— **不能**发送；只有候选词上屏后再按一次 Enter 才发送。

- [ ] **Step 3: §7.2 第 3 条 —— 工具卡的 4 种状态**

- 运行中 / 成功：上一步已经看到。
- 失败（两种子情形都要看）：
  - 真实失败：发一条会让工具报错的指令（例如「生成 999 个选题」这类越界参数）；若模型行为不配合、没有产生失败卡，用下面的夹具兜底（不算未通过，但要记录实际触发了哪一种）。
  - 夹具失败：`npx tsx src/scripts/agent-ui-seed-toolcard.ts add failed` → 刷新 → 出现红色「失败」卡（见 Task 11）。
- 被阻断：`npx tsx src/scripts/agent-ui-seed-toolcard.ts add blocked` → 刷新 → 出现橙色「被阻断」卡 → 验完 `npx tsx src/scripts/agent-ui-seed-toolcard.ts remove` → 刷新确认消失。
  （两张夹具卡要**连着种**，这样都挂在最新那个 Run 上、出现在同一个会话里；若中间又跑了新一轮，卡会分到两个 Run，`remove` 仍会一次清掉两条。）

Expected：四种状态的颜色/文案都对；点「详情」能展开入参/结果 JSON；短路未执行（`error_type="not_executed"`）归在「失败」样式里、摘要带「未执行：」前缀。

- [ ] **Step 4: §7.2 第 4 条 —— 工件卡片出现且点击能跳到对应模块**

上一步跑完后，右栏出现「草稿」蓝色标签的工件卡（走备选 prompt 的话是「选题」紫色标签）；点击 → 跳到 `/platforms/xhs/drafts?id=…`（草稿工坊）。
Expected：跳转后目标页正常打开（Agent 会话不丢，浏览器后退可回）。

- [ ] **Step 5: §7.2 第 5 条 —— 刷新后历史完整且不重复渲染**

1. 运行中按 F5（或在运行结束后按 F5）：中栏历史完整（用户消息一次、助手文本一次、工具卡每张只出现一次、文件不缺不重）。
2. 刷新后新产生的事件仍能实时到达（不刷新也能继续看到过程）。
3. 若刷新时恰好在运行中：`latest_event_id` 之后的事件继续从 SSE 补上，**没有**任何卡片/气泡出现两遍。

Expected：逐项对账；特别检查「同一张工具卡不出现两次」（跨边界归并）与「同一个用户气泡不出现两次」。

- [ ] **Step 6: §7.2 第 6 条 —— 空闲时轮询降速**

服务端降速已由 `polling.test.ts` 覆盖；前端侧观察重连间隔：

1. 会话空闲（无运行）时，在 DevTools → Network 面板切「Offline」约 2 秒再切回（或在控制台里执行 `window.dispatchEvent(new Event("offline"))` 无效时直接用 DevTools 的离线开关）。
2. 控制台出现 `[agent] 5000ms 后重连 SSE`。
3. 运行中重复同一操作 → 出现 `[agent] 500ms 后重连 SSE`。

Expected：两档间隔差 10 倍（与 `SSE_ACTIVE_INTERVAL_MS` / `SSE_IDLE_INTERVAL_MS` 一致）。

- [ ] **Step 7: 取消 pending 的可见行为（§7.2 第 7 条已在 A 块完成，这里只验前端入口）**

发一条消息后**立刻**点「取消任务」：预期 toast「已取消等待中的任务」，输入框恢复可用，卡消失（若已开始执行则 toast 提示无法取消 —— 见 A 块验收第 7 条）。

- [ ] **Step 8: 全量回归**

```bash
npx vitest run              # 期望 25 文件全绿
npx tsc --noEmit            # 期望无输出
# 停 dev server（陷阱 9）后再跑：
npx next build              # 期望成功；路由数比 A 块基线 +1（/agent）
# build 后按陷阱 9 恢复 dev：停 dev → rm -rf .next → npm run dev
```

P0/P1-A 回归（**改了前端不改服务端也要跑**，防止构建产物/依赖图意外回归）：

```
终端 A：npx tsx src/worker/index.mts
终端 B：npx tsx src/scripts/agent-smoke.ts        # 期望「P0 验收全部通过」
终端 C：npx tsx src/scripts/agent-api-smoke.ts    # 期望 9 项全过（约 60s）
```

收尾：按进程树停掉 worker（陷阱 8）。

- [ ] **Step 9: 写交接文档 `docs/superpowers/HANDOFF-agent-p1b.md`**

必须含：

1. 一句话现状（B 块已完成并验收，§7.2 第 1-6 条关闭；C 块未开始）
2. **前端实测确认**：哪些 A 块契约假设被浏览器验证/推翻（对照 §一 硬约束逐条），实测耗时（一轮运行的体感延迟）
3. 前端结构：`agent-state.ts` 的归并规则（快照/身份幂等/水位配对重连）、SSE hook 的重连策略
4. 本机陷阱复述（worker 进程树、build/dev 顺序、中文传参）
5. 已知局限与遗留项：
   - 同秒内「工具结束 → 下一条助手文本」的回放排序（首屏/重同步时可能把文本排在卡前）
   - 不显示 `step_count` / token 进度与 `task_id` 深链（实时不可得，留 P2）
   - 「被阻断」靠夹具验收（Task 11）
   - 快照与 `agent_end` 的毫秒级竞态窗口：已由 Task 10 的 `settleRunStatus` 收敛（执行中每 5s 校正一次执行状态）；把成因与窗口登记在这里备查
   - `settleRunStatus` 的过期响应竞态（新旧响应乱序 → executing 短暂抹回 false）：无害且自愈（再发会 409 → 自动重同步），登记备查
   - 契约镜像：`src/types/index.ts` 与 `src/app/api/agent/shared.ts` 之间加了类型级断言（Task 2 的 `Mirror` 检查），服务端契约漂移会让 `tsc` 失败而不是运行时才发现
   - 直播期间的工具卡与首屏 DTO 有两处细微差异（都由重同步/刷新收敛，不是缺陷）：① SSE 帧不带 `status` / `error_type`，护栏阻断在直播里先显示为「失败」（摘要仍含「已阻断」字样）；② 失败调用的展开详情（错误文本）只有 DTO 里有 —— 若将来 `publish` 级技能落地，考虑让 SSE 出口连 `status`/`error_type` 一起补
   - 接口 6（工件列表）只返回 `{ items }`，没有截断标记 —— 右栏手动刷新后，截断提示仍是上次快照的（today 无 UI 依赖这条，登记备查）
   - 会话过期不重定向：SSE 的 401 在 refresh 失败后停流（fail-safe），而 `clearAuthTokens()` 不通知 `use-auth`，路由守卫不会跳登录 —— 用户可见行为是「工作台不再实时更新、其余功能照旧」，恢复手段是手动刷新页面（Task 5 审查发现；根治需让 `clearAuthTokens` 通知 `use-auth`，属跨页面的独立改进）
   - 左栏会话行的「执行中」标记只随列表接口更新（挂载 / 新建 / 发送 / 切会话 / 当前会话结束）；**非当前会话**在后台跑完时，其行标记会滞留到用户切到它为止（切会话已会顺手刷列表，故不会出现中栏与左栏矛盾）
   - 全站列表项都不可键盘访问（`div onClick`，无 `role`/`tabIndex`/`onKeyDown`，与既有页面一致）—— 本组件的会话行同此，登记为全站 a11y 债，建议独立改进项
   - 会话行时间戳不带年份（「10-10 14:23」），跨年时会歧义；组件内 `formatListTime` 与 Task 7-9 内联的时间切片未归口到 `src/lib/time.ts`（可作独立小改进）
   - 工作台三栏统一圆角 10（项目面板级 token 是 12）—— 有意选择，非疏漏
   - 工件卡跳转用 `router.push`（`Card onClick`）而不是 `next/link`：键盘不可达、没有 cmd/中键新开标签与预取（与全站 `div onClick` 的 a11y 债同源，P2 可改）
   - `onRunEnded` 里的 800ms 定时器没随卸载清理（最多一次多余 GET，React 18+ 无告警）；`ConversationList` 未 memo（若加，`onCreate` 必须同时稳定成 useCallback，否则 memo 永远失效）—— Task 12 可用 Profiler 一并量
   - 详情加载失败时中/右栏显示的是空态文案（「还没有消息…」/「本次会话还没有产出物」）而不是「加载失败」；拦截器已 toast，重新点一次会话可恢复（建议独立改进：加 `detailError` + 重试按钮）
   - **建议的独立改进项（Task 10 审查提出，值得单独做）**：给页面级竞态守卫加一个 jsdom 挂载冒烟测试。`jsdom` 已在 devDependencies，vitest 支持逐文件 `// @vitest-environment jsdom`（用 `react-dom/client` + `React.createElement` 绕开 `jsx: preserve` 与 `include` 只收 `.test.ts` 的限制），假 fetch 流即可；本次审查正是靠它复现了 4 个接线层缺陷，而纯函数测试结构上抓不到这一类。是否引入属产品决策（D25 说不引前端测试栈）
   - 窄视口：三栏固定宽度加起来约 880px，中栏已设 `minWidth: 420`（低于此靠横向滚动条兜底）；舒适使用建议视口 ≥1280
   - 自动滚动的「用户上滚」信号：滚轮有 `onWheel` 同步标记，**触摸/键盘/滚动条拖动**仍只依赖异步 scroll 事件（窗口极窄，Task 12 可专门手测一次「执行中上滚」）；另：内容不足一屏时上滚也会进入「不跟随」，此时若无 scroll 事件可能短暂弹一次「有新消息 ↓」（点一下即消，审查裁定可接受）；在工具卡展开的 `<pre>` 里滚轮上滚也会冒泡到容器、关闭跟随（语义可辩护，属已知行为）
   - 展开最后一张工具卡不会自动把它滚入视野（下一个内容帧才会跟随滚到底）—— Task 12 浏览器观察项
   - 两个 4000 的口径不同：服务端 `shared.ts` 按**紧凑 JSON** 截断、前端 `DETAIL_TEXT_LIMIT` 按**pretty-print 后**字符数（后者是前者的兜底，不要「顺手统一」）；服务端那处 `slice` 同样有把代理对切半的风险（本次只修了前端，登记备查）
   - 工具卡的截断文案有一处纳秒级竞态（Task 8 复审观察）：首屏快照恰落在「审计行已提交、事件行未落库」的缝隙且结果超 4000 时，卡片会出现「服务端已截断」文案配新到的完整结果（`upsertToolCard` 应用帧结果时不清 `resultTruncated`）。窗口极窄、影响仅是文案观感；若要收，最小改法是 merge 应用 `patch.result` 时把 `resultTruncated` 置 false（属 reducer 边界，未修）
   - `createAgentConversation` 的 `title` 参数在 P1 没有调用方（页面不传标题）；保留是为对齐服务端契约，已加 trim 守卫（纯空白会 422 弹英文 zod 报文）
   - **C 块的决策点**：引入 `publish` 级技能让「阻断」生产可见？`content_rewrite` 无撤销的护栏确认
6. 本地提交数与推送提示（`git log origin/main..HEAD --oneline | wc -l`；**push 由用户自己做**）

- [ ] **Step 10: 更新 `HANDOFF-agent-p1-remaining.md`**

- §一 状态行：B 块改为「已完成并验收」；
- §五 验收总清单：第 1/2/3/4/5/6 条改 ✅（含一条实测说明），第 9 条更新为最新基线；
- §四 建议顺序：只剩 C 块，删除「B 优先」的建议段。

- [ ] **Step 11: 提交**

```bash
git add docs/superpowers/HANDOFF-agent-p1b.md docs/superpowers/HANDOFF-agent-p1-remaining.md
git commit -m "docs(agent): P1-B 交接说明与验收清单对账（C 块剩余）"
```

---

## 五、验收清单（对照 P1 设计稿 §7.2 中属于 B 块的部分）

- [ ] 第 1 条 `/agent` 出现在侧边栏且可访问（Task 12 Step 1）
- [ ] 第 2 条 发消息后无需刷新即可看到工具卡与助手文字逐步出现（Task 12 Step 2）
- [ ] 第 3 条 工具卡的 4 种状态都渲染正确（`blocked` / 夹具 `failed` 用 Task 11 的脚本确定性验收；`not_executed` 归在「失败」样式）
- [ ] 第 4 条 工件卡片出现且点击能跳到对应模块（Task 12 Step 4）
- [ ] 第 5 条 刷新后历史完整且不重复渲染（Task 12 Step 5；归并幂等由 `agent-state.test.ts` 钉死）
- [ ] 第 6 条 空闲时轮询降速（前端侧 = 重连间隔 5s / 500ms，Task 12 Step 6；服务端侧 A 块已完成）
- [ ] 第 7 条 取消 pending → 200、running → 409（A 块已完成；前端入口 Task 12 Step 7）
- [ ] 第 9 条 `npx vitest run` / `npx tsc --noEmit` / `npx next build` 全绿 + 两个端到端脚本通过（Task 12 Step 8）
- [ ] 第 8 条属于 C 块，不在本计划范围

---

## 六、本计划的已知风险

| 风险 | 触发条件 | 处理 |
|---|---|---|
| SSE 在 dev 下被缓冲 | Next.js 对 GET 做静态优化 | A 块已加 `export const dynamic = "force-dynamic"` 并用脚本实测；Task 12 Step 2 会再次肉眼确认「逐步出现」 |
| 快照替换丢帧（水位回退后没重连） | 忘记在应用快照后 `streamKey + 1` | `resync` / `handleSelect` 已封装配对逻辑；`agent-state.ts` 文件头与页面文件头都写明；Task 12 Step 5 专门验「不重复 + 不缺」 |
| 同一张工具卡渲染两遍 | 用了 `toolCallId` 而不是 `runId:toolCallId` 归并 | 复合键由 `toolCardKey` 唯一构造；单测有「跨 Run 同名 call_1」用例钉死 |
| 快照恰落在 `agent_end` 与 `finishRun` 之间的毫秒级窗口 → UI 卡「执行中」 | 一次快照请求的响应刚好与该窗口重叠（刷新/选择/发送时） | Task 10 的 `settleRunStatus`：执行中每 5s 只发 `runStatus` 动作校正（不重连、不动时间线）；Task 12 交接文档登记成因 |
| 前端契约与 `shared.ts` 手工镜像漂移 | 服务端改了字段名/类型/键集合，前端没跟 | Task 2 加的 `Mirror` 类型级断言：漂移会让 `tsc` 直接失败（`import type` 不进客户端包） |
| `next build` 把 dev 的 `.next` 覆盖成坏状态 | 先 build 后继续用 dev | 硬约束 9；Task 12 Step 8 按顺序执行 |
| 残留 worker 用旧代码领任务 | 任务中断后没按进程树清 | 硬约束 8；Task 12 起手先清 |
| React 严格模式下 effect 双跑导致 SSE 双连接 | dev 模式 `reactStrictMode`（若开启） | 重连逻辑天然幂等（同一水位重放 + 身份幂等归并）；双流只是多一次查询，不产生重复渲染 |
