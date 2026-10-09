# Agent 工作台 P1-A 实现计划（D23 + 接口层）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Agent 工作台的后端在浏览器可用 —— 8 个 REST/SSE 接口可独立验收，且中间过程的助手文本与工具卡摘要都落库，为 P1-B 前端提供联调契约。

**Architecture:** worker 与 Next.js API 是两个进程、只经 PostgreSQL 通信（P1 设计稿 §3.1）。SSE 因此是「API 每 500ms 查 `agent_events` 再转发」的形态（D22），有未结束的 Run 时快查、全部结束降速到 5s。工具卡摘要在服务端算好写进 `agent_tool_calls.summary`（D21）—— 前端不能 import `skill-catalog.ts`（它 import 了 prisma 与多个 service）。

**Tech Stack:** Next.js 15.5 Route Handlers / TypeScript 5.9 / Prisma 6 / PostgreSQL 18 / vitest 3 / Node 24 / tsx / zod / antd 6（本阶段不涉及前端）

**设计依据:**
- `docs/superpowers/specs/2026-10-09-agent-workspace-p1-design.md`（P1 设计稿，D19–D25）
- `docs/superpowers/specs/2026-10-09-agent-workspace-design.md`（P0 设计稿，D1–D18）

**前置:** P0 已合并入 `main`。开工前跑基线，必须是 20 文件 / 203 用例全绿、`tsc --noEmit` 干净：

```bash
npx vitest run          # 期望 Test Files 20 passed / Tests 203 passed
npx tsc --noEmit        # 期望无输出
```

> **关于各 Task 里的用例数**：下面的期望值是编写计划时的快照。每完成一个任务都会新增用例，因此**执行时以「全绿」为准**；数字对不上先确认新测试是否被收集（vitest 只收 `src/**/*.test.ts`），不要当成回归。

**本计划只覆盖 A 块**（设计稿 §十 的 D23 + A 块）。C 块（7 个新工具）与 B 块（前端）另有计划，见 `docs/superpowers/plans/`。

### 执行进度

| 任务 | 状态 | 提交 |
|---|---|---|
| Task 1 D23 保留过程文本 | ✅ 已验收 | `4f5c745` `6e8df02`（评审修正） |
| Task 2 P0 端到端回归 | ✅ 通过（`P0 验收全部通过`） | — |
| Task 3 `handle()` 加宽 | ✅ 已验收 | `8e3dd4f` |
| Task 6 轮询间隔纯函数 | ✅ 已验收 | `8c2ed18` |
| Task 7 SSE 事件工具 | ✅ 已验收 | `138e2c9` `4d4af98`（评审修正） |
| Task 4/5 摘要列与工具摘要 | ⬜ 未开始 | |
| Task 8/9 服务层与序列化 | ⬜ 未开始 | |
| Task 10-12 接口 1/2/3/8/4 | ⬜ 未开始 | |
| Task 13-15 接口 6/7 与 SSE | ⬜ 未开始 | |
| Task 16 A 块端到端验收 | ⬜ 未开始 | |
| Task 17 回归与交接文档 | ⬜ 未开始 | |

**当前基线**：22 文件 / 220 用例全绿，`tsc --noEmit` 无输出。

---

## 一、必读硬约束（实测所得，违反必返工）

| # | 约束 | 出处 |
|---|---|---|
| 1 | **`.mts` 后缀是运行时的硬性要求**（Pi 包 ESM-only）。`.mts` 文件内所有相对导入必须显式写后缀 | P0 D17 |
| 2 | **`serializeEventForDb` 的 `message_end` 改动是对 P0 已验收代码的修改** —— 走完 Task 1 必须重跑 P0 端到端验收（Task 2） | P1 设计稿 §八 缺口 1 |
| 3 | **`handle()` 是 148 个路由共用的公共层**（`core/route.ts:16`）。加宽返回值类型后必须 `tsc` + 全量测试 + `next build` 三查 | P1 设计稿 §3.4 / 风险 3 |
| 4 | **前端不能 import `skill-catalog.ts`** —— 摘要必须在服务端算好落库 | P1 设计稿 D21 |
| 5 | **时间一律用朴素上海墙钟** `shanghaiNow()`；原始 SQL 里用 `now() AT TIME ZONE 'Asia/Shanghai'`。新增表的 `createdAt`/`finishedAt` 无库级默认值，**必须显式传** | P0 交接 §5.2 |
| 6 | **单元测试不得触达外部 API**（`hot_refresh` 会打真实小红书接口）。本计划的单测只覆盖纯函数 | P0 交接 §5.4 |
| 7 | vitest 的 `include` 是 `src/**/*.test.ts` —— **测试必须是 `.ts`**（不能是 `.mts`），且与源码同目录 | `vitest.config.ts` |

---

## 二、与设计稿的偏差（本计划为准，均已核实）

| # | 设计稿原文 | 实际情况 | 本计划采用 |
|---|---|---|---|
| D1 | §4.4 首屏契约只有 `messages` / `tool_calls` / `artifacts` / `latest_event_id` | §7.2 验收项写「刷新页面后历史完整」，但中间过程助手文本只存在于 `agent_events`，刷新后会消失 | **响应体增加 `events` 字段**（id ≤ `latest_event_id` 的可渲染事件）。渲染规则统一为：user 消息来自 `messages`，助手文本一律来自事件（用户已确认） |
| D2 | §4.3 摘要只写进 `agent_tool_calls.summary` | 实时工具卡由 SSE 的 `tool_execution_end` 事件驱动，该事件载荷里没有 summary —— 实时卡片会缺摘要，与 D21「一眼看懂」冲突 | **SSE 侧给 `tool_execution_end` 帧补 `payload.summary`**（服务端查库补齐，仍满足「前端不 import skill-catalog」） |
| D3 | §4 接口表项 8「删除会话（DB 级联清消息与 Run）」 | Prisma 级联只覆盖**声明了关系**的表（`agent_messages` / `agent_runs`）。`agent_events` / `agent_tool_calls` / `tasks` 与 Run 之间只有裸整数外键，**不显式删会留孤儿行** | 删除会话时在一个事务里连同 events / tool_calls / tasks 一起清 |
| D4 | 接口表未提并发保护 | 同一会话并行两个 Run 会交叉写 `agent_messages`，把 LLM 上下文搅乱（worker 并发上限是 3） | **`POST /messages` 在会话已有 pending/running 时返回 409** |
| D5 | 未提 `result` 体积 | `agent_tool_calls.result` 存的是工具产出原文，最大可到工具文本上限 20k 字符；首屏接口会把它整体塞进响应 | 序列化时 **截断到 4000 字符**并置 `result_truncated: true` |
| D6 | §四写「统一套 `handle()` 包装（含 SSE 路由）」 | `handle()` 的类型是 `Promise<NextResponse>`，流式响应返回的是普通 `Response` | 按 §3.4 加宽为 `Promise<Response> \| Response`（Task 3） |

---

## 三、文件结构

**新增（服务端纯函数，可离线单测）**

| 文件 | 职责 |
|---|---|
| `src/lib/agent/polling.ts` | SSE 轮询间隔决策。放在 `lib/agent/`（不是 `lib/server/`）因为**前端也要用它**决定重连节奏，且本文件无任何服务端依赖 |
| `src/lib/server/agent/stream-events.ts` | SSE 帧编码、可渲染事件判定、`tool_execution_end` 摘要补齐（全部纯函数） |
| `src/lib/server/agent/tool-summary.ts` | 工具卡摘要的唯一入口（调 `SkillDefinition.summarize`，自带兜底） |

**新增（API 路由，全部在 `src/app/api/agent/`）**

| 文件 | 接口 |
|---|---|
| `conversations/route.ts` | ① GET 列表 ② POST 新建 |
| `conversations/[id]/route.ts` | ③ GET 首屏详情 ⑧ DELETE 删除会话 |
| `conversations/[id]/messages/route.ts` | ④ POST 发消息建 Run |
| `conversations/[id]/events/route.ts` | ⑤ GET SSE 订阅 |
| `conversations/[id]/artifacts/route.ts` | ⑥ GET 工件列表 |
| `runs/[runId]/cancel/route.ts` | ⑦ POST 取消（仅 pending） |
| `shared.ts` | 序列化单一真相源（首屏与工件接口共用同一形状） |

**新增（脚本）**

| 文件 | 职责 |
|---|---|
| `src/scripts/agent-api-smoke.ts` | A 块端到端验收（真 HTTP + 真 SSE + 真 worker） |

**修改**

| 文件 | 改动 |
|---|---|
| `src/lib/server/agent/persist.ts` | D23：`message_end` 保留助手文本；`persistToolCall` / `finalizeToolCall` 支持 `summary` |
| `src/lib/server/agent/persist.test.ts` | 同步 D23 的两条断言 |
| `src/lib/server/core/route.ts` | `handle()` 返回值类型加宽 |
| `prisma/schema.prisma` | `AgentToolCall` 增加 `summary` 列 |
| `src/lib/server/agent/skill-catalog.ts` | `SkillDefinition` 增加**必填** `summarize`；6 个既有技能各补一份 |
| `src/lib/server/agent/skill-catalog.test.ts` | 断言每个技能都有可用的 `summarize` |
| `src/lib/server/agent/agent-loop.mts` | 阻断路径与执行路径都把摘要传入落库 |
| `src/lib/server/agent/agent-loop.test.ts` | 断言摘要随工具调用落库 |
| `src/lib/server/services/agent-service.ts` | 新增查询 / 取消 / 删除能力 |

---

## 四、任务

### Task 1: D23 —— `message_end` 保留助手文本

**为什么先做**：它是 SSE 能推出有用内容的前提（设计稿 §八 缺口 1），且修改的是 P0 已验收代码，越早暴露回归越好。**另一个隐藏收益**：`snake_case` 序列化层（Task 9）与 SSE 的「可渲染事件」判定都依赖「`message_end` 载荷里有 `text`」这个事实。

**Files:**
- Modify: `src/lib/server/agent/persist.ts:11-38`
- Test: `src/lib/server/agent/persist.test.ts:24-46`

- [ ] **Step 1: 改测试（先让新断言失败）**

把 `persist.test.ts` 的 `message_update` 用例保留不动，替换原来那条 `message_end` 用例（原断言 `payload.trimmed === true` 在新行为下必然失败），并补两条：

```ts
  it("message_end 保留助手正文与 usage（D23：过程文本必须落库）", () => {
    const serialized = serializeEventForDb({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "我先查一下当前热点，" },
          { type: "toolCall", id: "call-1", name: "hot_refresh", arguments: {} },
          { type: "text", text: "再生成选题。" },
        ],
        usage: { input: 100, output: 20, totalTokens: 120 },
      },
    });
    const payload = serialized.payload as Record<string, unknown>;
    expect(payload.role).toBe("assistant");
    // 只拼 text 块：toolCall 块的 arguments 不能混进正文
    expect(payload.text).toBe("我先查一下当前热点，再生成选题。");
    // usage 是 token 基线的唯一来源，P0 验收脚本会断言它在
    expect(payload.usage).toEqual({ input: 100, output: 20, totalTokens: 120 });
  });

  it("message_end 的 user / toolResult 消息不留正文（避免与 agent_messages 重复渲染）", () => {
    const userEnd = serializeEventForDb({
      type: "message_end",
      message: { role: "user", content: [{ type: "text", text: "帮我出选题" }] },
    });
    expect(userEnd.payload as Record<string, unknown>).toEqual({ role: "user" });

    // Pi 的工具结果消息角色是 "toolResult"（不是 "tool"，见 pi-ai 的 types.d.ts）
    const toolEnd = serializeEventForDb({
      type: "message_end",
      message: { role: "toolResult", content: [{ type: "toolResult", content: "ok" }] },
    });
    expect(toolEnd.payload as Record<string, unknown>).toEqual({ role: "toolResult" });
  });

  it("message_end 内容为空时仍落一条（前端靠它判断该步结束）", () => {
    const serialized = serializeEventForDb({ type: "message_end", message: { role: "assistant", content: [] } });
    expect(serialized.payload as Record<string, unknown>).toEqual({ role: "assistant" });
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/lib/server/agent/persist.test.ts`
Expected: FAIL —— `expected {role: 'assistant', trimmed: true, ...} to deeply equal ...`（正文被裁）

- [ ] **Step 3: 实现**

`src/lib/server/agent/persist.ts`：把 `message_end` 从 `TRIMMED_EVENT_TYPES` 里摘出，单独分支处理，并新增 `extractMessageText`。

```ts
/** 体积较大的事件类型：只记录摘要，不记录完整消息体 */
const TRIMMED_EVENT_TYPES = new Set(["message_update", "message_start"]);

/**
 * 从消息的 content 块里拼出纯文本（只认 text 块，工具调用块跳过）。
 *
 * 用结构化最小接口而不是 import Pi 的 AssistantMessage —— 本文件刻意不含 Pi 依赖，
 * 才能在 Next.js 侧与 vitest 里安全 import（见文件头）。
 */
export function extractMessageText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: string; text: string } => {
      if (block === null || typeof block !== "object") return false;
      const candidate = block as { type?: unknown; text?: unknown };
      return candidate.type === "text" && typeof candidate.text === "string";
    })
    .map((block) => block.text)
    .join("");
}
```

`serializeEventForDb` 整体改为（其余分支与原来逐字相同，只有 `message_end` 被摘出来单独处理）：

```ts
export function serializeEventForDb(event: Record<string, unknown>): SerializedEvent {
  const type = String(event.type ?? "unknown");

  // D23：message_end 保留助手正文 —— 前端据此渲染「我先查一下热点」这类过程预告。
  // message_start / message_update 仍然裁掉：单轮约 300 条增量 vs 一次运行几条整段，
  // 体积差两个数量级（P1 设计稿 D23）。
  if (type === "message_end") {
    const message = event.message as { role?: string; content?: unknown; usage?: unknown } | undefined;
    const role = String(message?.role ?? "assistant");
    const payload: Record<string, unknown> = { role };
    // 只留助手正文：user 消息的正文由 agent_messages 承担（首屏接口单独返回），
    // 两处都存会让前端有两条渲染来源，必然重复。
    if (role === "assistant") {
      const text = extractMessageText(message?.content);
      if (text) payload.text = text;
    }
    // usage 是 P0 唯一的 token 明细来源（agent_runs.tokens_used 之外的明细），
    // 体积很小，必须保留；P0 验收脚本会断言它在。
    if (message?.usage !== undefined) payload.usage = message.usage;
    return { type, payload: payload as Prisma.InputJsonValue };
  }

  if (TRIMMED_EVENT_TYPES.has(type)) {
    const message = event.message as { role?: string } | undefined;
    const payload: Record<string, unknown> = { role: message?.role ?? "assistant", trimmed: true };
    return { type, payload: payload as Prisma.InputJsonValue };
  }

  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event)) {
    if (key === "type") continue;
    payload[key] = value as unknown;
  }
  return { type, payload: payload as Prisma.InputJsonValue };
}
```

**注意**：`trimmed` 标记只被 `persist.ts` 自己写过、被 `persist.test.ts` 断言过，全项目无其他读取方（已 grep 确认），所以 `message_end` 不再写 `trimmed` 是安全的。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/lib/server/agent/persist.test.ts`
Expected: PASS（11 个用例 —— 原 9 条减去被替换的 1 条，加上新增 3 条）

- [ ] **Step 5: 全量单测**

Run: `npx vitest run`
Expected: 20 文件全绿。`persist.test.ts` 以外的用例不应受影响 —— 若有失败，先确认不是本改动引起。

- [ ] **Step 6: 提交**

```bash
git add src/lib/server/agent/persist.ts src/lib/server/agent/persist.test.ts
git commit -m "feat(agent): message_end 保留助手过程文本（D23，为 P1 SSE 提供可渲染内容）"
```

---

### Task 2: D23 回归 —— 重跑 P0 端到端验收

**为什么单独一个任务**：设计稿 §7.3 明确要求「P1 修改了 P0 已验收的代码，必须重跑 P0 验收」。这是唯一能证明 D23 没有破坏 `tokensUsed` / usage 落库的方式（P0 验收脚本有 `hasUsage` 断言）。

**Files:**
- 只读验证，不改代码

- [ ] **Step 1: 确认数据库可达**

Run: `npx prisma db pull --print > /dev/null && echo OK`
Expected: `OK`（宿主 PostgreSQL 18，`localhost:5432`）

- [ ] **Step 2: 确认没有残留 worker 进程**

Run（PowerShell）:

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*worker/index.mts*' } |
  Select-Object ProcessId, CreationDate, CommandLine
```

Expected: 无输出。有输出就按交接文档 §五 的 `Stop-Process` 清掉 —— **残留 worker 会用旧代码领任务，导致「改了代码行为没变」的假象**（P0 验收时实际踩过）。

- [ ] **Step 3: 启动 worker（终端 A，保持运行）**

Run: `npx tsx src/worker/index.mts`

- [ ] **Step 4: 跑 P0 验收脚本（终端 B）**

Run: `npx tsx src/scripts/agent-smoke.ts`
Expected: 依次打印「正常路径验收通过」「失败路径验收通过」「崩溃清扫验收通过」，最后 `P0 验收全部通过`，退出码 0。

**若 `hasUsage` 断言失败**：说明 Task 1 把 usage 一起弄丢了 —— 回 Task 1 Step 3 检查 `if (message?.usage !== undefined) payload.usage = message.usage;` 是否还在 `message_end` 分支里。

- [ ] **Step 5: 停掉 worker**

用 Step 2 的命令再查一次并 `Stop-Process -Id <pid> -Force`。**不要只用 `TaskStop`** —— Windows 上它杀不掉 worker 派生的子 `node` 进程。

- [ ] **Step 6: 无需提交**（本任务不改代码）

---

### Task 3: 公共层 —— `handle()` 返回值类型加宽

**Files:**
- Modify: `src/lib/server/core/route.ts:5,16`

- [ ] **Step 1: 加宽类型**

`NextResponse` 在加宽后不再被引用，**必须从 type import 里去掉**（`noUnusedLocals` 会报错）：

```ts
import type { NextRequest } from "next/server";
```

```ts
/**
 * 路由处理函数。返回值放宽到 `Response` 而非 `NextResponse`：
 * SSE 等流式接口返回的是 `new Response(readableStream)`。
 * 这是安全的加宽 —— `NextResponse extends Response`，148 个既有路由的返回值
 * 仍然满足该类型，无需逐处修改（P1 设计稿 §3.4）。
 */
export type RouteHandler = (req: NextRequest, ctx: RouteContext) => Promise<Response> | Response;
```

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无输出（若报 TS2322/TS2345 于某些 route.ts，说明该路由的返回类型比 `Response` 更窄，需报告而不是就地断言）

- [ ] **Step 3: 全量单测**

Run: `npx vitest run`
Expected: 20 文件 / 205 用例全绿（Task 1 已把基线从 203 提到 205）

- [ ] **Step 4: 生产构建（148 个路由的零回归证据）**

Run: `npx next build`
Expected: 构建成功。**记下构建输出里路由总数**，与 P0 基线一致（本任务不新增路由，只是类型加宽）。

- [ ] **Step 5: 提交**

```bash
git add src/lib/server/core/route.ts
git commit -m "refactor(core): handle() 返回值加宽到 Response，支持流式路由（无行为变更）"
```

---

### Task 4: `agent_tool_calls.summary` 列

**Files:**
- Modify: `prisma/schema.prisma:709-725`（`AgentToolCall`）

- [ ] **Step 1: 加列**

```prisma
/// 工具调用：审计与度量
model AgentToolCall {
  id         Int      @id @default(autoincrement())
  runId      Int      @map("run_id")
  stepIndex  Int      @map("step_index")
  toolName   String   @map("tool_name")
  toolCallId String   @map("tool_call_id")
  params     Json
  result     Json?
  status     String   @default("running")
  errorType  String?  @map("error_type")
  durationMs Int?     @map("duration_ms")
  /// 工具卡摘要：服务端用 SkillDefinition.summarize 算好（D21）。
  /// 必须是列而不是读时计算 —— 被阻断的行 result 为 null，
  /// 可读原因只存在于 guard 的返回值里，落库时是唯一同时握有「工具+结果+原因」的时刻。
  summary    String?
  createdAt  DateTime @map("created_at")

  @@index([runId, stepIndex])
  @@map("agent_tool_calls")
}
```

- [ ] **Step 2: 同步数据库与客户端**

项目**没有 `prisma/migrations/` 目录**（用 `db push` 管理，见 `package.json` 的 `db:push` 脚本），因此：

Run: `npx prisma db push`
Expected: `Your database is now in sync with your Prisma schema.`

Run: `npx prisma generate`
Expected: `Generated Prisma Client`

- [ ] **Step 3: 确认列真的建出来了**

Run:
```bash
npx tsx -e 'import("./src/lib/server/core/db.ts").then(async ({ prisma }) => { const rows = await prisma.$queryRawUnsafe("SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = $q$agent_tool_calls$q$ AND column_name = $q$summary$q$"); console.log(rows); await prisma.$disconnect(); })'
```
Expected: `[ { column_name: 'summary', data_type: 'text', is_nullable: 'YES' } ]`

（用 `$q$…$q$` 做 SQL 字符串定界是为了让整条命令可以放在单引号里 —— 单引号内不能转义单引号。）

- [ ] **Step 4: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无输出

- [ ] **Step 5: 提交**

```bash
git add prisma/schema.prisma
git commit -m "feat(db): agent_tool_calls 新增 summary 列（D21 工具卡摘要）"
```

---

### Task 5: 工具卡摘要 —— `SkillDefinition.summarize` + 落库接线

**Files:**
- Modify: `src/lib/server/agent/skill-catalog.ts:42-215`（接口 + 6 个技能）
- Create: `src/lib/server/agent/tool-summary.ts`
- Test: `src/lib/server/agent/tool-summary.test.ts`（新建）、`src/lib/server/agent/skill-catalog.test.ts`（追加）
- Modify: `src/lib/server/agent/persist.ts`（两个落库函数的 `summary` 参数）
- Modify: `src/lib/server/agent/agent-loop.mts:287-388`（两处调用点）
- Test: `src/lib/server/agent/agent-loop.test.ts`（追加两条）

`persist.test.ts` **不动** —— 它只覆盖 `serializeEventForDb` 与 `extractArtifacts`，`persistToolCall` / `finalizeToolCall` 的 DB 写入由 Task 16 的端到端脚本覆盖（与 P0 的做法一致）。

- [ ] **Step 1: 写失败的测试 —— 摘要入口**

新建 `src/lib/server/agent/tool-summary.test.ts`：

```ts
/**
 * 工具卡摘要单元测试
 *
 * 摘要必须由服务端算好写进 agent_tool_calls.summary（D21）：
 * skill-catalog.ts import 了 prisma 与多个 service，前端不能 import 它。
 */
import { describe, expect, it, vi } from "vitest";
import { findSkillDefinition } from "./skill-catalog";
import { buildToolCallSummary } from "./tool-summary";

describe("buildToolCallSummary（工具卡摘要）", () => {
  it("按目录里的 summarize 生成摘要", () => {
    expect(buildToolCallSummary({ toolName: "hot_refresh", details: { collected: 87 }, isError: false })).toBe(
      "收录 87 条热点",
    );
    expect(buildToolCallSummary({ toolName: "topic_generate", details: { suggestion_ids: [1, 2, 3] }, isError: false })).toBe(
      "生成 3 个选题",
    );
    expect(
      buildToolCallSummary({
        toolName: "content_note_pack",
        details: { draft_id: 128, titles: ["露营装备清单"] },
        isError: false,
      }),
    ).toBe("已保存草稿 #128：《露营装备清单》");
    expect(buildToolCallSummary({ toolName: "review_submit", details: { review_id: 7, gate_status: "warning" }, isError: false })).toBe(
      "审校工单 #7，门禁 warning",
    );
    expect(buildToolCallSummary({ toolName: "script_generate", details: { script: "开场钩子…" }, isError: false })).toBe(
      "生成脚本 5 字",
    );
    expect(buildToolCallSummary({ toolName: "schedule_recommend", details: { slots: [{}, {}] }, isError: false })).toBe(
      "推荐 2 个发布时段",
    );
  });

  it("被护栏阻断时用 guard 给的 reason（该路径没有 details）", () => {
    const reason = "工具「not_exist」未在技能目录中注册，不可调用。请只使用已提供的工具。";
    expect(buildToolCallSummary({ toolName: "not_exist", details: {}, isError: false, blockedReason: reason })).toBe(reason);
  });

  it("执行失败时给固定说明，不把原始错误当摘要", () => {
    expect(buildToolCallSummary({ toolName: "hot_refresh", details: {}, isError: true })).toBe("执行失败（展开可见错误详情）");
  });

  it("未登记的工具返回空串而不是抛错（fail-soft：摘要不能拖垮循环）", () => {
    expect(buildToolCallSummary({ toolName: "not_exist", details: {}, isError: false })).toBe("");
  });

  it("summarize 自身抛错时返回空串", () => {
    const definition = findSkillDefinition("hot_refresh");
    if (!definition) throw new Error("测试前提失败：hot_refresh 不在目录里");
    const original = definition.summarize;
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    definition.summarize = () => {
      throw new Error("boom");
    };
    try {
      expect(buildToolCallSummary({ toolName: "hot_refresh", details: {}, isError: false })).toBe("");
    } finally {
      definition.summarize = original;
      spy.mockRestore();
    }
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/lib/server/agent/tool-summary.test.ts`
Expected: FAIL —— `Failed to resolve import "./tool-summary"`

- [ ] **Step 3: 实现 `tool-summary.ts`**

```ts
/**
 * 工具卡摘要的唯一入口（D21）
 *
 * 摘要必须**在服务端算好落库**：skill-catalog.ts import 了 prisma 与多个 service，
 * 前端一旦 import 它就会把整条 DB 依赖链打进客户端包。落库时是唯一同时握有
 * 「工具 + 结果 + 阻断原因」的时刻（被阻断的行 result 为 null）。
 */
import { findSkillDefinition } from "./skill-catalog";

/** 被护栏阻断时的兜底文案（正常路径永远用 guard 给的 reason） */
const BLOCKED_FALLBACK = "被护栏阻断";
/** 工具执行失败时的摘要（原始错误文本在 result 里，展开可见） */
const FAILED_SUMMARY = "执行失败（展开可见错误详情）";

export interface ToolCallSummaryInput {
  toolName: string;
  details: Record<string, unknown>;
  isError: boolean;
  /** 仅阻断路径传：guard 返回的 reason */
  blockedReason?: string | null;
}

export function buildToolCallSummary(input: ToolCallSummaryInput): string {
  if (input.blockedReason) return input.blockedReason;
  if (input.blockedReason === "") return BLOCKED_FALLBACK;
  if (input.isError) return FAILED_SUMMARY;

  const definition = findSkillDefinition(input.toolName);
  if (!definition) return "";
  try {
    return definition.summarize(input.details) || "";
  } catch (error) {
    // 摘要只是展示层：算错不能影响循环 —— 工具结果已经写进 agent_tool_calls 了
    console.error(`[agent] 摘要生成失败（${input.toolName}）`, error);
    return "";
  }
}
```

- [ ] **Step 4: 给 `SkillDefinition` 加必填 `summarize` 并补 6 个技能**

`skill-catalog.ts` 的接口增加字段（放在 `artifact` 之后）：

```ts
export interface SkillDefinition {
  skillKey: string;
  name: string;
  description: string;
  paramsSchema: Record<string, unknown>;
  /** SKILL.md 风格指令正文（Markdown，含 frontmatter） */
  instructions: string;
  /** 护栏分级：read 直接执行 / write 产出待验收 / publish 需人工确认 */
  riskLevel: SkillRiskLevel;
  /** 产出物声明，驱动工件面板 */
  artifact?: ArtifactSpec;
  /**
   * 工具卡摘要：把产出浓缩成一行给用户「一眼看懂」（D21）。
   * **必填** —— 选 D21 的既定成本就是每个工具都要写一份（P1 设计稿 §6.5）。
   * 服务端算好写进 agent_tool_calls.summary，前端不 import 本文件。
   */
  summarize: (details: Record<string, unknown>) => string;
}
```

在同文件内、`SKILL_CATALOG` 之前加计数助手：

```ts
/**
 * 摘要里安全读取「条数」：数组取长度，其余尝试转数字，失败归零。
 * details 的类型是 unknown（工具返回值），不能直接当 number 用。
 */
export function summarizeCount(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
```

6 个技能各补一行（`skillKey` 后按现有字段顺序插入，`artifact` 之后）：

```ts
// hot_refresh
    summarize: (details) => `收录 ${summarizeCount(details.collected)} 条热点`,

// topic_generate
    summarize: (details) => `生成 ${summarizeCount(details.suggestion_ids)} 个选题`,

// content_note_pack
    summarize: (details) => {
      const titles = Array.isArray(details.titles) ? details.titles : [];
      const first = titles.length ? `：《${String(titles[0])}》` : "";
      return `已保存草稿 #${summarizeCount(details.draft_id)}${first}`;
    },

// review_submit
    summarize: (details) =>
      `审校工单 #${summarizeCount(details.review_id)}，门禁 ${String(details.gate_status ?? "未知")}`,

// script_generate
    summarize: (details) => `生成脚本 ${String(details.script ?? "").length} 字`,

// schedule_recommend
    summarize: (details) => `推荐 ${summarizeCount(details.slots)} 个发布时段`,
```

- [ ] **Step 5: 跑摘要测试确认通过**

Run: `npx vitest run src/lib/server/agent/tool-summary.test.ts`
Expected: PASS（5 个用例）

- [ ] **Step 6: 补目录测试**

`skill-catalog.test.ts` 追加：

```ts
  it("每个技能都有 summarize，且对正常产出返回非空摘要", () => {
    for (const item of SKILL_CATALOG) {
      expect(typeof item.summarize, `${item.skillKey}.summarize`).toBe("function");
    }
    const samples: Record<string, Record<string, unknown>> = {
      hot_refresh: { collected: 3 },
      topic_generate: { suggestion_ids: [1] },
      content_note_pack: { draft_id: 1, titles: ["t"] },
      review_submit: { review_id: 1, gate_status: "passed" },
      script_generate: { script: "脚本" },
      schedule_recommend: { slots: [{}] },
    };
    for (const item of SKILL_CATALOG) {
      const summary = item.summarize(samples[item.skillKey] ?? {});
      expect(summary.length, `${item.skillKey} 的摘要不能为空`).toBeGreaterThan(0);
    }
  });
```

Run: `npx vitest run src/lib/server/agent/skill-catalog.test.ts`
Expected: PASS（10 个用例）

- [ ] **Step 7: `persist.ts` 支持 summary**

`persistToolCall` 的 options 增加 `summary?: string | null;`，`data` 里加 `summary: options.summary ?? null,`。
`finalizeToolCall` 的 options 增加 `summary?: string | null;`，`data` 里加 `summary: options.summary ?? undefined,` —— **注意与已有字段的语义差异**（文件内已有注释说明）：`result` 传 null 表示「本次不动这一列」，`errorType`/`durationMs` 传 null 表示「清空」。`summary` 与 `result` 同类（`?? undefined`），因为 both 都是「本次已经算好了就写、没算就不动」。

```ts
export async function persistToolCall(options: {
  runId: number;
  stepIndex: number;
  toolName: string;
  toolCallId: string;
  params: Record<string, unknown>;
  result: Record<string, unknown> | null;
  status: "running" | "succeeded" | "failed" | "blocked";
  errorType?: string | null;
  durationMs?: number | null;
  /** 工具卡摘要（D21）。阻断路径在 beforeToolCall 就已知原因，一并写入 */
  summary?: string | null;
}): Promise<number> {
  const created = await prisma.agentToolCall.create({
    data: {
      runId: options.runId,
      stepIndex: options.stepIndex,
      toolName: options.toolName,
      toolCallId: options.toolCallId,
      params: options.params as Prisma.InputJsonValue,
      result: (options.result ?? undefined) as Prisma.InputJsonValue | undefined,
      status: options.status,
      errorType: options.errorType ?? null,
      durationMs: options.durationMs ?? null,
      summary: options.summary ?? null,
      createdAt: shanghaiNow(),
    },
  });
  return created.id;
}
```

`finalizeToolCall` 同理新增 `summary: options.summary ?? undefined,`。

- [ ] **Step 8: `agent-loop.mts` 接线**

顶部 import 增加：

```ts
import { buildToolCallSummary } from "./tool-summary.ts";
```

**阻断路径**（`beforeToolCall` 里 `status: "blocked"` 那次 `persistToolCallRow`）加一行 `summary`：

```ts
          entry.rowId = await persistToolCallRow({
            runId,
            stepIndex: step,
            toolName: context.toolCall.name,
            toolCallId: context.toolCall.id,
            params: asRecord(context.args),
            result: null,
            status: "blocked",
            errorType: "guard_blocked",
            // 被阻断的调用不走 afterToolCall，摘要只能在这里算（结果为空、原因来自 guard）
            summary: buildToolCallSummary({
              toolName: context.toolCall.name,
              details: {},
              isError: false,
              blockedReason: verdict.reason ?? BLOCKED_REASON_FALLBACK,
            }),
          });
```

文件顶部常量区加：

```ts
/** guard 未给 reason 时的兜底文案（理论上不会发生：阻断分支一定有 reason） */
const BLOCKED_REASON_FALLBACK = "被护栏阻断";
```

**执行路径**（`afterToolCall`）在算出 `details` / `isError` 之后先算摘要，两处落库都带上：

```ts
      const details = asRecord(context.result.details);
      const isError = context.isError;
      const durationMs = entry ? Date.now() - entry.startedAt : null;
      // 摘要与结果同一次写入：落库时是唯一同时握有「工具 + 结果」的时刻（D21）
      const summary = buildToolCallSummary({ toolName: context.toolCall.name, details, isError });

      try {
        if (entry?.rowId != null) {
          await finalizeToolCallRow({
            id: entry.rowId,
            result: details,
            status: isError ? "failed" : "succeeded",
            errorType: isError ? "tool_error" : null,
            durationMs,
            summary,
          });
        } else {
          await persistToolCallRow({
            runId,
            stepIndex: entry?.stepIndex ?? stepIndex,
            toolName: context.toolCall.name,
            toolCallId: context.toolCall.id,
            params: asRecord(context.args),
            result: details,
            status: isError ? "failed" : "succeeded",
            errorType: isError ? "tool_error" : null,
            durationMs,
            summary,
          });
        }
      } catch (error) {
        await notePersistFailure("afterToolCall/toolCall", error);
      }
```

- [ ] **Step 9: 补循环测试**

`agent-loop.test.ts` 追加两条（放在「护栏阻断的调用落一条 blocked 记录」用例之后）：

```ts
  it("工具调用落库时带上摘要（D21）", async () => {
    const { fake, options } = baseOptions({
      tools: [createFakeTool("hot_refresh", { collected: 87 })],
      fakeStreamFn: createScriptedStreamFn([
        assistantToolCall("call-1", "hot_refresh", {}),
        assistantText("热点已刷新"),
      ]),
    });
    await runAgentLoop(options);

    expect(fake.finalized).toHaveLength(1);
    expect(fake.finalized[0]?.summary).toBe("收录 87 条热点");
  });

  it("阻断路径的摘要用 guard 的 reason（该路径不写 finalized）", async () => {
    const { fake, options } = baseOptions({
      tools: [createFakeTool("not_exist", {})],
      fakeStreamFn: createScriptedStreamFn([assistantToolCall("call-1", "not_exist", {}), assistantText("放弃")]),
    });
    await runAgentLoop(options);

    expect(fake.finalized).toHaveLength(0);
    expect(fake.started[0]?.summary).toContain("未在技能目录中注册");
  });
```

Run: `npx vitest run src/lib/server/agent/agent-loop.test.ts`
Expected: PASS（19 个用例）

- [ ] **Step 10: 全量单测 + 类型检查**

Run: `npx vitest run && npx tsc --noEmit`
Expected: 全绿、无输出

- [ ] **Step 11: 提交**

```bash
git add src/lib/server/agent/skill-catalog.ts src/lib/server/agent/skill-catalog.test.ts \
        src/lib/server/agent/tool-summary.ts src/lib/server/agent/tool-summary.test.ts \
        src/lib/server/agent/persist.ts src/lib/server/agent/agent-loop.mts \
        src/lib/server/agent/agent-loop.test.ts
git commit -m "feat(agent): 工具调用落库带摘要（SkillDefinition.summarize + D21）"
```

---

### Task 6: 轮询间隔纯函数（前后端共用）

**Files:**
- Create: `src/lib/agent/polling.ts`
- Test: `src/lib/agent/polling.test.ts`

**为什么放在 `src/lib/agent/` 而不是 `src/lib/server/`**：B 块前端要复用同一个判定决定重连节奏；这个目录下的文件不含任何服务端依赖（prisma / `node:*`），可被客户端安全 import。设计稿 D25 要求把归并 / 降速判定抽成纯函数用现有 vitest 覆盖。

- [ ] **Step 1: 写失败的测试**

```ts
import { describe, expect, it } from "vitest";
import { SSE_ACTIVE_INTERVAL_MS, SSE_IDLE_INTERVAL_MS, nextPollInterval } from "./polling";

describe("nextPollInterval（SSE 轮询降速）", () => {
  it("有未结束的 Run 时快查", () => {
    expect(nextPollInterval(true)).toBe(SSE_ACTIVE_INTERVAL_MS);
  });

  it("全部 Run 已结束时降速（页面挂着不能空转）", () => {
    expect(nextPollInterval(false)).toBe(SSE_IDLE_INTERVAL_MS);
  });

  it("两个间隔必须相差 10 倍以上，否则降速没有意义", () => {
    expect(SSE_IDLE_INTERVAL_MS).toBeGreaterThanOrEqual(SSE_ACTIVE_INTERVAL_MS * 10);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/lib/agent/polling.test.ts`
Expected: FAIL —— `Failed to resolve import "./polling"`

- [ ] **Step 3: 实现**

```ts
/**
 * SSE 轮询间隔决策（前后端共用，P1 设计稿 D22 / D25）
 *
 * 放在 lib/agent/ 而不是 lib/server/：前端也要用它决定重连节奏，
 * 且本文件不含任何服务端依赖（prisma / node:*），可被客户端安全 import。
 *
 * 为什么服务端与前端各要一份同样的判定：服务端用它决定「多久查一次库」，
 * 前端用它决定「多久重连一次」。两者的输入都是「会话里还有没有未结束的 Run」，
 * 抽成同一个纯函数就不会漂移。
 */

/** 会话内有 pending / running 的 Run 时的快查间隔 */
export const SSE_ACTIVE_INTERVAL_MS = 500;

/**
 * 全部 Run 已结束时的降速间隔。
 * 不设这个降速，页面开着就每 500ms 空转一次数据库查询（P1 设计稿 §3.3）。
 */
export const SSE_IDLE_INTERVAL_MS = 5000;

/** 依据「会话内是否还有未结束的 Run」决定下一次轮询间隔（毫秒） */
export function nextPollInterval(hasActiveRun: boolean): number {
  return hasActiveRun ? SSE_ACTIVE_INTERVAL_MS : SSE_IDLE_INTERVAL_MS;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/lib/agent/polling.test.ts`
Expected: PASS（3 个用例）

- [ ] **Step 5: 提交**

```bash
git add src/lib/agent/polling.ts src/lib/agent/polling.test.ts
git commit -m "feat(agent): 抽出 SSE 轮询间隔纯函数（前后端共用，D22/D25）"
```

---

### Task 7: SSE 事件工具纯函数

**Files:**
- Create: `src/lib/server/agent/stream-events.ts`
- Test: `src/lib/server/agent/stream-events.test.ts`

- [ ] **Step 1: 写失败的测试**

```ts
/**
 * SSE 事件工具单元测试
 * 覆盖：帧编码、可渲染事件判定、tool_execution_end 摘要补齐、toolCallId 收集
 */
import { describe, expect, it } from "vitest";
import {
  RENDERABLE_EVENT_TYPES,
  SSE_HEARTBEAT_FRAME,
  attachToolCallSummaries,
  collectToolCallIds,
  encodeSseFrame,
  isRenderableEvent,
} from "./stream-events";

/** 造一条事件行（结构对齐 Prisma 的 agentEvent.findMany 返回值） */
function row(type: string, payload: Record<string, unknown>, id = 1) {
  return { id, runId: 10, type, payload, createdAt: new Date("2026-10-09T10:00:00Z") };
}

describe("encodeSseFrame（帧编码）", () => {
  it("编码为 data: <json>\\n\\n，且 JSON 内不含裸换行", () => {
    const frame = encodeSseFrame({ id: 1, type: "status", payload: { message: "第一行\n第二行" } });
    expect(frame.startsWith("data: ")).toBe(true);
    expect(frame.endsWith("\n\n")).toBe(true);
    // 正文里的换行必须被 JSON 转义，否则会被客户端按帧边界切开
    expect(frame.split("\n\n")).toHaveLength(2);
    expect(JSON.parse(frame.slice(6, -2))).toMatchObject({ id: 1 });
  });

  it("心跳帧是注释行（不含 data: 前缀，客户端会跳过）", () => {
    expect(SSE_HEARTBEAT_FRAME.startsWith(":")).toBe(true);
    expect(SSE_HEARTBEAT_FRAME.endsWith("\n\n")).toBe(true);
  });
});

describe("isRenderableEvent（首屏回放判定）", () => {
  it("过程文本 / 工件 / 状态 / 错误四类要回放", () => {
    expect(RENDERABLE_EVENT_TYPES).toEqual(["message_end", "artifact", "status", "error"]);
    for (const type of RENDERABLE_EVENT_TYPES) expect(isRenderableEvent(type)).toBe(true);
  });

  it("增量与工具执行事件不回放（工具卡由 agent_tool_calls 承担，回放会渲染两遍）", () => {
    expect(isRenderableEvent("message_update")).toBe(false);
    expect(isRenderableEvent("message_start")).toBe(false);
    expect(isRenderableEvent("tool_execution_start")).toBe(false);
    expect(isRenderableEvent("tool_execution_end")).toBe(false);
    expect(isRenderableEvent("agent_end")).toBe(false);
  });
});

describe("collectToolCallIds / attachToolCallSummaries（摘要补齐）", () => {
  it("只从 tool_execution_end 收集，且去重", () => {
    const ids = collectToolCallIds([
      row("tool_execution_start", { toolCallId: "call-1" }),
      row("tool_execution_end", { toolCallId: "call-1" }),
      row("tool_execution_end", { toolCallId: "call-2" }),
      row("message_end", { text: "没有 toolCallId" }),
    ]);
    expect(ids.sort()).toEqual(["call-1", "call-2"]);
  });

  it("给 tool_execution_end 补上 summary，其余事件原样返回", () => {
    const event = row("tool_execution_end", { toolCallId: "call-1", isError: false });
    const other = row("message_end", { toolCallId: "call-1" }, 2);
    const [patched, untouched] = attachToolCallSummaries([event, other], new Map([["call-1", "收录 87 条热点"]]));

    expect((patched.payload as Record<string, unknown>).summary).toBe("收录 87 条热点");
    expect((patched.payload as Record<string, unknown>).isError).toBe(false);
    expect(untouched).toBe(other);
  });

  it("不改写入参行（Pull 事件是 Prisma 返回对象，就地改会污染后续使用者）", () => {
    const event = row("tool_execution_end", { toolCallId: "call-1" });
    attachToolCallSummaries([event], new Map([["call-1", "摘要"]]));
    expect((event.payload as Record<string, unknown>).summary).toBeUndefined();
  });

  it("缺摘要、载荷为 null、toolCallId 非字符串时都不抛错", () => {
    const rows = [
      row("tool_execution_end", { toolCallId: "call-9" }, 1),
      row("tool_execution_end", {}, 2),
      row("tool_execution_end", { toolCallId: 123 }, 3),
    ];
    const patched = attachToolCallSummaries(rows, new Map([["call-1", "摘要"]]));
    expect(patched).toHaveLength(3);
    expect(patched.every((item) => item.payload !== null)).toBe(true);
  });

  it("摘要表为空时直接返回原数组（不产生无谓拷贝）", () => {
    const rows = [row("tool_execution_end", { toolCallId: "call-1" })];
    expect(attachToolCallSummaries(rows, new Map())).toBe(rows);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/lib/server/agent/stream-events.test.ts`
Expected: FAIL —— `Failed to resolve import "./stream-events"`

- [ ] **Step 3: 实现**

```ts
/**
 * SSE 事件工具（纯函数，可离线单测）
 *
 * 全项目此前 0 处 ReadableStream —— 服务端流式契约是从零定义的（P1 设计稿 §八 缺口 2），
 * 因此把「怎么编码帧」「哪些事件要回放」「怎么补摘要」都放在这里，路由只负责编排。
 *
 * 【本文件不含 Pi 依赖】—— 用结构化最小接口接收事件行，便于离线单测。
 * 【有意的类型重复】AgentEventRowLike 与 Prisma 的 AgentEvent 结构一致但不 import 它：
 * 路由传入的是 Prisma 行（多余字段被结构性兼容），测试传入的是字面量对象。
 */

/** 事件行的最小结构（Prisma 的 agentEvent.findMany 返回值满足它） */
export interface AgentEventRowLike {
  id: number;
  runId: number;
  type: string;
  payload: unknown;
  createdAt: Date;
}

/** 心跳帧：SSE 注释行，客户端解析时会被跳过，只为防中间层掐长连接 */
export const SSE_HEARTBEAT_FRAME = ": ping\n\n";

/** 心跳间隔（毫秒） */
export const SSE_HEARTBEAT_MS = 15_000;

/**
 * 首屏要回放的事件类型（接口 3 的 `events` 字段）。
 *
 * 组成理由：
 *   message_end —— 中间过程助手文本（D23 让它的载荷里有 text）
 *   artifact    —— 右栏工件（首屏与 artifacts 接口同源）
 *   status      —— 终态结论与告警（循环里写入的 level/message）
 *   error       —— 循环级异常（如「未配置默认文本模型」）
 *
 * **不含** tool_execution_* 与 message_update：工具卡由 agent_tool_calls 承担
 * （按 tool_call_id 归并），把它们也回放会让同一张卡片渲染两遍。
 *
 * ⚠️ 前端渲染须知：`message_end` 的 `payload.text` 是**可选**的 —— Pi 对 user /
 * toolResult / system 也会发 message_end（只留 `role`），且升级前落库的旧行是
 * `{role, trimmed:true}`。渲染前必须同时判定 `payload.role === "assistant"`
 * 与 `text` 非空，否则会出现空白气泡。
 */
export const RENDERABLE_EVENT_TYPES = ["message_end", "artifact", "status", "error"] as const;

/** 该事件类型是否要回放给前端（首屏 events 字段用） */
export function isRenderableEvent(type: string): boolean {
  return (RENDERABLE_EVENT_TYPES as readonly string[]).includes(type);
}

/**
 * SSE 帧编码：`data: <json>\n\n`
 *
 * 与项目现有 crawlXhsDataStream 的逐行解析一致（`line.startsWith("data: ")`）。
 * id 放在 JSON 载荷里而不是 SSE 规范的 `id:` 字段 —— 客户端是手工解析，
 * 断线重连直接复用同一个 last_event_id。
 * JSON.stringify 会把内容里的换行转义成 \n，所以单行帧不会被正文切断。
 */
export function encodeSseFrame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** 把 Prisma 的 Json 载荷收窄成普通对象（可能是 null / 数组 / 标量） */
function toPayloadRecord(payload: unknown): Record<string, unknown> {
  return payload !== null && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
}

/** 从一批事件里挑出需要补摘要的 toolCallId（去重） */
export function collectToolCallIds(rows: Array<{ type: string; payload: unknown }>): string[] {
  const ids = new Set<string>();
  for (const row of rows) {
    if (row.type !== "tool_execution_end") continue;
    const toolCallId = toPayloadRecord(row.payload).toolCallId;
    if (typeof toolCallId === "string" && toolCallId) ids.add(toolCallId);
  }
  return [...ids];
}

/**
 * 给 tool_execution_end 的载荷补上 summary。
 *
 * 为什么事件里本来没有摘要：摘要在 afterToolCall 里算好写进 agent_tool_calls.summary（D21），
 * 而事件是 Pi 在 afterToolCall 之后才发出的，循环侧拿不到改写事件的机会
 * （subscribe 只能观察）。前端又不能 import skill-catalog 自己去算
 * （会把 prisma 打进客户端包），所以在 SSE 出口补齐 —— 服务端算、前端只渲染。
 *
 * 时序是安全的：afterToolCall 的落库 await 完成后 Pi 才发 tool_execution_end，
 * 因此事件行存在时摘要一定已经提交（P1 设计稿 §4.3 的落地细节）。
 */
export function attachToolCallSummaries<T extends AgentEventRowLike>(
  rows: T[],
  summaries: Map<string, string>,
): T[] {
  if (summaries.size === 0) return rows;
  return rows.map((row) => {
    if (row.type !== "tool_execution_end") return row;
    const payload = toPayloadRecord(row.payload);
    const toolCallId = payload.toolCallId;
    if (typeof toolCallId !== "string") return row;
    const summary = summaries.get(toolCallId);
    if (!summary) return row;
    // 不就地改：rows 是 Prisma 返回对象，就地改会污染调用方的数据
    return { ...row, payload: { ...payload, summary } };
  });
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/lib/server/agent/stream-events.test.ts`
Expected: PASS（9 个用例）

- [ ] **Step 5: 提交**

```bash
git add src/lib/server/agent/stream-events.ts src/lib/server/agent/stream-events.test.ts
git commit -m "feat(agent): SSE 帧编码 / 可渲染事件判定 / 工具摘要补齐（纯函数）"
```

---

### Task 8: `agent-service` 新增查询、取消、删除能力

**Files:**
- Modify: `src/lib/server/services/agent-service.ts`（追加，不改既有函数）
- Test: `src/lib/server/services/agent-service.test.ts`（追加纯逻辑用例）

**约定**：DB 交互部分不在单测里覆盖（沿用 P0 的做法 —— 该文件现有测试只覆盖纯逻辑，DB 由 Task 16 的端到端脚本覆盖）。

- [ ] **Step 1: 追加纯逻辑测试**

`agent-service.test.ts` 追加：

```ts
describe("cancelPendingRun 的判定入口（纯逻辑部分）", () => {
  it("终态 Run 不允许取消", () => {
    // 与 isRunTerminal 同源：取消接口用它决定 409
    expect(isRunTerminal("succeeded")).toBe(true);
    expect(isRunTerminal("failed")).toBe(true);
    expect(isRunTerminal("cancelled")).toBe(true);
    expect(isRunTerminal("pending")).toBe(false);
    expect(isRunTerminal("running")).toBe(false);
  });
});
```

（该用例组与已有的 `isRunTerminal` 用例重复一条是有意的：取消接口的 409 分支就依赖它，改动该函数必须让两处都失败。）

- [ ] **Step 2: 跑测试**

Run: `npx vitest run src/lib/server/services/agent-service.test.ts`
Expected: PASS（9 个用例）

- [ ] **Step 3: 追加服务函数**

`agent-service.ts` 顶部 import 改为：

```ts
import type { AgentConversation, AgentEvent, AgentMessage, AgentRun, AgentToolCall, Prisma } from "@prisma/client";
import { prisma } from "../core/db";
import { notFound } from "../core/http-error";
import { shanghaiNow } from "../core/time";
```

文件末尾追加：

```ts
// ---------- P1-A：接口层查询 ----------

/** 校验会话归属：不存在或不属于该用户一律 404（不泄露「存在但不是你的」） */
export async function findConversationForUser(conversationId: number, userId: number): Promise<AgentConversation> {
  const conversation = await prisma.agentConversation.findFirst({ where: { id: conversationId, userId } });
  if (!conversation) throw notFound("会话不存在");
  return conversation;
}

/**
 * 会话的全部 Run（按 id 升序）。
 * 事件范围一律由它圈定 —— SSE、首屏、工件接口三处共用，避免各写一份查询条件。
 */
export async function listRuns(conversationId: number): Promise<AgentRun[]> {
  return prisma.agentRun.findMany({ where: { conversationId }, orderBy: { id: "asc" } });
}

/** 会话内是否还有未结束的 Run（SSE 降速判定的输入） */
export async function hasActiveRun(conversationId: number): Promise<boolean> {
  const count = await prisma.agentRun.count({
    where: { conversationId, status: { in: ["pending", "running"] } },
  });
  return count > 0;
}

/**
 * 会话的**用户消息**（按 id 升序，中栏历史的 user 气泡）。
 *
 * 只取 role="user"，不是漏了别的角色：助手文本一律来自 agent_events 的 message_end
 * （首屏 `events` 字段与 SSE 同源）。最终答复同时存在于两处 ——
 * agent_messages 的 assistant 行（供 LLM 多轮上下文）与 message_end 事件 ——
 * 若这里把 assistant 行也返回，同一段文本会被渲染两遍。
 */
export async function listConversationUserMessages(conversationId: number, limit = 500): Promise<AgentMessage[]> {
  return prisma.agentMessage.findMany({
    where: { conversationId, role: "user" },
    orderBy: { id: "asc" },
    take: limit,
  });
}

/** 多个 Run 的工具调用（按 id 升序，中栏已完成的工具卡） */
export async function listToolCallsForRuns(runIds: number[]): Promise<AgentToolCall[]> {
  if (runIds.length === 0) return [];
  return prisma.agentToolCall.findMany({ where: { runId: { in: runIds } }, orderBy: { id: "asc" } });
}

/** 多个 Run 的工件事件（按 id 升序，右栏工件） */
export async function listArtifactEvents(runIds: number[]): Promise<AgentEvent[]> {
  if (runIds.length === 0) return [];
  return prisma.agentEvent.findMany({
    where: { runId: { in: runIds }, type: "artifact" },
    orderBy: { id: "asc" },
  });
}

/** 会话全部 Run 的事件 id 上界（无事件为 0）—— 前端 SSE 的续传起点 */
export async function latestEventIdForRuns(runIds: number[]): Promise<number> {
  if (runIds.length === 0) return 0;
  const result = await prisma.agentEvent.aggregate({ where: { runId: { in: runIds } }, _max: { id: true } });
  return result._max.id ?? 0;
}

/**
 * 首屏回放用的历史事件（id ≤ upToId、仅可渲染类型）。
 *
 * 取的是**最新**的 limit 条再翻正序：截断时丢掉的是最早的几条，
 * 而不是把最近的过程文本丢掉（长会话下后者会让用户看不到刚发生的事）。
 */
export async function listRenderableEvents(
  runIds: number[],
  upToId: number,
  types: readonly string[],
  limit: number,
): Promise<AgentEvent[]> {
  if (runIds.length === 0 || upToId <= 0) return [];
  const rows = await prisma.agentEvent.findMany({
    where: { runId: { in: runIds }, id: { lte: upToId }, type: { in: [...types] } },
    orderBy: { id: "desc" },
    take: limit,
  });
  return rows.reverse();
}

/** SSE：取 id > afterId 的新事件（升序，最多 limit 条） */
export async function listEventsAfter(runIds: number[], afterId: number, limit: number): Promise<AgentEvent[]> {
  if (runIds.length === 0) return [];
  return prisma.agentEvent.findMany({
    where: { runId: { in: runIds }, id: { gt: afterId } },
    orderBy: { id: "asc" },
    take: limit,
  });
}

/** 批量取工具调用摘要（SSE 给 tool_execution_end 补摘要用，key 是 toolCallId） */
export async function findToolCallSummaries(toolCallIds: string[]): Promise<Map<string, string>> {
  if (toolCallIds.length === 0) return new Map();
  const rows = await prisma.agentToolCall.findMany({
    where: { toolCallId: { in: toolCallIds }, summary: { not: null } },
    select: { toolCallId: true, summary: true },
  });
  const map = new Map<string, string>();
  for (const row of rows) {
    if (row.summary) map.set(row.toolCallId, row.summary);
  }
  return map;
}

// ---------- P1-A：取消与删除 ----------

/** 取消 Run 的结果：冲突时带上给用户看的原因（路由把它转成 409） */
export type CancelRunResult = { outcome: "cancelled"; run: AgentRun } | { outcome: "conflict"; reason: string };

/**
 * 取消一个 Run —— **仅 pending**（P1 设计稿 D19）。
 *
 * 竞态处理：worker 的 claimPendingRuns 是 `FOR UPDATE SKIP LOCKED` + `status='pending'`，
 * 这里用 `updateMany` 带上同样的 status 条件做原子守卫 —— 若「读到 pending、写时已被领取」，
 * count 为 0，返回冲突而不是把 running 的 Run 标成 cancelled。
 */
export async function cancelPendingRun(runId: number, userId: number): Promise<CancelRunResult> {
  const run = await prisma.agentRun.findFirst({ where: { id: runId, userId } });
  if (!run) throw notFound("Run 不存在");
  if (isRunTerminal(run.status)) {
    return { outcome: "conflict", reason: `Run 已是终态（${run.status}），无需取消` };
  }

  const now = shanghaiNow();
  const updated = await prisma.agentRun.updateMany({
    where: { id: runId, status: "pending" },
    data: { status: "cancelled", errorType: "cancelled_by_user", finishedAt: now },
  });
  if (updated.count === 0) {
    return { outcome: "conflict", reason: "Run 已被 worker 领取并开始执行，P1 不支持中止运行中的任务" };
  }

  // 同步 Task：任务中心里这条 Agent 任务不能永远停在 pending（与 finishRun 同一约定）
  await prisma.task.update({
    where: { id: run.taskId },
    data: { status: "failed", progress: 0, finishedAt: now },
  });

  // 会话必须回到 idle：否则前端会一直停在「执行中」（输入框禁用、发不出下一条）
  if (!(await hasActiveRun(run.conversationId))) {
    await updateConversationStatus({ conversationId: run.conversationId, status: "idle" });
  }

  return { outcome: "cancelled", run: await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } }) };
}

/**
 * 删除会话及其全部关联行。
 *
 * Prisma 的级联**只覆盖声明了关系的表**（agent_messages / agent_runs）。
 * agent_events / agent_tool_calls / tasks 与 Run 之间只有裸整数外键、没有关系声明，
 * 不显式删就会留下孤儿行 —— 事件与工具调用的孤儿尤其难查（它们没有可关联的会话）。
 */
export async function deleteConversationDeep(conversationId: number, userId: number): Promise<void> {
  await findConversationForUser(conversationId, userId);
  const runs = await prisma.agentRun.findMany({ where: { conversationId }, select: { id: true, taskId: true } });
  const runIds = runs.map((run) => run.id);
  const taskIds = runs.map((run) => run.taskId);

  await prisma.$transaction([
    prisma.agentEvent.deleteMany({ where: { runId: { in: runIds } } }),
    prisma.agentToolCall.deleteMany({ where: { runId: { in: runIds } } }),
    prisma.task.deleteMany({ where: { id: { in: taskIds } } }),
    // 放在最后：agent_messages / agent_runs 由外键 onDelete: Cascade 随会话一起清
    prisma.agentConversation.delete({ where: { id: conversationId } }),
  ]);
}
```

- [ ] **Step 4: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无输出

- [ ] **Step 5: 提交**

```bash
git add src/lib/server/services/agent-service.ts src/lib/server/services/agent-service.test.ts
git commit -m "feat(agent): 会话查询 / 取消 pending Run / 深删会话（含孤儿清理）"
```

---

### Task 9: API 序列化模块

**Files:**
- Create: `src/app/api/agent/shared.ts`

**为什么单独一个文件**：设计稿 §4.4 明确要求「首屏的工件与 `/artifacts` 接口返回同一形状，不要在两处各写一份序列化逻辑」。所有 snake_case 转换集中在这里。

**本任务顺带一处复用重构（评审发现）**：`src/lib/server/agent/stream-events.ts` 里已有一个私有的 `toPayloadRecord(payload: unknown): Record<string, unknown>`，本文件的 `serializeEvent` / `serializeToolCall` / `serializeArtifact` 需要完全相同的窄化逻辑。**不要在本文件里再写一份**：

1. 把 `stream-events.ts` 的 `toPayloadRecord` 改成导出（加一行中文注释说明「API 序列化层与 SSE 层共用的 Json 载荷窄化」）
2. 本文件 import `toPayloadRecord` 与 `AgentEventRowLike`（`AgentEventRowLike` 用作 `serializeEvent` 的参数类型，兼作「事件行最小契约」的文档），删掉本地那份 `toRecord`

- [ ] **Step 1: 实现**

（本文件的逻辑极薄，且形状由 Task 16 的端到端脚本断言，不单独写单测 —— 与项目里 `api/tasks/shared.ts`、`api/ai/shared.ts` 的既有做法一致。）

```ts
/**
 * Agent API 的序列化（REST 契约统一 snake_case，P0 设计稿 D13）
 *
 * 首屏（接口 3）与工件刷新（接口 6）返回**同一形状**的工件数组 ——
 * 序列化只写这一份，避免两处漂移（P1 设计稿 §4.4）。
 */
import { toPayloadRecord, type AgentEventRowLike } from "@/lib/server/agent/stream-events";
import { formatDateTime } from "@/lib/server/core/time";

/** 工具产出原文的序列化上限：超出则截断并置 result_truncated */
const RESULT_TEXT_LIMIT = 4000;

export interface SerializedAgentConversation {
  id: number;
  title: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export function serializeConversation(row: {
  id: number;
  title: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}): SerializedAgentConversation {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    created_at: formatDateTime(row.createdAt),
    updated_at: formatDateTime(row.updatedAt),
  };
}

export interface SerializedAgentRun {
  id: number;
  conversation_id: number;
  status: string;
  step_count: number;
  tokens_used: number;
  error_type: string | null;
  created_at: string;
  finished_at: string | null;
}

/** 只暴露前端需要的字段：taskId / maxSteps / tokenBudget 是内部护栏参数，不外泄 */
export function serializeRun(row: {
  id: number;
  conversationId: number;
  status: string;
  stepCount: number;
  tokensUsed: number;
  errorType: string | null;
  createdAt: Date;
  finishedAt: Date | null;
}): SerializedAgentRun {
  return {
    id: row.id,
    conversation_id: row.conversationId,
    status: row.status,
    step_count: row.stepCount,
    tokens_used: row.tokensUsed,
    error_type: row.errorType,
    created_at: formatDateTime(row.createdAt),
    finished_at: row.finishedAt ? formatDateTime(row.finishedAt) : null,
  };
}

export interface SerializedAgentMessage {
  id: number;
  role: string;
  content: string;
  run_id: number | null;
  tool_call_id: string | null;
  created_at: string;
}

export function serializeMessage(row: {
  id: number;
  role: string;
  content: string;
  runId: number | null;
  toolCallId: string | null;
  createdAt: Date;
}): SerializedAgentMessage {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    run_id: row.runId,
    tool_call_id: row.toolCallId,
    created_at: formatDateTime(row.createdAt),
  };
}

export interface SerializedAgentEvent {
  id: number;
  run_id: number;
  type: string;
  payload: Record<string, unknown>;
  created_at: string;
}

/**
 * 事件的 payload 归一成对象：Prisma 的 Json 列可能是 null / 数组 / 标量。
 * 参数用 AgentEventRowLike（事件行的最小契约），与 SSE 层共用同一定义。
 */
export function serializeEvent(row: AgentEventRowLike): SerializedAgentEvent {
  return {
    id: row.id,
    run_id: row.runId,
    type: row.type,
    payload: toPayloadRecord(row.payload),
    created_at: formatDateTime(row.createdAt),
  };
}

export interface SerializedToolCall {
  id: number;
  run_id: number;
  step_index: number;
  tool_name: string;
  tool_call_id: string;
  params: Record<string, unknown>;
  result: Record<string, unknown> | null;
  result_truncated: boolean;
  status: string;
  error_type: string | null;
  duration_ms: number | null;
  summary: string;
  created_at: string;
}

/**
 * `result` 是工具产出原文（最大可到 20k 字符），首屏整体返回会撑大响应，
 * 因此超过 RESULT_TEXT_LIMIT 就截成字符串并标记 result_truncated —— 前端据此显示「已截断」。
 */
export function serializeToolCall(row: {
  id: number;
  runId: number;
  stepIndex: number;
  toolName: string;
  toolCallId: string;
  params: unknown;
  result: unknown;
  status: string;
  errorType: string | null;
  durationMs: number | null;
  summary: string | null;
  createdAt: Date;
}): SerializedToolCall {
  const params = toPayloadRecord(row.params);
  const rawResult = row.result === null || row.result === undefined ? null : toPayloadRecord(row.result);
  const resultText = rawResult === null ? "" : JSON.stringify(rawResult);
  const truncated = resultText.length > RESULT_TEXT_LIMIT;
  return {
    id: row.id,
    run_id: row.runId,
    step_index: row.stepIndex,
    tool_name: row.toolName,
    tool_call_id: row.toolCallId,
    params,
    result: truncated ? { truncated_text: resultText.slice(0, RESULT_TEXT_LIMIT) } : rawResult,
    result_truncated: truncated,
    status: row.status,
    error_type: row.errorType,
    duration_ms: row.durationMs,
    summary: row.summary ?? "",
    created_at: formatDateTime(row.createdAt),
  };
}

export interface SerializedArtifact {
  event_id: number;
  run_id: number;
  kind: string;
  id: number;
  title: string;
  href: string;
  created_at: string;
}

/** 工件行来自 type="artifact" 的事件（载荷由 persist.extractArtifacts 产出） */
export function serializeArtifact(row: {
  id: number;
  runId: number;
  payload: unknown;
  createdAt: Date;
}): SerializedArtifact | null {
  const payload = toPayloadRecord(row.payload);
  const id = Number(payload.id);
  if (!Number.isFinite(id) || id <= 0) return null;
  return {
    event_id: row.id,
    run_id: row.runId,
    kind: String(payload.kind ?? ""),
    id,
    title: String(payload.title ?? ""),
    href: String(payload.href ?? ""),
    created_at: formatDateTime(row.createdAt),
  };
}
```

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无输出

- [ ] **Step 3: 提交**

```bash
git add src/app/api/agent/shared.ts
git commit -m "feat(agent-api): 序列化单一真相源（首屏与工件接口同形状）"
```

---

### Task 10: 接口 1/2 —— 会话列表与新建

**Files:**
- Create: `src/app/api/agent/conversations/route.ts`

- [ ] **Step 1: 实现**

```ts
import { getCurrentUser } from "@/lib/server/core/auth";
import { handle, readJson } from "@/lib/server/core/route";
import { createConversation, listConversations } from "@/lib/server/services/agent-service";
import { NextResponse } from "next/server";
import { z } from "zod";
import { serializeConversation } from "../shared";

const CreateConversationSchema = z.object({
  title: z.string().max(40).default("新任务"),
});

/** GET /api/agent/conversations 会话列表（左栏，按更新时间倒序） */
export const GET = handle(async (req) => {
  const user = await getCurrentUser(req);
  const conversations = await listConversations(user.id);
  return NextResponse.json({ items: conversations.map(serializeConversation) });
});

/** POST /api/agent/conversations 新建会话（请求体可传 { title }，默认「新任务」） */
export const POST = handle(async (req) => {
  const user = await getCurrentUser(req);
  const payload = await readJson(req, CreateConversationSchema);
  const conversation = await createConversation(user.id, payload.title);
  return NextResponse.json(serializeConversation(conversation));
});
```

- [ ] **Step 2: 手工验证（需 dev server 与数据库）**

终端 A：`npm run dev`
终端 B：

```bash
TOKEN=$(npx tsx -e "import('./src/lib/server/core/security.ts').then(async (m) => { const { prisma } = await import('./src/lib/server/core/db.ts'); const user = await prisma.user.findFirst({ orderBy: { id: 'asc' } }); if (!user) throw new Error('库里没有用户'); process.stdout.write(m.createAccessToken(user.id)); await prisma.\$disconnect(); })")
echo "token 长度: ${#TOKEN}"
curl -s -X POST http://localhost:3000/api/agent/conversations -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{}' ; echo
curl -s http://localhost:3000/api/agent/conversations -H "Authorization: Bearer $TOKEN" ; echo
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/agent/conversations   # 期望 401
```

Expected：第一条返回新建会话的 JSON（`{"id":N,"title":"新任务","status":"idle",...}`）；第二条 `items` 里能看到它；第三条 `401`。

- [ ] **Step 3: 提交**

```bash
git add src/app/api/agent/conversations/route.ts
git commit -m "feat(agent-api): 会话列表与新建（接口 1/2）"
```

---

### Task 11: 接口 3/8 —— 会话详情（首屏契约）与删除

**Files:**
- Create: `src/app/api/agent/conversations/[id]/route.ts`

**这是 B 块前端的联调契约本体**，字段一个都不能少。

- [ ] **Step 1: 实现**

```ts
import { getCurrentUser } from "@/lib/server/core/auth";
import { badRequest } from "@/lib/server/core/http-error";
import { handle } from "@/lib/server/core/route";
import { RENDERABLE_EVENT_TYPES } from "@/lib/server/agent/stream-events";
import {
  deleteConversationDeep,
  findConversationForUser,
  latestEventIdForRuns,
  listArtifactEvents,
  listConversationUserMessages,
  listRenderableEvents,
  listRuns,
  listToolCallsForRuns,
} from "@/lib/server/services/agent-service";
import { NextResponse } from "next/server";
import { serializeArtifact, serializeConversation, serializeEvent, serializeMessage, serializeToolCall } from "../../shared";

/** 首屏回放事件的条数上限（一次运行的可渲染事件通常个位数，长会话才可能触顶） */
const EVENT_REPLAY_LIMIT = 1000;

/** 解析并校验路径参数 id */
function parseId(raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw badRequest("会话 id 非法");
  return value;
}

/**
 * GET /api/agent/conversations/[id] 首屏契约（P1 设计稿 §4.4）
 *
 * 一次请求拿到整屏数据 + SSE 续传起点：
 *   messages        中栏 user 消息（助手文本一律来自下面的 events，避免两处渲染）
 *   events          id ≤ latest_event_id 的可渲染历史事件（D23 的过程文本靠它才能刷新后仍在）
 *   tool_calls      中栏已完成的工具卡（含 summary）
 *   artifacts       右栏工件
 *   latest_event_id 前端订阅 SSE 的起点：只渲染 id 大于它的事件
 */
export const GET = handle(async (req, { params }) => {
  const user = await getCurrentUser(req);
  const conversationId = parseId(params.id);
  const conversation = await findConversationForUser(conversationId, user.id);

  const runs = await listRuns(conversationId);
  const runIds = runs.map((run) => run.id);
  const latestEventId = await latestEventIdForRuns(runIds);

  const [messages, toolCalls, artifactEvents, replayEvents] = await Promise.all([
    listConversationUserMessages(conversationId),
    listToolCallsForRuns(runIds),
    listArtifactEvents(runIds),
    listRenderableEvents(runIds, latestEventId, RENDERABLE_EVENT_TYPES, EVENT_REPLAY_LIMIT),
  ]);

  return NextResponse.json({
    conversation: serializeConversation(conversation),
    messages: messages.map(serializeMessage),
    events: replayEvents.map(serializeEvent),
    tool_calls: toolCalls.map(serializeToolCall),
    artifacts: artifactEvents.map(serializeArtifact).filter((item) => item !== null),
    latest_event_id: latestEventId,
    events_truncated: replayEvents.length >= EVENT_REPLAY_LIMIT,
  });
});

/**
 * DELETE /api/agent/conversations/[id] 删除会话（接口 8）
 *
 * 级联范围见 deleteConversationDeep：Prisma 的 onDelete 只覆盖
 * agent_messages / agent_runs，事件、工具调用与 Task 必须显式清。
 */
export const DELETE = handle(async (req, { params }) => {
  const user = await getCurrentUser(req);
  const conversationId = parseId(params.id);
  await deleteConversationDeep(conversationId, user.id);
  return NextResponse.json({ deleted: true, id: conversationId });
});
```

- [ ] **Step 2: 手工验证**

```bash
curl -s "http://localhost:3000/api/agent/conversations/<上面建的 id>" -H "Authorization: Bearer $TOKEN" | npx tsx -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(Object.keys(j), 'latest_event_id=', j.latest_event_id, 'events_truncated=', j.events_truncated)})"
```

Expected：`[ 'conversation', 'messages', 'events', 'tool_calls', 'artifacts', 'latest_event_id', 'events_truncated' ] latest_event_id= 0 events_truncated= false`

再验证 404 与删除：

```bash
curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:3000/api/agent/conversations/99999999" -H "Authorization: Bearer $TOKEN"   # 404
curl -s -X DELETE "http://localhost:3000/api/agent/conversations/<上面建的 id>" -H "Authorization: Bearer $TOKEN" ; echo
```

- [ ] **Step 3: 提交**

```bash
git add "src/app/api/agent/conversations/[id]/route.ts"
git commit -m "feat(agent-api): 首屏契约与删除会话（接口 3/8）"
```

---

### Task 12: 接口 4 —— 发消息建 Run

**Files:**
- Modify: `src/lib/server/services/agent-service.ts:96-117`（`appendMessage` 改为返回完整行）
- Create: `src/app/api/agent/conversations/[id]/messages/route.ts`

- [ ] **Step 1: `appendMessage` 返回完整行**

调用方已 grep 确认只有 `src/scripts/agent-smoke.ts`（只用 `.id`），因此把返回值从 `{ id }` 换成完整行是向后兼容的 —— 它省掉接口层「写完再回查一次」的多余往返。

```ts
/** 追加一条消息，返回落库后的完整行（接口层要把它序列化返回给前端） */
export async function appendMessage(options: {
  conversationId: number;
  role: "user" | "assistant" | "tool";
  content: string;
  runId?: number | null;
  toolCalls?: Prisma.InputJsonValue;
  toolCallId?: string | null;
}): Promise<AgentMessage> {
  const message = await prisma.agentMessage.create({
    data: {
      conversationId: options.conversationId,
      role: options.role,
      content: options.content,
      runId: options.runId ?? null,
      toolCalls: options.toolCalls,
      toolCallId: options.toolCallId ?? null,
      // createdAt 无库级默认值，必须显式传
      createdAt: shanghaiNow(),
    },
  });
  return message;
}
```

Run: `npx tsc --noEmit`
Expected: 无输出（`agent-smoke.ts:59` 的 `message.id` 仍然成立）

- [ ] **Step 2: 实现路由**

```ts
import { getCurrentUser } from "@/lib/server/core/auth";
import { ApiError, badRequest } from "@/lib/server/core/http-error";
import { handle, readJson } from "@/lib/server/core/route";
import {
  appendMessage,
  createRunForMessage,
  deriveConversationTitle,
  findConversationForUser,
  hasActiveRun,
  updateConversationStatus,
} from "@/lib/server/services/agent-service";
import { NextResponse } from "next/server";
import { z } from "zod";
import { serializeConversation, serializeMessage, serializeRun } from "../../../shared";

const SendMessageSchema = z.object({
  content: z.string().min(1).max(4000),
});

function parseId(raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw badRequest("会话 id 非法");
  return value;
}

/**
 * POST /api/agent/conversations/[id]/messages 发消息 → 建 Run（P1 设计稿 §3.2 ①②）
 *
 * 一次只允许一个 Run：同一会话并行两个循环会交叉写 agent_messages，
 * 让模型的上下文顺序错乱（worker 的并发上限是 3，同一个会话必须串行）。
 */
export const POST = handle(async (req, { params }) => {
  const user = await getCurrentUser(req);
  const conversationId = parseId(params.id);
  const conversation = await findConversationForUser(conversationId, user.id);
  const payload = await readJson(req, SendMessageSchema);
  const content = payload.content.trim();
  if (!content) throw new ApiError(422, "消息内容不能为空");

  if (await hasActiveRun(conversationId)) {
    throw new ApiError(409, "会话正在执行中，请等待当前任务完成后继续");
  }

  const message = await appendMessage({ conversationId, role: "user", content });
  const run = await createRunForMessage({ conversationId, userId: user.id, messageId: message.id });

  // 标题在首条消息时就派生（worker 结束时也会兜底派生一次，两处同源函数）。
  // 立刻派生是为了左栏不必等一次运行结束才显示出可读的会话名。
  if (conversation.title === "新任务") {
    await updateConversationStatus({ conversationId, status: "running", title: deriveConversationTitle(content) });
  }
  const fresh = await findConversationForUser(conversationId, user.id);

  return NextResponse.json({
    conversation: serializeConversation(fresh),
    message: serializeMessage(message),
    run: serializeRun(run),
  });
});
```

- [ ] **Step 3: 手工验证**

```bash
CONV=$(curl -s -X POST http://localhost:3000/api/agent/conversations -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{}' | npx tsx -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(String(JSON.parse(s).id)))")
curl -s -X POST "http://localhost:3000/api/agent/conversations/$CONV/messages" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"content":"帮我生成 2 个露营主题的选题"}' ; echo
curl -s -o /dev/null -w "%{http_code}\n" -X POST "http://localhost:3000/api/agent/conversations/$CONV/messages" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"content":"再来一条"}'   # 期望 409（上一条还在跑）
```

Expected：第一条返回 `{"conversation":{...,"status":"running","title":"帮我生成 2 个露营主题的选题"},"message":{...},"run":{"status":"pending",...}}`；第二条 `409`。

- [ ] **Step 4: 提交**

```bash
git add src/lib/server/services/agent-service.ts "src/app/api/agent/conversations/[id]/messages/route.ts"
git commit -m "feat(agent-api): 发消息建 Run，并发保护与标题派生（接口 4）"
```

---

### Task 13: 接口 6 —— 工件列表

**Files:**
- Create: `src/app/api/agent/conversations/[id]/artifacts/route.ts`

**定位**：仅供右栏单独刷新（用户手动刷新、或只想重取工件）。首屏的工件已由接口 3 一并返回，两个接口返回同一形状 —— 序列化共用 `shared.ts`。

- [ ] **Step 1: 实现**

```ts
import { getCurrentUser } from "@/lib/server/core/auth";
import { badRequest } from "@/lib/server/core/http-error";
import { handle } from "@/lib/server/core/route";
import { findConversationForUser, listArtifactEvents, listRuns } from "@/lib/server/services/agent-service";
import { NextResponse } from "next/server";
import { serializeArtifact } from "../../../shared";

function parseId(raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw badRequest("会话 id 非法");
  return value;
}

/** GET /api/agent/conversations/[id]/artifacts 工件列表（右栏单独刷新用，P1 设计稿 §4.4） */
export const GET = handle(async (req, { params }) => {
  const user = await getCurrentUser(req);
  const conversationId = parseId(params.id);
  await findConversationForUser(conversationId, user.id);

  const runs = await listRuns(conversationId);
  const events = await listArtifactEvents(runs.map((run) => run.id));
  return NextResponse.json({ items: events.map(serializeArtifact).filter((item) => item !== null) });
});
```

- [ ] **Step 2: 手工验证**

```bash
curl -s "http://localhost:3000/api/agent/conversations/<已跑过一轮的会话 id>/artifacts" -H "Authorization: Bearer $TOKEN" ; echo
```

Expected：`{"items":[{...工件...}]}` 或 `{"items":[]}`（未产出工件时）。

- [ ] **Step 3: 提交**

```bash
git add "src/app/api/agent/conversations/[id]/artifacts/route.ts"
git commit -m "feat(agent-api): 工件列表（接口 6）"
```

---

### Task 14: 接口 7 —— 取消 Run（仅 pending）

**Files:**
- Create: `src/app/api/agent/runs/[runId]/cancel/route.ts`

- [ ] **Step 1: 实现**

```ts
import { getCurrentUser } from "@/lib/server/core/auth";
import { ApiError, badRequest } from "@/lib/server/core/http-error";
import { handle } from "@/lib/server/core/route";
import { cancelPendingRun } from "@/lib/server/services/agent-service";
import { NextResponse } from "next/server";
import { serializeRun } from "../../../shared";

function parseId(raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw badRequest("Run id 非法");
  return value;
}

/**
 * POST /api/agent/runs/[runId]/cancel 取消 Run —— 仅 pending（P1 设计稿 D19 / §4.2）
 *
 *   200 pending  → 置 cancelled，同步 Task 为 failed，会话回 idle
 *   409 running  → 已开始执行，P1 不支持中止运行中的任务
 *   409 终态     → 已是终态，无需取消
 *   404 不存在或不属于当前用户
 */
export const POST = handle(async (req, { params }) => {
  const user = await getCurrentUser(req);
  const runId = parseId(params.runId);
  const result = await cancelPendingRun(runId, user.id);
  if (result.outcome === "conflict") throw new ApiError(409, result.reason);
  return NextResponse.json({ run: serializeRun(result.run) });
});
```

- [ ] **Step 2: 手工验证**

```bash
# 终态 Run 取消 → 409（用上面那条已跑完的 Run id）
curl -s -w "\nHTTP %{http_code}\n" -X POST "http://localhost:3000/api/agent/runs/<已结束的 runId>/cancel" -H "Authorization: Bearer $TOKEN"
# 不存在的 Run → 404
curl -s -o /dev/null -w "%{http_code}\n" -X POST "http://localhost:3000/api/agent/runs/99999999/cancel" -H "Authorization: Bearer $TOKEN"
```

Expected：第一条 `HTTP 409` 且 detail 说明已是终态；第二条 `404`。

- [ ] **Step 3: 提交**

```bash
git add "src/app/api/agent/runs/[runId]/cancel/route.ts"
git commit -m "feat(agent-api): 取消 pending Run（接口 7，仅 pending）"
```

---

### Task 15: 接口 5 —— SSE 订阅

**Files:**
- Create: `src/app/api/agent/conversations/[id]/events/route.ts`

**这是全项目第一个服务端流式接口**（全项目 0 处 `ReadableStream`，P1 设计稿 §八 缺口 2），契约按 §4.1 从零定义。

- [ ] **Step 1: 实现**

```ts
import { getCurrentUser } from "@/lib/server/core/auth";
import { badRequest } from "@/lib/server/core/http-error";
import { handle } from "@/lib/server/core/route";
import {
  attachToolCallSummaries,
  collectToolCallIds,
  encodeSseFrame,
  SSE_HEARTBEAT_FRAME,
  SSE_HEARTBEAT_MS,
} from "@/lib/server/agent/stream-events";
import {
  findConversationForUser,
  findToolCallSummaries,
  isRunTerminal,
  listEventsAfter,
  listRuns,
} from "@/lib/server/services/agent-service";
import { nextPollInterval } from "@/lib/agent/polling";
import { serializeEvent } from "../../../shared";

/**
 * 每个请求都必须动态执行：SSE 一旦被静态优化或缓存，客户端就再也拿不到新事件。
 */
export const dynamic = "force-dynamic";

/** 单批最多推送的事件数（一次运行的事件量远小于此，批量只是防御性上限） */
const BATCH_LIMIT = 200;

/** 可中止的睡眠：客户端断开时立刻返回，不留悬挂的定时器 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function parseId(raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw badRequest("会话 id 非法");
  return value;
}

/**
 * GET /api/agent/conversations/[id]/events  SSE 订阅（接口 5）
 *
 * 服务端每 500ms 查一次 agent_events 的新事件再转发（D22：API 轮询数据库，
 * 与 D15「worker 3s 轮询」同一哲学，零新依赖）：
 *   - 帧格式 `data: <json>\n\n`，json 里带 id —— 客户端手工解析，断线重连复用同一个 last_event_id
 *   - 心跳 `: ping\n\n` 每 15s，防中间层掐长连接
 *   - 会话内没有 pending/running 的 Run 时降速到 5s，避免页面挂着空转（§3.3）
 *
 * 认证沿用 fetch + Authorization: Bearer（EventSource 无法携带自定义 header，P0 设计稿 §9.1）。
 * 前端拿首屏的 latest_event_id 作为起点，只渲染 id 大于它的事件，因此首屏与订阅之间
 * 的时间窗不会导致重复渲染（§4.4）。
 */
export const GET = handle(async (req, { params, searchParams }) => {
  const user = await getCurrentUser(req);
  const conversationId = parseId(params.id);
  // 归属校验必须在流开始**之前**：流一旦开始就无法再改状态码
  await findConversationForUser(conversationId, user.id);

  const rawLastId = Number.parseInt(searchParams.get("last_event_id") ?? "0", 10);
  let lastId = Number.isNaN(rawLastId) || rawLastId < 0 ? 0 : rawLastId;
  let cancelled = false;

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      void (async () => {
        let lastHeartbeatAt = Date.now();
        try {
          while (!cancelled && !req.signal.aborted) {
            const runs = await listRuns(conversationId);
            const runIds = runs.map((run) => run.id);
            const hasActiveRun = runs.some((run) => !isRunTerminal(run.status));

            if (runIds.length > 0) {
              const rows = await listEventsAfter(runIds, lastId, BATCH_LIMIT);
              if (rows.length > 0) {
                // 补摘要：前端不能 import skill-catalog（会把 prisma 打进客户端包），
                // 而工具的摘要在循环侧写不进事件（subscribe 只能观察），只能在这里补齐
                const summaries = await findToolCallSummaries(collectToolCallIds(rows));
                for (const row of attachToolCallSummaries(rows, summaries)) {
                  controller.enqueue(encoder.encode(encodeSseFrame(serializeEvent(row))));
                }
                lastId = rows[rows.length - 1].id;
              }
            }

            if (Date.now() - lastHeartbeatAt >= SSE_HEARTBEAT_MS) {
              controller.enqueue(encoder.encode(SSE_HEARTBEAT_FRAME));
              lastHeartbeatAt = Date.now();
            }

            await sleep(nextPollInterval(hasActiveRun), req.signal);
          }
        } catch (error) {
          // 流已开始，改不了状态码：记日志并结束流，客户端按断线重连处理
          console.error("[agent] SSE 流异常结束", error);
        } finally {
          try {
            controller.close();
          } catch {
            // 已关闭（客户端断开后 enqueue 会抛，close 同样可能抛）
          }
        }
      })();
    },
    cancel() {
      cancelled = true;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      Connection: "keep-alive",
    },
  });
});
```

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无输出

- [ ] **Step 3: 验证「空闲时降速」与「新事件实时到达」**

启动 worker（终端 A：`npx tsx src/worker/index.mts`），另开终端发一条消息后立刻订阅：

```bash
curl -N -s "http://localhost:3000/api/agent/conversations/<会话 id>/events?last_event_id=0" -H "Authorization: Bearer $TOKEN"
```

Expected：事件随运行推进逐条出现（不是结束后一次性吐出）；运行结束后只剩每 15s 一次 `: ping`。按 Ctrl-C 断开后，Next.js 终端**不应**持续刷 `[agent] SSE 流异常结束`（若刷，说明 `controller.close()` 在客户端断开后仍被调用，检查 `cancel()` 回调）。

- [ ] **Step 4: 提交**

```bash
git add "src/app/api/agent/conversations/[id]/events/route.ts"
git commit -m "feat(agent-api): SSE 订阅（接口 5，轮询转发 + 双速降速 + 摘要补齐）"
```

---

### Task 16: A 块端到端验收脚本

**Files:**
- Create: `src/scripts/agent-api-smoke.ts`

**Files（运行环境）:** 三个终端 —— worker、dev server、脚本。

- [ ] **Step 1: 写脚本**

```ts
/**
 * Agent P1-A 端到端验收脚本（接口层）
 *
 * 用法（三个终端）：
 *   终端 A：npx tsx src/worker/index.mts
 *   终端 B：npm run dev
 *   终端 C：npx tsx src/scripts/agent-api-smoke.ts
 *
 * 验收项（任一不通过即 exit 1）：
 *   1. 认证：无 token 访问会话列表 → 401
 *   2. 会话：POST 建会话 → GET 列表能看到它；会话详情越权 → 404
 *   3. 发消息：POST messages → Run 落库、会话转 running；重复发 → 409
 *   4. SSE：按 id 严格递增收到 agent_start … agent_end；存在带正文的 message_end（D23）
 *   5. 摘要：tool_execution_end 帧带 summary（§4.3）
 *   6. 首屏契约：七个字段齐全，latest_event_id 与库中最大值一致
 *   7. 去重边界：以 latest_event_id 为起点重连，收不到旧事件
 *   8. 取消：终态 Run → 409；pending Run → 200 且 Run=cancelled、Task=failed、会话回 idle
 *   9. 清理：本脚本产生的会话全部删除，不留孤儿事件/工具调用/Task
 */
import { prisma } from "../lib/server/core/db";
import { createAccessToken } from "../lib/server/core/security";
import { shanghaiNow } from "../lib/server/core/time";
import { deleteConversationDeep } from "../lib/server/services/agent-service";

const BASE = process.env.AGENT_API_BASE ?? "http://localhost:3000";
/** 一次运行的最长等待（含模型推理） */
const RUN_TIMEOUT_MS = 5 * 60 * 1000;

/** 断言：不通过就抛错 —— 验收脚本必须能失败 */
function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`验收未通过：${message}`);
}

interface ApiResult<T> {
  status: number;
  body: T;
}

async function api<T>(token: string | null, path: string, init: RequestInit = {}): Promise<ApiResult<T>> {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: response.status, body: body as T };
}

/** 事件帧（SSE 的 data 载荷） */
interface EventFrame {
  id: number;
  run_id: number;
  type: string;
  payload: Record<string, unknown>;
  created_at: string;
}

/** 订阅 SSE 并收集全部帧，直到收到 agent_end 或超时 */
async function collectStream(
  token: string,
  conversationId: number,
  lastEventId: number,
  timeoutMs: number,
): Promise<EventFrame[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const frames: EventFrame[] = [];
  try {
    const response = await fetch(
      `${BASE}/api/agent/conversations/${conversationId}/events?last_event_id=${lastEventId}`,
      { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal },
    );
    assert(response.status === 200, `SSE 订阅应返回 200，实际 ${response.status}`);
    assert(
      response.headers.get("content-type")?.includes("text/event-stream") === true,
      `SSE 的 Content-Type 应为 text/event-stream，实际 ${response.headers.get("content-type")}`,
    );
    const reader = response.body?.getReader();
    if (!reader) throw new Error("SSE 响应没有 body");

    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        // 心跳帧是 `: ping`，不匹配 data: 前缀，天然被跳过
        if (!line.startsWith("data: ")) continue;
        const frame = JSON.parse(line.slice(6)) as EventFrame;
        frames.push(frame);
        if (frame.type === "agent_end") {
          await reader.cancel();
          return frames;
        }
      }
    }
  } catch (error) {
    // 超时中止：把已收到的帧交给调用方断言（报错信息更有指向性）
    if ((error as Error).name === "AbortError") return frames;
    throw error;
  } finally {
    clearTimeout(timer);
  }
  return frames;
}

async function main(): Promise<void> {
  const user = await prisma.user.findFirst({ orderBy: { id: "asc" } });
  if (!user) throw new Error("数据库里没有用户，请先注册一个账号");
  const token = createAccessToken(user.id);
  console.log("使用用户:", user.id, "接口地址:", BASE);

  // 探活：dev server 没起时给出可读提示，而不是 fetch ECONNREFUSED
  try {
    await api(null, "/api/agent/conversations");
  } catch {
    throw new Error(`连不上 ${BASE}，请先在另一个终端跑 npm run dev`);
  }

  const createdConversationIds: number[] = [];
  try {
    // ========== 1) 认证 ==========
    const anonymous = await api(null, "/api/agent/conversations");
    assert(anonymous.status === 401, `无 token 访问会话列表应为 401，实际 ${anonymous.status}`);
    console.log("认证验收通过（401）");

    // ========== 2) 会话：新建 + 列表 + 越权 ==========
    const created = await api<{ id: number; title: string; status: string }>(token, "/api/agent/conversations", {
      method: "POST",
      body: JSON.stringify({}),
    });
    assert(created.status === 200, `新建会话应返回 200，实际 ${created.status}`);
    const conversationId = created.body.id;
    createdConversationIds.push(conversationId);
    assert(created.body.status === "idle", `新会话应为 idle，实际 ${created.body.status}`);

    const list = await api<{ items: Array<{ id: number }> }>(token, "/api/agent/conversations");
    assert(list.status === 200, `会话列表应返回 200，实际 ${list.status}`);
    assert(
      list.body.items.some((item) => item.id === conversationId),
      "会话列表里找不到刚建的会话",
    );

    const otherUser = await prisma.user.create({
      data: { username: `agent_api_smoke_${Date.now()}`, passwordHash: "not-a-real-hash", createdAt: shanghaiNow() },
    });
    const otherConversation = await prisma.agentConversation.create({
      data: { userId: otherUser.id, title: "他人的会话", status: "idle", createdAt: shanghaiNow(), updatedAt: shanghaiNow() },
    });
    const forbidden = await api(token, `/api/agent/conversations/${otherConversation.id}`);
    assert(forbidden.status === 404, `访问他人会话应为 404，实际 ${forbidden.status}`);
    await prisma.agentConversation.delete({ where: { id: otherConversation.id } });
    await prisma.user.delete({ where: { id: otherUser.id } });
    console.log("会话验收通过（新建 / 列表 / 越权 404）");

    // ========== 3) 发消息建 Run ==========
    const send = await api<{ run: { id: number; status: string }; conversation: { status: string; title: string } }>(
      token,
      `/api/agent/conversations/${conversationId}/messages`,
      { method: "POST", body: JSON.stringify({ content: "帮我生成 2 个露营主题的小红书选题" }) },
    );
    assert(send.status === 200, `发消息应返回 200，实际 ${send.status}`);
    assert(send.body.run.status === "pending", `新 Run 应为 pending，实际 ${send.body.run.status}`);
    assert(send.body.conversation.status === "running", `发消息后会话应为 running，实际 ${send.body.conversation.status}`);
    assert(send.body.conversation.title !== "新任务", "会话标题未按首条消息派生");
    const runId = send.body.run.id;

    const concurrent = await api(token, `/api/agent/conversations/${conversationId}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: "再来一条" }),
    });
    assert(concurrent.status === 409, `执行中重复发消息应为 409，实际 ${concurrent.status}`);
    console.log("发消息验收通过（runId:", runId, "，并发保护 409）");

    // ========== 4) SSE：完整事件序列 ==========
    const frames = await collectStream(token, conversationId, 0, RUN_TIMEOUT_MS);
    assert(frames.length > 0, "SSE 没有收到任何帧（worker 是否在运行？）");
    const ids = frames.map((frame) => frame.id);
    assert(
      ids.every((id, index) => index === 0 || id > ids[index - 1]),
      `事件 id 必须严格递增，实际 ${ids.join(",")}`,
    );
    assert(frames[0]?.type === "agent_start", `首帧应为 agent_start，实际 ${frames[0]?.type}`);
    assert(frames[frames.length - 1]?.type === "agent_end", `末帧应为 agent_end，实际 ${frames[frames.length - 1]?.type}`);

    const textFrames = frames.filter(
      (frame) => frame.type === "message_end" && typeof frame.payload.text === "string" && frame.payload.text.length > 0,
    );
    assert(textFrames.length > 0, "没有任何 message_end 帧带正文（D23 未生效：serializeEventForDb 又把它裁掉了）");

    const toolEndFrames = frames.filter((frame) => frame.type === "tool_execution_end");
    assert(toolEndFrames.length > 0, "本次运行没有调用任何工具（请换一个能触发工具的提问）");
    const missingSummary = toolEndFrames.filter((frame) => typeof frame.payload.summary !== "string" || !frame.payload.summary);
    assert(missingSummary.length === 0, `有 ${missingSummary.length} 个 tool_execution_end 帧缺 summary（§4.3 的补齐没生效）`);

    assert(frames.some((frame) => frame.type === "status"), "没有收到终态 status 事件");
    console.log(
      "SSE 验收通过（",
      frames.length,
      "帧，工具调用",
      toolEndFrames.length,
      "次，其中带正文的 message_end",
      textFrames.length,
      "条）",
    );

    // ========== 5) 首屏契约 ==========
    interface Detail {
      conversation: { id: number; status: string };
      messages: Array<{ id: number; role: string; content: string }>;
      events: EventFrame[];
      tool_calls: Array<{ tool_name: string; status: string; summary: string }>;
      artifacts: Array<{ kind: string; id: number; href: string }>;
      latest_event_id: number;
      events_truncated: boolean;
    }
    const detail = await api<Detail>(token, `/api/agent/conversations/${conversationId}`);
    assert(detail.status === 200, `会话详情应返回 200，实际 ${detail.status}`);
    for (const field of ["conversation", "messages", "events", "tool_calls", "artifacts", "latest_event_id", "events_truncated"]) {
      assert(field in (detail.body as unknown as Record<string, unknown>), `会话详情缺少字段 ${field}`);
    }
    const body = detail.body;
    assert(body.messages.some((message) => message.role === "user"), "首屏 messages 里没有用户消息");
    // 助手文本只能有一个来源（events）：最终答复同时存在于 agent_messages 与 message_end 事件里，
    // 若首屏 messages 也返回 assistant 行，同一段文本会被渲染两遍
    assert(
      body.messages.every((message) => message.role === "user"),
      `首屏 messages 必须只含 user 消息，实际角色：${body.messages.map((m) => m.role).join(",")}`,
    );
    assert(
      body.events.some((event) => event.type === "message_end" && event.payload.role === "assistant"),
      "首屏 events 里没有 assistant 的 message_end（助手文本将无源可渲染）",
    );
    assert(body.tool_calls.length > 0, "首屏 tool_calls 为空（已完成的工具调用没有随首屏返回）");
    assert(
      body.tool_calls.every((row) => row.summary.length > 0),
      "首屏 tool_calls 里有摘要为空的行（落库时没带 summary）",
    );
    assert(body.events.length > 0, "首屏 events 为空（D23 的历史过程文本没有回放）");
    assert(
      body.events.every((event) => event.id <= body.latest_event_id),
      "首屏 events 里有 id 大于 latest_event_id 的事件（会与 SSE 重复渲染）",
    );

    const maxEventId = await prisma.agentEvent.aggregate({
      where: { runId: { in: (await prisma.agentRun.findMany({ where: { conversationId }, select: { id: true } })).map((r) => r.id) } },
      _max: { id: true },
    });
    assert(
      body.latest_event_id === (maxEventId._max.id ?? 0),
      `latest_event_id 应等于库中最大事件 id，实际 ${body.latest_event_id} vs ${maxEventId._max.id ?? 0}`,
    );
    console.log("首屏契约验收通过（events", body.events.length, "条，tool_calls", body.tool_calls.length, "条，artifacts", body.artifacts.length, "个）");

    // ========== 6) 去重边界：以 latest_event_id 重连，不应再收到旧事件 ==========
    const replayFrames = await collectStream(token, conversationId, body.latest_event_id, 2000);
    assert(
      replayFrames.every((frame) => frame.id > body.latest_event_id),
      `重连后收到了 id ≤ latest_event_id 的旧事件：${replayFrames.map((f) => f.id).join(",")}`,
    );
    console.log("去重边界验收通过（重连收到", replayFrames.length, "条新帧）");

    // ========== 7) 取消 ==========
    const terminalCancel = await api(token, `/api/agent/runs/${runId}/cancel`, { method: "POST" });
    assert(terminalCancel.status === 409, `取消终态 Run 应为 409，实际 ${terminalCancel.status}`);

    const missingCancel = await api(token, "/api/agent/runs/99999999/cancel", { method: "POST" });
    assert(missingCancel.status === 404, `取消不存在的 Run 应为 404，实际 ${missingCancel.status}`);

    // pending 取消用**独立会话**：万一被 worker 抢先领取，那个会话里没有用户消息，
    // 循环会立刻以 no_user_message 失败（不调模型、不烧 token、不产出工件），
    // 而不是拿上面那个会话再跑一遍真循环。
    const cancelConversation = await api<{ id: number }>(token, "/api/agent/conversations", {
      method: "POST",
      body: JSON.stringify({ title: "取消验收" }),
    });
    assert(cancelConversation.status === 200, `建取消验收会话失败：${cancelConversation.status}`);
    const cancelConversationId = cancelConversation.body.id;
    createdConversationIds.push(cancelConversationId);

    // worker 每 3s 领一次任务，脚本在毫秒级内取消。万一被抢先（409），换一条重试 ——
    // 连续 3 次都输说明 worker 轮询配置有问题
    let pendingCancelled = false;
    for (let attempt = 1; attempt <= 3 && !pendingCancelled; attempt += 1) {
      // 先把会话置成 running（模拟接口 4 建 Run 后的状态），
      // 否则「取消后回 idle」这条断言在会话本来就 idle 时会恒真，等于没测
      await prisma.agentConversation.update({
        where: { id: cancelConversationId },
        data: { status: "running", updatedAt: shanghaiNow() },
      });
      const task = await prisma.task.create({
        data: { userId: user.id, platform: "xhs", taskType: "agent_run", status: "pending", progress: 0, createdAt: shanghaiNow() },
      });
      const pendingRun = await prisma.agentRun.create({
        data: { conversationId: cancelConversationId, userId: user.id, taskId: task.id, status: "pending", createdAt: shanghaiNow() },
      });
      const cancel = await api<{ run: { status: string } }>(token, `/api/agent/runs/${pendingRun.id}/cancel`, { method: "POST" });
      if (cancel.status === 200) {
        pendingCancelled = true;
        assert(cancel.body.run.status === "cancelled", `取消后 Run 应为 cancelled，实际 ${cancel.body.run.status}`);
        const runRow = await prisma.agentRun.findUnique({ where: { id: pendingRun.id } });
        assert(runRow?.status === "cancelled", `库中 Run 应为 cancelled，实际 ${runRow?.status}`);
        const taskRow = await prisma.task.findUnique({ where: { id: task.id } });
        assert(taskRow?.status === "failed", `被取消 Run 的 Task 应为 failed，实际 ${taskRow?.status}`);
        const conversationRow = await prisma.agentConversation.findUnique({ where: { id: cancelConversationId } });
        assert(conversationRow?.status === "idle", `取消后会话应回 idle，实际 ${conversationRow?.status}`);
      } else {
        assert(cancel.status === 409, `取消 pending Run 应返回 200 或 409，实际 ${cancel.status}`);
        console.warn(`  第 ${attempt} 次被 worker 抢先领取，重试`);
        await prisma.task.delete({ where: { id: task.id } }).catch(() => undefined);
      }
    }
    assert(pendingCancelled, "连续 3 次都没能在 worker 领取前取消 pending Run，检查 worker 的轮询间隔");
    console.log("取消验收通过（终态 409 / 不存在 404 / pending 200 且级联一致）");

    console.log("P1-A 接口层验收全部通过");
  } finally {
    for (const id of createdConversationIds) {
      // 走服务层深删：事件、工具调用、Task 一起清（Prisma 级联覆盖不到它们）
      await deleteConversationDeep(id, user.id).catch((error) => console.error("清理会话失败", id, error));
    }
    await prisma.$disconnect();
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("验收失败:", error);
    process.exit(1);
  });
```

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无输出

- [ ] **Step 3: 实跑（三终端）**

```
终端 A：npx tsx src/worker/index.mts
终端 B：npm run dev
终端 C：npx tsx src/scripts/agent-api-smoke.ts
```

Expected：依次打印「认证…」「会话…」「发消息…」「SSE…」「首屏契约…」「去重边界…」「取消…」，最后 `P1-A 接口层验收全部通过`，退出码 0。

**若 SSE 一项超时**：先看 worker 是否真的领到了任务（终端 A 应有 `[worker] agent 领取到 1 个待执行 Run`）。**不要相信 `TaskStop`** —— Windows 上它杀不掉 worker 派生的子 `node`，残留进程会用旧代码领任务（交接文档 §五）。

- [ ] **Step 4: 确认没有留下孤儿行**

```bash
npx tsx -e "import('./src/lib/server/core/db.ts').then(async ({ prisma }) => { const events = await prisma.agentEvent.count(); const calls = await prisma.agentToolCall.count(); const conversations = await prisma.agentConversation.count(); console.log({ events, calls, conversations }); await prisma.\$disconnect(); })"
```

Expected：`conversations` 回到跑脚本之前的数量（脚本产出的会话已被清理）。

- [ ] **Step 5: 提交**

```bash
git add src/scripts/agent-api-smoke.ts
git commit -m "test(agent): P1-A 接口层端到端验收脚本（9 项，含 SSE 与取消）"
```

---

### Task 17: 全量回归与交接文档

**Files:**
- Create: `docs/superpowers/HANDOFF-agent-p1a.md`

- [ ] **Step 1: 全量回归**

```bash
npx vitest run          # 期望全绿
npx tsc --noEmit        # 期望无输出
npx next build          # 期望成功，且路由数比 P0 基线 +6（本计划新增 6 个 route.ts：会话列表/详情/消息/事件/工件/取消）
```

- [ ] **Step 2: 重跑 P0 验收（改了 P0 代码的第二次确认）**

按 Task 2 的三终端流程再跑一次 `npx tsx src/scripts/agent-smoke.ts`，必须 `P0 验收全部通过`。

- [ ] **Step 3: 写交接文档**

`docs/superpowers/HANDOFF-agent-p1a.md`，必须含：

1. 一句话现状（A 块已完成并验收，C / B 块未开始）
2. **实测后的接口契约**：把 8 个接口的最终请求/响应形状抄下来（以 Task 16 脚本跑出来的实际响应为准，而不是本计划的预期）—— B 块的计划将以它为准
3. SSE 帧格式与 `last_event_id` 语义（含首屏 `events` 字段与去重边界）
4. 三终端验收流程与本次实测耗时
5. 本机陷阱复述（残留 worker、`db push` 无 migrations 目录）
6. **遗留项**：
   - C 块：7 个新工具（含 `library_search_notes` / `library_note_detail` 需要的 service 抽取）
   - B 块：8 个前端文件（含把 `reducer` / `nextPollInterval` 用现有 vitest 覆盖）
   - `docs/` 下仍没有「总的项目代码文档」（CLAUDE.md 原则 4 要求，P0 起就缺）—— 建议作为独立任务补
7. 未推送提示：本地提交数（`git status` 与 `git log origin/main..HEAD --oneline | wc -l`）

- [ ] **Step 4: 提交**

```bash
git add docs/superpowers/HANDOFF-agent-p1a.md
git commit -m "docs(agent): P1-A 交接说明（接口实测契约与遗留项）"
```

---

## 五、验收清单（对照 P1 设计稿 §7.1/§7.2 中属于 A 块的部分）

- [ ] `handle()` 加宽后 148 个既有路由零回归（`tsc` + 全量单测 + `next build`）
- [ ] `agent_events` 的 `message_end` 载荷里有 `text`（D23），且 `usage` 仍在（P0 验收脚本断言通过）
- [ ] `agent_tool_calls.summary` 对成功、失败、阻断三种路径都有值
- [ ] 8 个接口全部可用，认证 401 / 越权 404 / 并发 409 / 取消语义 200|409 均符合 §4.2
- [ ] SSE 按 id 严格递增推送，空闲时降速到 5s，心跳每 15s
- [ ] 首屏契约七个字段齐全，`latest_event_id` 与库中最大 id 一致，重连不重复渲染
- [ ] 删除会话不留下事件 / 工具调用 / Task 孤儿行
- [ ] `npx vitest run`、`npx tsc --noEmit`、`npx next build` 全绿
- [ ] `npx tsx src/scripts/agent-smoke.ts`（P0）与 `npx tsx src/scripts/agent-api-smoke.ts`（A 块）都通过

---

## 六、本计划的已知风险

| 风险 | 触发条件 | 处理 |
|---|---|---|
| SSE 在 dev 下被缓冲 | Next.js 对 GET 做静态优化 | 已加 `export const dynamic = "force-dynamic"`；Task 15 Step 3 用 `curl -N` 实测逐条到达 |
| `db push` 改坏本地库 | schema 与库有漂移时 `db push` 会提示重置 | Task 4 Step 3 用 `information_schema` 确认只多了一列；**若 `db push` 提示需要 reset，停下来问用户，不要确认** |
| SSE 长连接占满 dev server | 一次运行 + 页面刷新会留下未关闭的流 | `cancel()` 与 `req.signal` 双重退出；Task 16 跑完后确认 dev server 无持续报错 |
| 摘要为空的行 | 新工具（C 块）忘了写 `summarize` | `SkillDefinition.summarize` 是**必填**字段，漏写过不了 `tsc` |

