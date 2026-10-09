# 自主 Agent 工作台 P0 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 worker 进程中跑通 Agent ReAct 循环 —— 用户消息进、工具调用过程与产出落库、能完成"生成选题 → 生成文案包"并产出草稿记录。

**Architecture:** Pi Agent SDK（`@earendil-works/pi-agent-core`）作为循环运行时，`streamFn` 注入 `pi-ai` 的 `openai-completions` 适配器，通过 `getApiKey` 钩子接现有 `ModelConfig` 加密体系。技能目录从 `workflow-service.ts` 抽取为共享模块，Agent 与现有工作流编排共用同一套 `executeSkill`。循环只在 worker 进程运行，Next.js 侧永不 import Pi。

**Tech Stack:** Next.js 15.5 / TypeScript 5.9 / Prisma 6 / PostgreSQL / vitest 3 / Node 24 / tsx / `@earendil-works/pi-agent-core@1.1.0` / `@earendil-works/pi-ai@1.1.0` / typebox 1.3.27

**设计依据:** `docs/superpowers/specs/2026-10-09-agent-workspace-design.md`

---

## Task 0 实测后的架构调整（必读，影响 5 个文件命名）

**Task 0 已执行完毕，R1 实测失败并已定位根因，方案据此调整。**

### `.mts` 后缀规则（决策 D17）

Pi 包的 `exports` 映射**只声明 `types` + `import` 条件，无 `require`、无 `default`**。tsx 默认把 `.ts` 转成 CJS，导致**模块解析阶段**就失败（`ERR_PACKAGE_PATH_NOT_EXPORTED`），走不到 `require(esm)` 互操作。

**因此：凡是直接或间接 `import "@earendil-works/pi-*"` 的文件，一律使用 `.mts` 后缀**，让 tsx 按 ESM 加载。

| 文件 | 后缀 | 原因 |
|---|---|---|
| `src/worker/index.mts` | **.mts** | 入口，import agent-loop |
| `src/lib/server/agent/agent-loop.mts` | **.mts** | import Pi |
| `src/lib/server/agent/tool-registry.mts` | **.mts** | import Pi |
| `src/lib/server/agent/model-bridge.mts` | **.mts** | import Pi |
| `src/lib/server/agent/types.mts` | **.mts** | import Pi（声明合并）|
| `skill-catalog.ts` / `tool-schemas.ts` / `context.ts` / `guards.ts` / `persist.ts` | `.ts` | 无 Pi 依赖，保持 CJS |
| 所有 `*.test.ts` | `.ts` | vitest 走 vite 解析，不经 tsx |

`package.json` 的 worker 脚本改为：`"worker": "tsx src/worker/index.mts"`

**⚠️ 待验证（Task 0 遗留）**：`.mts` 入口 import 无 Pi 依赖的 `.ts` 模块（ESM → CJS 互操作），以及 vitest 能否跑 import `.mts` 的测试。Task 1 之前必须先验证这两点，否则任务 7/10/11 会连环卡住。

### 其余实测修正

| 项 | 修正 |
|---|---|
| `ModelCost` 需 **4 个字段**：`input` / `output` / `cacheRead` / `cacheWrite` | Task 4 的 `buildPiModel` 必须补全，否则 `tsc --noEmit` 失败 |
| `TranscriptContext` 是带品牌类型，官方称只能由 `normalizeContext()` 产出 | Task 10 不能用 `as never` 蒙混；`normalizeContext` 未在包根再导出，需先定位 |
| `UserMessage` 要求 `timestamp` 字段 | 构造消息勿遗漏 |
| `ModelConfig.provider` 是自由文本，默认 `"openai-compatible"`，不匹配 pi-ai 已知 provider ID | compat 探测实际只靠 `baseUrl` 子串；provider 差异（如 DeepSeek 的 `max_tokens`）不会自动生效。Task 4 考虑显式 provider → compat 映射 |
| 设计文档 §11.1 原写的 R1 缓解手段「Node 24 require(esm) 默认支持」**不成立** | 已订正设计文档 §11.1.1 |

---

## 与设计文档的其他偏差（已核实，以本计划为准）

| 设计文档原文 | 实际情况 | 本计划采用 |
|---|---|---|
| §10/§15.2：测试放 `tests/agent-*.test.ts` | vitest 配置 `include: ["src/**/*.test.ts"]`，`tests/` 目录**不被收集**（该目录下 4 个文件目前处于失效状态）| 测试与源码同目录，放 `src/lib/server/agent/*.test.ts` |
| §8.4：依赖只需 2 个包 | `tool-registry.mts` 会直接 `import { Type } from "typebox"`，而 typebox 只是 `pi-agent-core` 的传递依赖 | 显式声明 `typebox@1.3.27` 为直接依赖 |

---

## 关于代码块里的 `as never` 断言

计划中多处使用 `as never`（如 `streamFn: (...) as never`、`textClient: {} as never`）。这是**在 Pi 类型边界处的有意逃生口**，原因有二：

1. Pi 的部分类型是**具名/不可构造**的（如 `AssistantMessageEventStream`），我只读到 `.d.ts` 未验证其运行时构造方式，因此先用断言保证编译通过
2. 测试里的假对象（假 streamFn、假 textClient）无法满足完整接口

**要求**：实施时每写一处 `as never`，都要在该 Step 的 `npx tsc --noEmit` 之后尝试收窄 —— 能改成具体类型或 `as unknown as X` 的就改。Task 0 的验证结果会揭示 Pi 的真实构造方式，**Task 0 完成后回头复查后续任务的断言**。

`as never` 的风险是它会静默吞掉真实的类型错误。如果某个 Step 的测试通过但运行时报 `undefined is not a function`，优先回来检查这里的断言掩盖了真实不匹配。

---

## 文件结构

| 文件 | 职责 | 含 Pi 依赖 | 后缀 |
|---|---|---|---|
| `src/lib/server/agent/skill-catalog.ts` | `SkillDefinition` / `SKILL_CATALOG` / `SkillContext` / `executeSkill`（从 workflow-service 抽出）| ❌ | `.ts` |
| `src/lib/server/agent/tool-schemas.ts` | skillKey → TypeBox schema 映射 + 完整性断言 | ❌ | `.ts` |
| `src/lib/server/agent/guards.ts` | `riskLevel` 护栏（`beforeToolCall` 实现）| ❌ | `.ts` |
| `src/lib/server/agent/context.ts` | 字符预算裁剪 + 工具结果摘要 | ❌ | `.ts` |
| `src/lib/server/agent/persist.ts` | `AgentEvent` / `AgentToolCall` 落库 | ❌ | `.ts` |
| `src/lib/server/services/agent-service.ts` | 会话/消息/Run 的 CRUD + 任务领取 | ❌ | `.ts` |
| `src/lib/server/agent/model-bridge.mts` | `ModelConfigLike` → `pi-ai` `Model<"openai-completions">` | ✅ | **`.mts`** |
| `src/lib/server/agent/tool-registry.mts` | `executeSkill` → `AgentTool` 包装 | ✅ | **`.mts`** |
| `src/lib/server/agent/types.mts` | `CustomAgentMessages` 声明合并 | ✅ | **`.mts`** |
| `src/lib/server/agent/agent-loop.mts` | `Agent` 装配 + 单次 Run 驱动 | ✅ | **`.mts`** |
| `src/prompts/agent.md` | Agent system prompt 模板 | — | — |
| `src/worker/index.mts` | 新增 `agent_run_runner` + 崩溃清扫 | — | **`.mts`** |
| `src/scripts/agent-smoke.mts` | P0 端到端验收脚本 | — | **`.mts`** |

**边界铁律**：只有 `model-bridge.mts` / `tool-registry.mts` / `types.mts` / `agent-loop.mts` 四个文件可以 `import "@earendil-works/pi-*"`，且都必须是 `.mts`（见上方 D17）。其余文件保持无 Pi 依赖的 `.ts`，以便被 Next.js 侧安全 import。

---

## Task 0: 依赖引入与风险验证（R1 / R2 / R3）

**这是整个计划的地基。三个风险任何一个不成立，后续任务都要重新设计。**

**Files:**
- Modify: `package.json`
- Create: `src/scripts/spike-pi.ts`（临时验证脚本，验证完删除）

- [ ] **Step 1: 安装依赖**

```bash
cd F:/project/code/xhs-assistant
npm install "@earendil-works/pi-agent-core@1.1.0" "@earendil-works/pi-ai@1.1.0" "typebox@1.3.27"
```

Expected: 安装成功，`package.json` 的 `dependencies` 新增 3 项。

- [ ] **Step 2: 验证 R1 —— ESM 包能否被 tsx 加载**

创建 `src/scripts/spike-pi.ts`：

```ts
/**
 * Pi SDK 风险验证脚本（临时）
 * 验证 R1: ESM-only 包能否被 tsx 加载
 * 验证 R2: TypeBox schema 校验是否生效
 * 验证 R3: pi-ai 能否吃自定义 baseUrl
 */
import { Agent } from "@earendil-works/pi-agent-core";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { Type } from "typebox";

console.log("R1 通过: pi-agent-core 已加载, typeof Agent =", typeof Agent);
console.log("R1 通过: pi-ai streamSimple 已加载, typeof streamSimple =", typeof streamSimple);

const params = Type.Object({
  count: Type.Optional(Type.Number({ minimum: 1, maximum: 20 })),
});
console.log("R2 通过: TypeBox Type.Object 可用, schema =", JSON.stringify(params));
```

运行：

```bash
npx tsx src/scripts/spike-pi.ts
```

Expected: 三行 `R1 通过 / R1 通过 / R2 通过` 输出，无 `ERR_REQUIRE_ESM` 或 `Cannot find module`。

若失败（R1 不成立）：worker 需改为 ESM 启动（`package.json` 加 `"type": "module"` 会影响全局，改用 `tsx --tsconfig` 或独立 `.mts` 入口）。**此时停止，回报用户后再继续。**

- [ ] **Step 3: 验证 R2 —— TypeBox 校验真的会拒绝非法参数**

在 `src/scripts/spike-pi.ts` 末尾追加：

```ts
import { Value } from "typebox/value";

const good = Value.Check(params, { count: 5 });
const bad = Value.Check(params, { count: 999 });
const badType = Value.Check(params, { count: "五" });

console.log("R2:", { good, bad, badType });
if (good !== true || bad !== false || badType !== false) {
  throw new Error("R2 失败: TypeBox 校验未按预期工作");
}
console.log("R2 通过: TypeBox 校验生效（合法通过 / 超范围拒绝 / 类型错拒绝）");
```

运行：

```bash
npx tsx src/scripts/spike-pi.ts
```

Expected: `R2: { good: true, bad: false, badType: false }` 后跟 `R2 通过`。

- [ ] **Step 4: 验证 R3 —— pi-ai 吃自定义 baseUrl**

先确认 `.env` 里有可用的文本模型配置（数据库 `model_configs` 表需有 `model_type='text'` 且 `is_default=true` 的记录，并有对应账号）。

创建 `src/scripts/spike-pi-stream.ts`：

```ts
/**
 * Pi SDK 风险验证脚本（临时）：R3 —— 自定义 baseUrl 流式调用
 */
import { prisma } from "../lib/server/core/db";
import { decryptText } from "../lib/server/core/security";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import type { Model } from "@earendil-works/pi-ai";

async function main(): Promise<void> {
  const cfg = await prisma.modelConfig.findFirst({
    where: { modelType: "text", isDefault: true },
  });
  if (!cfg) throw new Error("数据库里没有默认文本模型配置，请先在「模型配置」页面添加");

  const apiKey = decryptText(cfg.encryptedApiKey);
  const model: Model<"openai-completions"> = {
    id: cfg.modelName,
    name: cfg.name,
    api: "openai-completions",
    provider: cfg.provider,
    baseUrl: cfg.baseUrl,
    input: ["text"],
    cost: { input: 0, output: 0 },
    reasoning: false,
    contextWindow: 128_000,
    maxTokens: 8_192,
  };

  console.log("R3 测试模型:", { provider: cfg.provider, modelName: cfg.modelName, baseUrl: cfg.baseUrl });

  const stream = streamSimple(model, {
    messages: [{ role: "user", content: "只回复两个字：成功" }],
  } as never, { apiKey } as never);

  for await (const event of stream as AsyncIterable<unknown>) {
    console.log("R3 事件:", JSON.stringify(event).slice(0, 200));
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("R3 失败:", error);
    process.exit(1);
  });
```

运行：

```bash
npx tsx src/scripts/spike-pi-stream.ts
```

Expected: 输出 `R3 事件:` 若干行，其中包含模型返回的文本内容。

若失败（R3 不成立）：需在 `Model` 对象里显式填 `compat` 字段适配该 provider。若仍失败，**停止并回报用户** —— 可能需要改回自研传输层。

- [ ] **Step 5: 记录验证结果到设计文档**

在 `docs/superpowers/specs/2026-10-09-agent-workspace-design.md` 的 §11.1 表格下方追加实测结论：

```markdown
### 11.1.1 实测结果（YYYY-MM-DD）

| 风险 | 结果 | 备注 |
|---|---|---|
| R1 ESM 加载 | ✅ / ❌ | 实际输出 |
| R2 TypeBox 校验 | ✅ / ❌ | 实际输出 |
| R3 自定义 baseUrl | ✅ / ❌ | 实测的 provider |
```

- [ ] **Step 6: 清理临时脚本并提交**

```bash
cd F:/project/code/xhs-assistant
rm src/scripts/spike-pi.ts src/scripts/spike-pi-stream.ts
git add package.json package-lock.json docs/
git commit -m "chore: 引入 Pi Agent SDK 依赖并完成 R1/R2/R3 风险验证"
```

---

## Task 1: Prisma 新增 5 张 Agent 表

**Files:**
- Modify: `prisma/schema.prisma`（在文件末尾追加）

- [ ] **Step 1: 追加 5 个 model**

在 `prisma/schema.prisma` 末尾追加：

```prisma
/// 会话：一个对话 = 一个独立任务，多会话并行互不干扰
model AgentConversation {
  id        Int      @id @default(autoincrement())
  userId    Int      @map("user_id")
  title     String   @default("新任务")
  status    String   @default("idle")
  createdAt DateTime @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")

  messages AgentMessage[]
  runs     AgentRun[]

  @@index([userId, status])
  @@map("agent_conversations")
}

/// 消息：对话语义层（LLM 上下文来源）
model AgentMessage {
  id             Int      @id @default(autoincrement())
  conversationId Int      @map("conversation_id")
  runId          Int?     @map("run_id")
  role           String
  content        String   @db.Text @default("")
  toolCalls      Json?    @map("tool_calls")
  toolCallId     String?  @map("tool_call_id")
  tokenUsage     Json?    @map("token_usage")
  createdAt      DateTime @map("created_at")

  conversation AgentConversation @relation(fields: [conversationId], references: [id], onDelete: Cascade)

  @@index([conversationId, id])
  @@map("agent_messages")
}

/// 执行：一次 ReAct 循环 = 一个 Run，1:1 绑定 Task
model AgentRun {
  id               Int       @id @default(autoincrement())
  conversationId   Int       @map("conversation_id")
  userId           Int       @map("user_id")
  taskId           Int       @map("task_id")
  status           String    @default("pending")
  triggerMessageId Int?      @map("trigger_message_id")
  stepCount        Int       @default(0)
  maxSteps         Int       @default(20)
  tokenBudget      Int       @default(200000)
  tokensUsed       Int       @default(0)
  errorType        String?   @map("error_type")
  startedAt        DateTime? @map("started_at")
  finishedAt       DateTime? @map("finished_at")
  createdAt        DateTime  @map("created_at")

  conversation AgentConversation @relation(fields: [conversationId], references: [id], onDelete: Cascade)

  @@index([status, createdAt])
  @@map("agent_runs")
}

/// 事件：循环过程细节，SSE 订阅源（自增 id 即 Last-Event-ID）
model AgentEvent {
  id        Int      @id @default(autoincrement())
  runId     Int      @map("run_id")
  type      String
  payload   Json
  createdAt DateTime @map("created_at")

  @@index([runId, id])
  @@map("agent_events")
}

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
  createdAt  DateTime @map("created_at")

  @@index([runId, stepIndex])
  @@map("agent_tool_calls")
}
```

**三处必须注意的设计点：**

1. **`conversation` 关系是必需的**。Prisma 要求关系两侧都声明。`AgentConversation` 上的 `messages AgentMessage[]` / `runs AgentRun[]` 需要子侧配 `@relation(...)`，否则 `prisma validate` 报 `P1012 missing an opposite relation field`。
   **不要**通过删除父侧数组来"修复"—— 现有 schema（`Note`→`NoteAsset`/`NoteComment`、`AiDraft`→`DraftAsset`、`PlatformAccount`→`AccountCookieVersion` 等）一致使用「父侧数组 + 子侧 `@relation` + `onDelete: Cascade`」。且级联删除是必要行为：删会话应连带删除其消息与 Run。

2. **`AgentRun.taskId` 是刻意的裸标量，不建关系**。建关系需要反向修改现有的 `Task` 模型（加 `agentRuns AgentRun[]`），而本设计明确「复用 Task 做执行载体、不修改 Task」。所有代码按标量 id 查询，功能不受影响。

3. **`createdAt` 均无 `@default(now())`** —— 这是全库一致约定（`grep -c "@default(now())" prisma/schema.prisma` 为 0），时间戳由代码显式传 `shanghaiNow()` 以保证上海时区。
   **因此所有 create 调用必须显式传 `createdAt`**，遗漏会在运行时报错（Prisma 不会给默认值）。

- [ ] **Step 2: 校验 schema 并生成客户端**

```bash
cd F:/project/code/xhs-assistant
npx prisma validate
npx prisma generate
```

Expected: `The schema at prisma/schema.prisma is valid` 后 `Generated Prisma Client`。

- [ ] **Step 3: 推送到数据库**

```bash
npx prisma db push
```

Expected: `Your database is now in sync with your Prisma schema.`

注意：本机使用宿主 PostgreSQL 18（localhost:5432）。若报连接错误，确认 `.env` 的 `DATABASE_URL` 与 PostgreSQL 服务状态。

- [ ] **Step 4: 验证表可读写**

**注意**：`npx tsx -e "..."` 在本项目下不产出输出（Task 0 实测）。改用临时脚本文件。

创建 `src/scripts/verify-agent-tables.ts`：

```ts
import { prisma } from "../lib/server/core/db";
import { shanghaiNow } from "../lib/server/core/time";

async function main() {
  const conv = await prisma.agentConversation.create({
    data: { userId: 1, title: "验证会话", createdAt: shanghaiNow() },
  });
  console.log("created:", conv.id, conv.title);

  const run = await prisma.agentRun.create({
    data: { conversationId: conv.id, userId: 1, taskId: 1, createdAt: shanghaiNow() },
  });
  console.log("run:", run.id, run.status, "maxSteps=", run.maxSteps);

  await prisma.agentEvent.create({
    data: { runId: run.id, type: "agent_start", payload: {}, createdAt: shanghaiNow() },
  });
  const events = await prisma.agentEvent.findMany({ where: { runId: run.id } });
  console.log("events:", events.length, events[0].type);

  await prisma.agentMessage.create({
    data: { conversationId: conv.id, role: "user", content: "你好", createdAt: shanghaiNow() },
  });
  await prisma.agentToolCall.create({
    data: { runId: run.id, stepIndex: 0, toolName: "test_tool", toolCallId: "call-1", params: {}, createdAt: shanghaiNow() },
  });
  console.log("messages/toolCalls 写入成功");

  // 验证级联删除：删会话应连带删除消息与 Run
  await prisma.agentConversation.delete({ where: { id: conv.id } });
  const leftoverMessages = await prisma.agentMessage.count({ where: { conversationId: conv.id } });
  const leftoverRuns = await prisma.agentRun.count({ where: { id: run.id } });
  console.log("级联删除检查: messages=", leftoverMessages, "runs=", leftoverRuns);
  if (leftoverMessages !== 0 || leftoverRuns !== 0) throw new Error("级联删除未生效");

  // 清理不随级联走的表
  await prisma.agentEvent.deleteMany({ where: { runId: run.id } });
  await prisma.agentToolCall.deleteMany({ where: { runId: run.id } });
  console.log("OK 清理完成");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("ERR:", e.message);
    process.exit(1);
  });
```

运行：

```bash
npx tsx src/scripts/verify-agent-tables.ts
```

Expected: `created: <id> 验证会话` / `run: <id> pending maxSteps= 20` / `events: 1 agent_start` / `messages/toolCalls 写入成功` / `级联删除检查: messages= 0 runs= 0` / `OK 清理完成`

验证完删除该临时脚本（**不要提交它**）。

- [ ] **Step 5: 提交**

```bash
git add prisma/schema.prisma
git commit -m "feat(prisma): 新增 Agent 工作台 5 张表"
```

---

## Task 2: 抽取 skill-catalog.ts（纯重构，行为不变）

把 `SKILL_CATALOG` / `SkillDefinition` / `SkillContext` / `executeSkill` 从 `workflow-service.ts` 移到新文件，并新增 `riskLevel` / `artifact` 元数据。

**Files:**
- Create: `src/lib/server/agent/skill-catalog.ts`
- Modify: `src/lib/server/services/workflow-service.ts`（删除被抽出的部分，改为 import）
- Test: `src/lib/server/agent/skill-catalog.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `src/lib/server/agent/skill-catalog.test.ts`：

```ts
/**
 * 技能目录单元测试
 * 覆盖：目录完整性、元数据字段、riskLevel 合法性
 */
import { describe, expect, it } from "vitest";
import { SKILL_CATALOG, findSkillDefinition } from "./skill-catalog";

const VALID_RISK_LEVELS = ["read", "write", "publish"];

describe("SKILL_CATALOG（技能目录）", () => {
  it("包含全部 6 个预置技能", () => {
    const keys = SKILL_CATALOG.map((item) => item.skillKey).sort();
    expect(keys).toEqual([
      "content.notePack",
      "hot.refresh",
      "review.submit",
      "schedule.recommend",
      "script.generate",
      "topic.generate",
    ]);
  });

  it("每个技能都有合法的 riskLevel", () => {
    for (const item of SKILL_CATALOG) {
      expect(VALID_RISK_LEVELS, `技能 ${item.skillKey} 的 riskLevel`).toContain(item.riskLevel);
    }
  });

  it("每个技能都有非空 name / description / instructions / paramsSchema", () => {
    for (const item of SKILL_CATALOG) {
      expect(item.name.length, `${item.skillKey}.name`).toBeGreaterThan(0);
      expect(item.description.length, `${item.skillKey}.description`).toBeGreaterThan(0);
      expect(item.instructions.length, `${item.skillKey}.instructions`).toBeGreaterThan(0);
      expect(typeof item.paramsSchema, `${item.skillKey}.paramsSchema`).toBe("object");
    }
  });

  it("skillKey 全局唯一", () => {
    const keys = SKILL_CATALOG.map((item) => item.skillKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("findSkillDefinition 能按 skillKey 查到，未知 key 返回 undefined", () => {
    expect(findSkillDefinition("topic.generate")?.name).toBe("选题生成");
    expect(findSkillDefinition("not.exist")).toBeUndefined();
  });

  it("6 个技能全部为 read 或 write，不含 publish（首期不开放发布）", () => {
    for (const item of SKILL_CATALOG) {
      expect(item.riskLevel, `技能 ${item.skillKey} 不应为 publish`).not.toBe("publish");
    }
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd F:/project/code/xhs-assistant
npx vitest run src/lib/server/agent/skill-catalog.test.ts
```

Expected: FAIL —— `Failed to resolve import "./skill-catalog"`

- [ ] **Step 3: 创建 skill-catalog.ts**

创建 `src/lib/server/agent/skill-catalog.ts`。内容 = 从 `workflow-service.ts` 原样搬移 `SkillDefinition`、`SKILL_CATALOG`、`SkillContext`、`executeSkill`，并：

1. `SkillDefinition` 新增 `riskLevel` 与 `artifact` 字段
2. `SkillContext` 改为 `export`
3. `executeSkill` 改为 `export`
4. 新增 `findSkillDefinition`
5. 补全 import（相对路径从 `./xxx-service` 变为 `../services/xxx-service`）

```ts
/**
 * Agent 技能目录与执行器
 *
 * 从 workflow-service.ts 抽出，供「工作流编排」与「Agent 循环」共用。
 * 【本文件不含 Pi 依赖】—— 可被 Next.js 侧安全 import。
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "../core/db";
import { extractJsonObject } from "../core/json-extract";
import { shanghaiNow } from "../core/time";
import type { ModelConfigLike, OpenAICompatibleTextClient } from "../services/ai-service";
import { buildKbContext } from "../services/knowledge-base-service";
import { createReviewJob } from "../services/review-service";
import { generateSuggestions } from "../services/suggestion-service";
import { collectHotTopicsForUser } from "../services/hot-topic-service";
import { makeUsageLogger } from "../services/usage-service";

/** 工件类型：驱动 Agent 工作台的右栏工件面板渲染 */
export type ArtifactKind = "draft" | "topic" | "image" | "review" | "report" | "script";

/** 产出物声明：把工具返回值映射为工件面板条目 */
export interface ArtifactSpec {
  kind: ArtifactKind;
  /** 产出物 id 所在字段名；该字段是数组时表示一次产出多个工件 */
  idField: string;
  /** 标题字段名（数组产出按索引对应；单产出取首项） */
  titleField?: string;
  /** 跳转链接前缀，拼接 id 得到 href */
  hrefPrefix: string;
}

/** 技能护栏分级：read 直接执行 / write 直接执行但产出待验收 / publish 需人工确认 */
export type SkillRiskLevel = "read" | "write" | "publish";

export interface SkillDefinition {
  skillKey: string;
  name: string;
  description: string;
  paramsSchema: Record<string, unknown>;
  /** SKILL.md 风格指令正文（Markdown，含 frontmatter） */
  instructions: string;
  /** 护栏分级（新增） */
  riskLevel: SkillRiskLevel;
  /** 产出物声明，驱动工件面板（新增） */
  artifact?: ArtifactSpec;
}

export const SKILL_CATALOG: SkillDefinition[] = [
  {
    skillKey: "hot.refresh",
    name: "热点采集",
    description: "采集全站热点榜单（30 分钟任务的手动版）",
    paramsSchema: { type: "object", properties: {} },
    // 注意：热点采集会写库（hotTopic.createMany + deleteMany 清上一批），故为 write 而非 read
    riskLevel: "write",
    instructions: `---
name: 热点采集
description: 采集全站热点榜单，计算热度分并生成 TOP50 快照
---

# 热点采集

调用 PC 搜索接口采集种子关键词的全站热点，按热度分排序生成 TOP50 榜单快照。

## 参数

无参数。

## 输出

返回本次采集收录的话题数量（collected）。`,
  },
  {
    skillKey: "topic.generate",
    name: "选题生成",
    description: "基于知识库+热点+爆款结构生成选题列表",
    paramsSchema: { type: "object", properties: { count: { type: "number", default: 5 } } },
    riskLevel: "write",
    // 多产出：suggestion_ids 与 titles 都是数组，按索引对应
    artifact: {
      kind: "topic",
      idField: "suggestion_ids",
      titleField: "titles",
      hrefPrefix: "/platforms/xhs/planner?id=",
    },
    instructions: `---
name: 选题生成
description: 基于账号知识库、实时热点与爆款拆解结构，生成可直接落地的选题列表
---

# 选题生成

结合账号知识库（定位/口吻/经验结论）、当前热点 TOP10 与最新爆款拆解结构，生成小红书选题。

## 参数

- count：生成数量（默认 5，最多 20）

## 输出

返回选题 ID 列表（suggestion_ids）、标题列表（titles）与生成数量（count）。`,
  },
  {
    skillKey: "content.notePack",
    name: "文案包生成",
    description: "生成标题/正文/标签/CTA 完整文案包并保存草稿",
    paramsSchema: { type: "object", properties: { topic: { type: "string" } } },
    riskLevel: "write",
    artifact: {
      kind: "draft",
      idField: "draft_id",
      titleField: "titles",
      hrefPrefix: "/platforms/xhs/drafts?id=",
    },
    instructions: `---
name: 文案包生成
description: 围绕选题生成标题备选、正文、话题标签与行动引导的完整文案包，并保存为草稿
---

# 文案包生成

围绕给定选题，参考账号知识库生成 3-5 个标题备选、300-800 字正文、话题标签与行动引导，落库为草稿。

## 参数

- topic：选题标题（必填）

## 输出

返回草稿 ID（draft_id）、标题备选（titles）与标签（tags）。`,
  },
  {
    skillKey: "review.submit",
    name: "内容审校",
    description: "双层检测 + 三道门禁审校",
    paramsSchema: { type: "object", properties: { draft_id: { type: "number" } } },
    riskLevel: "write",
    artifact: {
      kind: "review",
      idField: "review_id",
      hrefPrefix: "/platforms/xhs/review?id=",
    },
    instructions: `---
name: 内容审校
description: 对草稿执行合规规则检测与三道门禁审校
---

# 内容审校

对指定草稿执行双层检测（关键词/规则 + LLM 审校）与三道门禁（广告法/违禁词/敏感内容），生成审校工单。

## 参数

- draft_id：草稿 ID（必填）

## 输出

返回审校工单 ID（review_id）、门禁状态（gate_status）与状态（status）。`,
  },
  {
    skillKey: "script.generate",
    name: "视频脚本生成",
    description: "基于草稿文案生成短视频脚本",
    paramsSchema: { type: "object", properties: { draft_id: { type: "number" } } },
    // generateVideoScript 无任何 prisma 调用（只读草稿 + 调 LLM），故为 read 而非 write
    // 不声明 artifact：返回 { script: string } 是无数据库行的纯文本，ArtifactRef.id 为 number 无法映射
    riskLevel: "read",
    instructions: `---
name: 视频脚本生成
description: 将图文草稿转化为 30-60 秒口播分镜脚本
---

# 视频脚本生成

基于草稿文案生成短视频分镜脚本：开场钩子（前 3 秒）→ 内容展开（分镜列表）→ 结尾引导。

## 参数

- draft_id：草稿 ID（必填）

## 输出

返回分镜脚本文本（script）。`,
  },
  {
    skillKey: "schedule.recommend",
    name: "智能排期",
    description: "基于历史数据推荐发布时间",
    paramsSchema: { type: "object", properties: { platform_account_id: { type: "number" } } },
    // recommendSchedules 仅 findFirst/findMany，无写入，故为 read
    riskLevel: "read",
    instructions: `---
name: 智能排期
description: 基于历史发布数据与平台活跃规律，推荐未来 3 天最佳发布时间
---

# 智能排期

基于历史发布数据与平台活跃规律，推荐未来 3 天最佳发布时间。

## 参数

- platform_account_id：发布账号 ID（必填）

## 输出

返回推荐时段列表（slots）与推荐理由（reason）。`,
  },
];

/** 按 skillKey 查找技能定义 */
export function findSkillDefinition(skillKey: string): SkillDefinition | undefined {
  return SKILL_CATALOG.find((item) => item.skillKey === skillKey);
}

/** 技能执行上下文 */
export interface SkillContext {
  userId: number;
  textClient: OpenAICompatibleTextClient;
  modelConfig: ModelConfigLike | null;
  apiKey: string;
}

/** 执行单个技能（映射到现有服务函数） */
export async function executeSkill(
  skillKey: string,
  params: Record<string, unknown>,
  context: SkillContext,
): Promise<Record<string, unknown>> {
  const { userId, textClient, modelConfig, apiKey } = context;
  switch (skillKey) {
    case "hot.refresh": {
      const account = await prisma.platformAccount.findFirst({
        where: { userId, platform: "xhs", subType: "pc" },
        orderBy: { id: "asc" },
      });
      if (!account) throw new Error("未绑定 PC 账号，无法刷新热点");
      const cookieVersion = await prisma.accountCookieVersion.findFirst({
        where: { platformAccountId: account.id },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      });
      if (!cookieVersion) throw new Error("PC 账号无有效 Cookie");
      const { XhsPcApiAdapter } = await import("../xhs/adapters/pc-api-adapter");
      const result = await collectHotTopicsForUser({
        userId,
        adapterFactory: (cookies) => new XhsPcApiAdapter(cookies),
      });
      return { collected: result.collected };
    }
    case "topic.generate": {
      if (!modelConfig || !apiKey) throw new Error("未配置文本模型，无法生成选题");
      const count = Math.max(1, Math.min(Number(params.count) || 5, 20));
      const { items } = await generateSuggestions({ userId, count, textClient, modelConfig, apiKey });
      return {
        suggestion_ids: items.map((item) => Number(item.id)),
        titles: items.map((item) => String(item.title)),
        count: items.length,
      };
    }
    case "content.notePack": {
      if (!modelConfig || !apiKey) throw new Error("未配置文本模型，无法生成文案包");
      const topic = String(params.topic ?? "").trim();
      if (!topic) throw new Error("缺少选题（topic）参数");
      const kbContext = await buildKbContext(userId);
      const pack = await textClient.generateNotePack({
        modelConfig,
        apiKey,
        topic,
        kbContext,
        onUsage: makeUsageLogger(userId, modelConfig.modelName),
      });
      const draft = await prisma.aiDraft.create({
        data: {
          userId,
          platform: "xhs",
          title: pack.titles[0] ?? topic,
          body: pack.body || "",
          tags: pack.tags.length ? (pack.tags as Prisma.InputJsonValue) : undefined,
          createdAt: shanghaiNow(),
        },
      });
      return { draft_id: draft.id, titles: pack.titles, tags: pack.tags };
    }
    case "review.submit": {
      const draftId = Number(params.draft_id);
      if (!draftId) throw new Error("缺少草稿（draft_id）参数");
      const draft = await prisma.aiDraft.findFirst({ where: { id: draftId, userId } });
      if (!draft) throw new Error("草稿不存在");
      const { job } = await createReviewJob({
        userId,
        sourceDraftId: draft.id,
        title: draft.title,
        body: draft.body,
        textClient: modelConfig && apiKey ? textClient : null,
        modelConfig: modelConfig ?? null,
        apiKey: apiKey ?? null,
      });
      return { review_id: job.id, gate_status: job.gateStatus, status: job.status };
    }
    case "script.generate": {
      if (!modelConfig || !apiKey) throw new Error("未配置文本模型，无法生成脚本");
      const draftId = Number(params.draft_id);
      if (!draftId) throw new Error("缺少草稿（draft_id）参数");
      const draft = await prisma.aiDraft.findFirst({ where: { id: draftId, userId } });
      if (!draft) throw new Error("草稿不存在");
      const script = await textClient.generateVideoScript({
        modelConfig,
        apiKey,
        onUsage: makeUsageLogger(userId, modelConfig.modelName),
        title: draft.title,
        body: draft.body,
      });
      return { script };
    }
    case "schedule.recommend": {
      const accountId = Number(params.platform_account_id);
      if (!accountId) throw new Error("缺少发布账号（platform_account_id）参数");
      const { recommendSchedules } = await import("../services/schedule-service");
      const result = await recommendSchedules({ userId, platformAccountId: accountId, days: 3 });
      return { slots: result.slots, reason: result.reason };
    }
    default: {
      // 自定义技能：以注册表维护的 instructions（SKILL.md 风格）作为 system prompt，由 LLM 驱动执行
      if (!modelConfig || !apiKey) throw new Error("未配置文本模型，无法执行自定义技能");
      const custom = await prisma.skillRegistry.findFirst({ where: { userId, skillKey, enabled: true } });
      if (!custom || !custom.instructions.trim()) throw new Error(`未知技能: ${skillKey}`);
      const outputText = await textClient.complete({
        modelConfig,
        apiKey,
        systemPrompt: custom.instructions,
        userPrompt: `请执行该技能。技能参数（JSON）：${JSON.stringify(params)}\n只输出 JSON 结果。`,
        temperature: 0.3,
        onUsage: makeUsageLogger(userId, modelConfig.modelName),
      });
      const payload = extractJsonObject<Record<string, unknown>>(outputText);
      return payload ?? { result: outputText };
    }
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
npx vitest run src/lib/server/agent/skill-catalog.test.ts
```

Expected: PASS，6 个测试全通过。

- [ ] **Step 5: 改造 workflow-service.ts 改为 import**

编辑 `src/lib/server/services/workflow-service.ts`：

1. 删除第 27–175 行的 `SkillDefinition` 接口与 `SKILL_CATALOG` 常量
2. 删除第 352–476 行的 `StepOutput` 之后的 `SkillContext` 接口与 `executeSkill` 函数（**保留** `StepOutput` 接口）
3. 删除 `executeSkill` 中不再使用的 import
4. 文件顶部加：

```ts
import { SKILL_CATALOG, executeSkill, type SkillContext } from "../agent/skill-catalog";

// 技能目录与执行器已抽取至 agent/skill-catalog（无 Pi 依赖），此处再导出以保持原有引用路径可用
export { SKILL_CATALOG, findSkillDefinition, type SkillDefinition } from "../agent/skill-catalog";
```

**注意**：`export { X } from "..."` 只做再导出，**不产生本地绑定**。而 `workflow-service.ts` 本地要用到 `SKILL_CATALOG`（`ensureUserSkills`）和 `SkillContext`（`runWorkflow`），所以必须同时有一条 `import` 语句。漏掉会报 `Cannot find name 'SKILL_CATALOG'`。

**另一个坑**：`tsconfig.json` **没有开 `noUnusedLocals`**，所以删代码后遗留的未使用 import `tsc` 不会报错，需要手动排查（`grep` 每个可疑 import 的符号在文件内的使用次数）。

- [ ] **Step 6: 运行全部测试确认重构无回归**

```bash
npx vitest run
```

Expected: 11 个测试文件全通过（原 10 个 + 新增 skill-catalog.test.ts），共 96 个测试。

若有失败，检查是否漏搬了某个 `case` 分支或缺了 import。

- [ ] **Step 7: 类型检查**

```bash
npx tsc --noEmit
```

Expected: 无错误。

- [ ] **Step 8: 提交**

```bash
git add src/lib/server/agent/skill-catalog.ts src/lib/server/agent/skill-catalog.test.ts src/lib/server/services/workflow-service.ts
git commit -m "refactor: 抽取 skill-catalog 供工作流与 Agent 共用，新增 riskLevel/artifact 元数据"
```

---

## Task 3: TypeBox schema 映射表

**Files:**
- Create: `src/lib/server/agent/tool-schemas.ts`
- Test: `src/lib/server/agent/tool-schemas.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `src/lib/server/agent/tool-schemas.test.ts`：

```ts
/**
 * 工具 schema 单元测试
 * 覆盖：映射完整性、TypeBox 校验行为
 */
import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { SKILL_CATALOG } from "./skill-catalog";
import { TOOL_SCHEMAS, assertSchemasComplete, getToolSchema } from "./tool-schemas";

describe("TOOL_SCHEMAS（工具入参 schema）", () => {
  it("每个 SKILL_CATALOG 技能都有对应的 TypeBox schema", () => {
    for (const item of SKILL_CATALOG) {
      expect(TOOL_SCHEMAS[item.skillKey], `缺少 ${item.skillKey} 的 schema`).toBeDefined();
    }
  });

  it("没有多余的 schema（避免拼写错误的孤儿项）", () => {
    const catalogKeys = new Set(SKILL_CATALOG.map((item) => item.skillKey));
    for (const key of Object.keys(TOOL_SCHEMAS)) {
      expect(catalogKeys.has(key), `TOOL_SCHEMAS 中的 ${key} 不在 SKILL_CATALOG 里`).toBe(true);
    }
  });

  it("assertSchemasComplete 在完整时不抛错", () => {
    expect(() => assertSchemasComplete()).not.toThrow();
  });

  it("hot.refresh 接受空对象", () => {
    expect(Value.Check(getToolSchema("hot.refresh"), {})).toBe(true);
  });

  it("topic.generate 的 count 超出范围被拒绝", () => {
    const schema = getToolSchema("topic.generate");
    expect(Value.Check(schema, {})).toBe(true);           // count 可选
    expect(Value.Check(schema, { count: 5 })).toBe(true);
    expect(Value.Check(schema, { count: 999 })).toBe(false);  // 超上限
    expect(Value.Check(schema, { count: 0 })).toBe(false);    // 超下限
  });

  it("content.notePack 缺少 topic 被拒绝", () => {
    const schema = getToolSchema("content.notePack");
    expect(Value.Check(schema, {})).toBe(false);
    expect(Value.Check(schema, { topic: "露营装备" })).toBe(true);
    expect(Value.Check(schema, { topic: 123 })).toBe(false);
  });

  it("review.submit 的 draft_id 必须为正整数", () => {
    const schema = getToolSchema("review.submit");
    expect(Value.Check(schema, { draft_id: 12 })).toBe(true);
    expect(Value.Check(schema, { draft_id: -1 })).toBe(false);
    expect(Value.Check(schema, {})).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
npx vitest run src/lib/server/agent/tool-schemas.test.ts
```

Expected: FAIL —— `Failed to resolve import "./tool-schemas"`

- [ ] **Step 3: 实现 tool-schemas.ts**

创建 `src/lib/server/agent/tool-schemas.ts`：

```ts
/**
 * 工具入参 schema（TypeBox）
 *
 * Pi Agent 用 TypeBox 做工具入参校验（AgentTool.parameters: TSchema）。
 * SKILL_CATALOG 里的 paramsSchema 是裸 JSON Schema，缺 TypeBox 的 [Kind] 符号，
 * 直接强转会导致校验静默失效，因此在此重建。
 *
 * 【本文件不含 Pi 依赖】—— typebox 是独立校验库。
 */
import { Type, type TSchema } from "typebox";
import { SKILL_CATALOG } from "./skill-catalog";

/** skillKey → TypeBox 入参 schema */
export const TOOL_SCHEMAS: Record<string, TSchema> = {
  "hot.refresh": Type.Object({}, { description: "热点采集无需参数" }),

  "topic.generate": Type.Object({
    count: Type.Optional(
      Type.Number({
        minimum: 1,
        maximum: 20,
        default: 5,
        description: "生成选题数量，默认 5，最多 20",
      }),
    ),
  }),

  "content.notePack": Type.Object({
    topic: Type.String({ minLength: 1, description: "选题标题，必填" }),
  }),

  "review.submit": Type.Object({
    draft_id: Type.Integer({ minimum: 1, description: "待审校的草稿 ID，必填" }),
  }),

  "script.generate": Type.Object({
    draft_id: Type.Integer({ minimum: 1, description: "生成视频脚本的草稿 ID，必填" }),
  }),

  "schedule.recommend": Type.Object({
    platform_account_id: Type.Integer({ minimum: 1, description: "发布账号 ID，必填" }),
  }),
};

/** 启动时断言：SKILL_CATALOG 与 TOOL_SCHEMAS 必须一一对应，避免漏配 */
export function assertSchemasComplete(): void {
  for (const item of SKILL_CATALOG) {
    if (!TOOL_SCHEMAS[item.skillKey]) {
      throw new Error(`技能 ${item.skillKey} 缺少 TypeBox schema，请在 tool-schemas.ts 中补齐`);
    }
  }
  const catalogKeys = new Set(SKILL_CATALOG.map((item) => item.skillKey));
  for (const key of Object.keys(TOOL_SCHEMAS)) {
    if (!catalogKeys.has(key)) {
      throw new Error(`TOOL_SCHEMAS 中的 ${key} 不在 SKILL_CATALOG 里，请检查拼写`);
    }
  }
}

/** 取指定技能的 schema，缺失时抛错 */
export function getToolSchema(skillKey: string): TSchema {
  const schema = TOOL_SCHEMAS[skillKey];
  if (!schema) throw new Error(`技能 ${skillKey} 缺少 TypeBox schema`);
  return schema;
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
npx vitest run src/lib/server/agent/tool-schemas.test.ts
```

Expected: PASS，7 个测试全通过。

若 `Type.Integer({ minimum: 1 })` 对 `draft_id: -1` 未拒绝，改用 `Type.Number({ minimum: 1 })` 并加 `Type.Integer()` 校验，或改为在 `execute()` 内自行校验。

- [ ] **Step 5: 提交**

```bash
git add src/lib/server/agent/tool-schemas.ts src/lib/server/agent/tool-schemas.test.ts
git commit -m "feat(agent): 新增工具入参 TypeBox schema 映射与完整性断言"
```

---

## Task 4: ModelConfig → pi-ai Model 桥接

**Files:**
- Create: `src/lib/server/agent/model-bridge.ts`
- Test: `src/lib/server/agent/model-bridge.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `src/lib/server/agent/model-bridge.test.ts`：

```ts
/**
 * 模型桥接单元测试
 * 覆盖：ModelConfigLike → pi-ai Model 字段映射
 */
import { describe, expect, it } from "vitest";
import { buildPiModel } from "./model-bridge";

const cfg = {
  id: 1,
  userId: 7,
  name: "DeepSeek 文本模型",
  modelType: "text",
  provider: "deepseek",
  modelName: "deepseek-chat",
  baseUrl: "https://api.deepseek.com/v1",
  encryptedApiKey: "encrypted",
  isDefault: true,
};

describe("buildPiModel（ModelConfig → pi-ai Model）", () => {
  it("id 与 name 正确映射", () => {
    const model = buildPiModel(cfg);
    expect(model.id).toBe("deepseek-chat");
    expect(model.name).toBe("DeepSeek 文本模型");
  });

  it("api 固定为 openai-completions", () => {
    expect(buildPiModel(cfg).api).toBe("openai-completions");
  });

  it("baseUrl 与 provider 透传", () => {
    const model = buildPiModel(cfg);
    expect(model.baseUrl).toBe("https://api.deepseek.com/v1");
    expect(model.provider).toBe("deepseek");
  });

  it("baseUrl 尾部斜杠被清理", () => {
    const model = buildPiModel({ ...cfg, baseUrl: "https://api.deepseek.com/v1///" });
    expect(model.baseUrl).toBe("https://api.deepseek.com/v1");
  });

  it("必填字段齐全（cost / input / reasoning / contextWindow / maxTokens）", () => {
    const model = buildPiModel(cfg);
    expect(model.input).toEqual(["text"]);
    expect(typeof model.reasoning).toBe("boolean");
    expect(model.contextWindow).toBeGreaterThan(0);
    expect(model.maxTokens).toBeGreaterThan(0);
    expect(typeof model.cost.input).toBe("number");
    expect(typeof model.cost.output).toBe("number");
  });

  it("baseUrl 为空时抛错（避免把请求发到错误地址）", () => {
    expect(() => buildPiModel({ ...cfg, baseUrl: "" })).toThrow(/base_url/);
  });

  it("modelName 为空时抛错", () => {
    expect(() => buildPiModel({ ...cfg, modelName: "" })).toThrow(/model_name/);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
npx vitest run src/lib/server/agent/model-bridge.test.ts
```

Expected: FAIL —— `Failed to resolve import "./model-bridge"`

- [ ] **Step 3: 实现 model-bridge.ts**

创建 `src/lib/server/agent/model-bridge.ts`：

```ts
/**
 * ModelConfig → pi-ai Model 桥接
 *
 * Pi 的 Model 是普通对象字面量（BaseModel 接口），无需注册 provider。
 * compat 字段不填，pi-ai 会按 baseUrl 自动探测 OpenAI 兼容性。
 *
 * 【本文件含 Pi 依赖】—— 仅 worker 侧使用。
 */
import type { Model } from "@earendil-works/pi-ai";
import type { ModelConfigLike } from "../services/ai-service";

/** 默认上下文窗口与最大输出（pi-ai 必填字段，先用保守值） */
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 8_192;

/** 去掉尾部斜杠，避免拼出 //chat/completions 这类双斜杠路径 */
function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

/** ModelConfigLike → pi-ai Model<"openai-completions"> */
export function buildPiModel(cfg: ModelConfigLike): Model<"openai-completions"> {
  if (!cfg.baseUrl) throw new Error("Text model base_url is required");
  if (!cfg.modelName) throw new Error("Text model model_name is required");

  return {
    id: cfg.modelName,
    name: cfg.name,
    api: "openai-completions",
    provider: cfg.provider,
    baseUrl: normalizeBaseUrl(cfg.baseUrl),
    input: ["text"],
    // pi-ai 必填；本项目按用量另算成本，此处填 0
    cost: { input: 0, output: 0 },
    reasoning: false,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
npx vitest run src/lib/server/agent/model-bridge.test.ts
```

Expected: PASS，7 个测试全通过。

若 `cost` 的实际必填字段与 `{ input, output }` 不符，`tsc` 会报错 —— 按 `ModelCost` 类型定义补齐（可能是 `{ input, output, cacheRead, cacheWrite }`）。

- [ ] **Step 5: 类型检查**

```bash
npx tsc --noEmit
```

Expected: 无错误（这一步同时验证 `Model<"openai-completions">` 的字段要求已被满足）。

- [ ] **Step 6: 提交**

```bash
git add src/lib/server/agent/model-bridge.ts src/lib/server/agent/model-bridge.test.ts
git commit -m "feat(agent): 新增 ModelConfig 到 pi-ai Model 的桥接"
```

---

## Task 5: 护栏 guards.ts

**Files:**
- Create: `src/lib/server/agent/guards.ts`
- Test: `src/lib/server/agent/guards.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `src/lib/server/agent/guards.test.ts`：

```ts
/**
 * 护栏单元测试
 * 覆盖：riskLevel 分级阻断、未知工具阻断、连续失败计数
 */
import { describe, expect, it } from "vitest";
import { checkToolAllowed, createFailureTracker } from "./guards";

describe("checkToolAllowed（工具准入）", () => {
  it("read 级工具放行", () => {
    expect(checkToolAllowed("hot.refresh")).toEqual({ allowed: true });
  });

  it("write 级工具放行（产出进工件面板待验收）", () => {
    expect(checkToolAllowed("content.notePack")).toEqual({ allowed: true });
  });

  it("未知工具阻断并给出原因", () => {
    const result = checkToolAllowed("not.exist");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("未注册");
  });

  it("自定义技能（注册表里的）默认按 write 放行", () => {
    expect(checkToolAllowed("my.custom.skill")).toEqual({ allowed: true });
  });
});

describe("createFailureTracker（连续失败计数）", () => {
  it("连续失败达到阈值时置为超限", () => {
    const tracker = createFailureTracker(3);
    expect(tracker.record(false).exceeded).toBe(false);
    expect(tracker.record(false).exceeded).toBe(false);
    expect(tracker.record(false).exceeded).toBe(true);
  });

  it("中途成功一次则计数归零", () => {
    const tracker = createFailureTracker(3);
    tracker.record(false);
    tracker.record(false);
    tracker.record(true);   // 成功
    expect(tracker.count).toBe(0);
    expect(tracker.record(false).exceeded).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
npx vitest run src/lib/server/agent/guards.test.ts
```

Expected: FAIL —— `Failed to resolve import "./guards"`

- [ ] **Step 3: 实现 guards.ts**

创建 `src/lib/server/agent/guards.ts`：

```ts
/**
 * Agent 护栏
 *
 * 1. riskLevel 分级准入（beforeToolCall 钩子的实现依据）
 * 2. 连续工具失败计数（用于触发优雅停止）
 *
 * 【本文件不含 Pi 依赖】
 */
import { findSkillDefinition } from "./skill-catalog";

export interface ToolGuardResult {
  allowed: boolean;
  /** 被阻断时给模型的说明 */
  reason?: string;
}

/**
 * 判断工具是否允许执行。
 *
 * - 目录里的 read / write 级：放行
 * - 目录里的 publish 级：阻断（首期不开放，由人工确认）
 * - 不在目录里的（用户自定义技能）：按 write 放行，由 executeSkill 的 default 分支处理
 */
export function checkToolAllowed(skillKey: string): ToolGuardResult {
  const definition = findSkillDefinition(skillKey);
  if (!definition) {
    // 自定义技能：注册表里存在则由 executeSkill 处理，不在此阻断
    return { allowed: true };
  }
  if (definition.riskLevel === "publish") {
    return {
      allowed: false,
      reason: `工具「${definition.name}」属于发布类操作，需人工确认后才能执行，当前版本未开放。`,
    };
  }
  return { allowed: true };
}

export interface FailureRecord {
  /** 当前连续失败次数 */
  count: number;
  /** 是否已达到阈值 */
  exceeded: boolean;
}

export interface FailureTracker {
  record(succeeded: boolean): FailureRecord;
  readonly count: number;
}

/** 连续失败计数器：成功一次即归零 */
export function createFailureTracker(maxFailures: number): FailureTracker {
  let count = 0;
  return {
    record(succeeded: boolean): FailureRecord {
      count = succeeded ? 0 : count + 1;
      return { count, exceeded: count >= maxFailures };
    },
    get count(): number {
      return count;
    },
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
npx vitest run src/lib/server/agent/guards.test.ts
```

Expected: PASS，6 个测试全通过。

- [ ] **Step 5: 提交**

```bash
git add src/lib/server/agent/guards.ts src/lib/server/agent/guards.test.ts
git commit -m "feat(agent): 新增 riskLevel 工具准入护栏与连续失败计数"
```

---

## Task 6: 上下文裁剪与工具结果摘要

**Files:**
- Create: `src/lib/server/agent/context.ts`
- Test: `src/lib/server/agent/context.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `src/lib/server/agent/context.test.ts`：

```ts
/**
 * 上下文装配单元测试
 * 覆盖：字符预算裁剪、system 不裁、工具调用与结果配对不拆散、工具结果摘要
 */
import { describe, expect, it } from "vitest";
import { estimateChars, pruneByCharBudget, summarizeToolResult } from "./context";

/** 造一条 user 消息 */
function userMsg(text: string) {
  return { role: "user", content: [{ type: "text", text }], timestamp: 0 } as never;
}

/** 造一条 assistant 消息（带一个 toolCall） */
function assistantWithToolCall(id: string, toolName: string) {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name: toolName, arguments: {} }],
    timestamp: 0,
  } as never;
}

/** 造一条 toolResult 消息 */
function toolResult(id: string, text: string) {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: "x",
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 0,
  } as never;
}

/** 造一条 system 消息 */
function systemMsg(text: string) {
  return { role: "system", content: text, timestamp: 0 } as never;
}

describe("estimateChars（字符数估算）", () => {
  it("数字符串内容长度", () => {
    expect(estimateChars(userMsg("abcd"))).toBeGreaterThanOrEqual(4);
  });

  it("空消息返回 0 附近的小值", () => {
    expect(estimateChars(systemMsg(""))).toBeLessThan(10);
  });
});

describe("pruneByCharBudget（按字符预算裁剪）", () => {
  it("预算充足时原样返回", () => {
    const messages = [systemMsg("系统"), userMsg("你好")];
    expect(pruneByCharBudget(messages, 10_000)).toHaveLength(2);
  });

  it("预算不足时丢弃最老的消息", () => {
    const messages = [
      systemMsg("系统"),
      userMsg("A".repeat(500)),
      userMsg("B".repeat(500)),
      userMsg("最新的消息"),
    ];
    const result = pruneByCharBudget(messages, 600);
    expect(result.length).toBeLessThan(messages.length);
    expect(JSON.stringify(result)).toContain("最新的消息");
  });

  it("system 消息永不被裁剪", () => {
    const messages = [systemMsg("系统提示必须保留"), userMsg("A".repeat(5000))];
    const result = pruneByCharBudget(messages, 10);
    expect(result.some((m) => (m as { role: string }).role === "system")).toBe(true);
  });

  it("不留下孤立的 toolResult（其 assistant 已被裁掉时一并裁掉）", () => {
    const messages = [
      systemMsg("系统"),
      assistantWithToolCall("call-1", "topic.generate"),
      toolResult("call-1", "A".repeat(2000)),
      userMsg("新问题"),
    ];
    const result = pruneByCharBudget(messages, 400);
    const hasOrphan = result.some((m) => (m as { role: string }).role === "toolResult");
    expect(hasOrphan).toBe(false);
  });

  it("保留 assistant 工具调用时其 toolResult 也保留", () => {
    const messages = [
      systemMsg("系统"),
      assistantWithToolCall("call-1", "topic.generate"),
      toolResult("call-1", "结果内容"),
    ];
    const result = pruneByCharBudget(messages, 10_000);
    expect(result).toHaveLength(3);
  });
});

describe("summarizeToolResult（工具结果摘要）", () => {
  it("列表超过上限时截断并保留总数", () => {
    const items = Array.from({ length: 50 }, (_, i) => ({ id: i, title: `笔记${i}` }));
    const summary = summarizeToolResult({ items }) as { items: unknown[]; total: number; truncated: boolean };
    expect(summary.items).toHaveLength(10);
    expect(summary.total).toBe(50);
    expect(summary.truncated).toBe(true);
  });

  it("列表未超上限时不截断", () => {
    const summary = summarizeToolResult({ items: [{ id: 1 }] }) as { total: number; truncated: boolean };
    expect(summary.total).toBe(1);
    expect(summary.truncated).toBe(false);
  });

  it("非列表结果原样返回", () => {
    expect(summarizeToolResult({ draft_id: 12 })).toEqual({ draft_id: 12 });
  });

  it("支持自定义上限", () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ id: i }));
    const summary = summarizeToolResult({ items }, 3) as { items: unknown[] };
    expect(summary.items).toHaveLength(3);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
npx vitest run src/lib/server/agent/context.test.ts
```

Expected: FAIL —— `Failed to resolve import "./context"`

- [ ] **Step 3: 实现 context.ts**

创建 `src/lib/server/agent/context.ts`：

```ts
/**
 * Agent 上下文装配
 *
 * 1. 按字符预算裁剪历史（本项目用「字符数 / 2」估算 token，不引 tokenizer 依赖）
 * 2. 工具结果摘要（防大结果撑爆上下文窗口）
 *
 * 硬约束：
 *   - system 消息永不裁剪
 *   - 不产生孤立的 toolResult（其配对的 assistant 工具调用被裁掉时必须一并裁掉）
 *
 * 【本文件不含 Pi 依赖】—— 用结构化最小接口，不 import pi 类型。
 */

/** 最小消息形状（兼容 pi 的 AgentMessage，但不依赖其类型） */
interface MinimalMessage {
  role?: string;
  content?: unknown;
  toolCallId?: string;
}

/** 默认工具结果列表保留条数 */
const DEFAULT_LIST_LIMIT = 10;

/** 估算单条消息的字符数 */
export function estimateChars(message: unknown): number {
  const target = message as MinimalMessage;
  const content = target?.content;
  if (typeof content === "string") return content.length;
  if (Array.isArray(content)) {
    let total = 0;
    for (const block of content) {
      const item = block as { text?: string; type?: string };
      if (typeof item?.text === "string") total += item.text.length;
    }
    return total;
  }
  return 0;
}

/** 消息是否携带工具调用（assistant 消息的 content 里有 type="toolCall" 块） */
function hasToolCall(message: unknown): boolean {
  const content = (message as MinimalMessage)?.content;
  if (!Array.isArray(content)) return false;
  return content.some((block) => (block as { type?: string })?.type === "toolCall");
}

/** 消息是否是工具结果 */
function isToolResult(message: unknown): boolean {
  return (message as MinimalMessage)?.role === "toolResult";
}

/**
 * 按字符预算从尾部保留消息。
 *
 * 算法：从最新往前累加字符数，超预算即停止；
 * 然后修正切点 —— 若切点处是 toolResult（其 assistant 父消息已被裁掉），
 * 则继续往后推进，直到不再以 toolResult 开头。
 */
export function pruneByCharBudget<T>(messages: T[], charBudget: number): T[] {
  if (messages.length === 0) return messages;

  const systemMessages: T[] = [];
  const conversational: T[] = [];
  for (const message of messages) {
    if ((message as MinimalMessage)?.role === "system") systemMessages.push(message);
    else conversational.push(message);
  }

  const systemChars = systemMessages.reduce((sum, m) => sum + estimateChars(m), 0);
  let budget = charBudget - systemChars;

  let cutIndex = conversational.length;
  let used = 0;
  for (let i = conversational.length - 1; i >= 0; i -= 1) {
    const size = estimateChars(conversational[i]);
    if (used + size > budget) break;
    used += size;
    cutIndex = i;
  }

  // 修正：不能以 toolResult 开头（否则其 assistant 父消息已被裁掉，模型会困惑）
  while (cutIndex < conversational.length && isToolResult(conversational[cutIndex])) {
    cutIndex += 1;
  }

  return [...systemMessages, ...conversational.slice(cutIndex)];
}

/**
 * 工具结果摘要：列表类结果截断到 limit 条，附总数与截断标记。
 * 非列表结果原样返回。
 */
export function summarizeToolResult(
  result: Record<string, unknown>,
  limit = DEFAULT_LIST_LIMIT,
): Record<string, unknown> {
  const listKey = Object.keys(result).find((key) => Array.isArray(result[key]));
  if (!listKey) return result;

  const list = result[listKey] as unknown[];
  if (list.length <= limit) {
    return { ...result, total: list.length, truncated: false };
  }
  return {
    ...result,
    [listKey]: list.slice(0, limit),
    total: list.length,
    truncated: true,
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
npx vitest run src/lib/server/agent/context.test.ts
```

Expected: PASS，12 个测试全通过。

- [ ] **Step 5: 提交**

```bash
git add src/lib/server/agent/context.ts src/lib/server/agent/context.test.ts
git commit -m "feat(agent): 新增字符预算上下文裁剪与工具结果摘要"
```

---

## Task 7: 工具注册表 tool-registry.ts

**Files:**
- Create: `src/lib/server/agent/tool-registry.ts`
- Create: `src/lib/server/agent/types.ts`
- Test: `src/lib/server/agent/tool-registry.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `src/lib/server/agent/tool-registry.test.ts`：

```ts
/**
 * 工具注册表单元测试
 * 覆盖：AgentTool 形状、replay 策略、execute 委托给 executeSkill
 */
import { describe, expect, it, vi } from "vitest";
import { buildAgentTools } from "./tool-registry";
import type { SkillContext } from "./skill-catalog";

const context: SkillContext = {
  userId: 1,
  textClient: {} as never,
  modelConfig: null,
  apiKey: "",
};

describe("buildAgentTools（技能 → AgentTool）", () => {
  it("为 SKILL_CATALOG 每个技能生成一个工具", () => {
    const tools = buildAgentTools(context);
    expect(tools).toHaveLength(6);
  });

  it("工具的 name 等于 skillKey，label 等于技能名", () => {
    const tools = buildAgentTools(context);
    const topicTool = tools.find((tool) => tool.name === "topic.generate");
    expect(topicTool).toBeDefined();
    expect(topicTool?.label).toBe("选题生成");
  });

  it("每个工具都有 description / parameters / execute", () => {
    for (const tool of buildAgentTools(context)) {
      expect(tool.description.length, `${tool.name}.description`).toBeGreaterThan(0);
      expect(tool.parameters, `${tool.name}.parameters`).toBeDefined();
      expect(typeof tool.execute, `${tool.name}.execute`).toBe("function");
    }
  });

  it("read 级工具 replay 为 safe，write 级为 never", () => {
    const tools = buildAgentTools(context);
    expect(tools.find((tool) => tool.name === "hot.refresh")?.replay).toBe("safe");
    expect(tools.find((tool) => tool.name === "content.notePack")?.replay).toBe("never");
  });

  it("execute 返回结构化结果，content 为可读文本", async () => {
    const tools = buildAgentTools({
      ...context,
      textClient: { generateNotePack: vi.fn() } as never,
    });
    const hotTool = tools.find((tool) => tool.name === "hot.refresh");
    // hot.refresh 会因缺少账号而抛错 —— 验证错误能透出即可
    await expect(hotTool!.execute("call-1", {})).rejects.toThrow();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
npx vitest run src/lib/server/agent/tool-registry.test.ts
```

Expected: FAIL —— `Failed to resolve import "./tool-registry"`

- [ ] **Step 3: 实现 types.ts**

创建 `src/lib/server/agent/types.ts`：

```ts
/**
 * Agent 自定义消息类型声明合并
 *
 * Pi 允许应用通过 declaration merging 扩展 AgentMessage 联合类型，
 * 用于携带 UI 专用消息（工件卡片、系统通知）。
 *
 * 【本文件含 Pi 依赖】
 */
import type { ArtifactKind } from "./skill-catalog";

/** 工件卡片：工具产出物在右栏工件面板的展示数据 */
export interface ArtifactMessage {
  role: "artifact";
  // 复用 skill-catalog 的 ArtifactKind，避免同一个联合类型有两处定义而漂移
  kind: ArtifactKind;
  id: number;
  title: string;
  href: string;
  timestamp: number;
}

/** 系统通知：护栏触发、崩溃恢复等非模型产生的提示 */
export interface NotificationMessage {
  role: "notification";
  level: "info" | "warning" | "error";
  text: string;
  timestamp: number;
}

declare module "@earendil-works/pi-agent-core" {
  interface CustomAgentMessages {
    artifact: ArtifactMessage;
    notification: NotificationMessage;
  }
}
```

注意：若 `declare module` 的模块说明符与实际包名不匹配（编译不生效），删除 `declare module` 块，仅保留两个导出接口即可 —— 工件信息可改由 `AgentToolResult.details` 携带，由 `persist.ts` 读取。

- [ ] **Step 4: 实现 tool-registry.ts**

创建 `src/lib/server/agent/tool-registry.ts`：

```ts
/**
 * 技能 → AgentTool 注册表
 *
 * 把 skill-catalog 的 executeSkill 包装成 Pi 的 AgentTool，
 * 让 Agent 循环能通过原生 tool calling 调用现有业务能力。
 *
 * 【本文件含 Pi 依赖】—— 仅 worker 侧使用。
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { executeSkill, findSkillDefinition, SKILL_CATALOG, type SkillContext } from "./skill-catalog";
import { assertSchemasComplete, getToolSchema } from "./tool-schemas";

/** 工具返回值中文本内容的长度上限（超出则截断，避免撑爆上下文） */
const TOOL_TEXT_LIMIT = 20_000;

/** 把技能执行结果序列化为模型可读文本 */
function toModelText(output: Record<string, unknown>): string {
  const text = JSON.stringify(output);
  if (text.length <= TOOL_TEXT_LIMIT) return text;
  return `${text.slice(0, TOOL_TEXT_LIMIT)}…（结果过长已截断，完整内容见工件面板）`;
}

/** 为目录中的每个技能生成 AgentTool */
export function buildAgentTools(context: SkillContext): AgentTool[] {
  assertSchemasComplete();

  return SKILL_CATALOG.map((definition) => ({
    name: definition.skillKey,
    label: definition.name,
    description: definition.description,
    parameters: getToolSchema(definition.skillKey),
    // 写操作不可安全重放（已生成的草稿/图片会产生重复产出）
    replay: definition.riskLevel === "read" ? "safe" : "never",
    execute: async (_toolCallId: string, params: Record<string, unknown>) => {
      const output = await executeSkill(definition.skillKey, params, context);
      return {
        content: [{ type: "text" as const, text: toModelText(output) }],
        details: output,
      };
    },
  }));
}

/** 取单个技能的工具定义（供测试与调试） */
export function findAgentTool(skillKey: string): AgentTool | undefined {
  const definition = findSkillDefinition(skillKey);
  if (!definition) return undefined;
  return buildAgentTools({
    userId: 0,
    textClient: null as never,
    modelConfig: null,
    apiKey: "",
  }).find((tool) => tool.name === skillKey);
}
```

- [ ] **Step 5: 运行测试确认通过**

```bash
npx vitest run src/lib/server/agent/tool-registry.test.ts
```

Expected: PASS，5 个测试全通过。

若 `AgentTool` 的泛型约束导致 `tsc` 报错，按实际类型补泛型参数（如 `AgentTool<typeof schema>`）；若 `parameters` 类型不匹配，`as` 断言到 `TSchema`。

- [ ] **Step 6: 类型检查**

```bash
npx tsc --noEmit
```

Expected: 无错误。

- [ ] **Step 7: 提交**

```bash
git add src/lib/server/agent/tool-registry.ts src/lib/server/agent/tool-registry.test.ts src/lib/server/agent/types.ts
git commit -m "feat(agent): 新增技能到 AgentTool 的注册表与自定义消息类型"
```

---

## Task 8: persist.ts 事件与工具调用落库

**Files:**
- Create: `src/lib/server/agent/persist.ts`
- Test: `src/lib/server/agent/persist.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `src/lib/server/agent/persist.test.ts`：

```ts
/**
 * 事件落库单元测试
 * 覆盖：事件序列化、工件事件抽取、工具调用记录
 */
import { describe, expect, it } from "vitest";
import { extractArtifacts, serializeEventForDb } from "./persist";

describe("serializeEventForDb（事件序列化）", () => {
  it("保留事件类型与关键载荷", () => {
    const serialized = serializeEventForDb({
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "topic.generate",
      result: { suggestion_ids: [1, 2] },
      isError: false,
      durationMs: 1200,
    });
    expect(serialized.type).toBe("tool_execution_end");
    const payload = serialized.payload as Record<string, unknown>;
    expect(payload.toolName).toBe("topic.generate");
    expect(payload.durationMs).toBe(1200);
  });

  it("剔除 message_update 中的完整消息体（体积过大且增量重复）", () => {
    const serialized = serializeEventForDb({
      type: "message_update",
      message: { role: "assistant", content: [{ type: "text", text: "A".repeat(5000) }] },
    });
    const payload = serialized.payload as Record<string, unknown>;
    expect(JSON.stringify(payload).length).toBeLessThan(2000);
  });
});

describe("extractArtifacts（工件抽取）", () => {
  it("topic.generate 的产出被识别为 topic 工件", () => {
    const artifacts = extractArtifacts("topic.generate", {
      suggestion_ids: [11, 12],
      titles: ["露营选题A", "露营选题B"],
    });
    expect(artifacts).toHaveLength(2);
    expect(artifacts[0]).toMatchObject({ kind: "topic", id: 11, title: "露营选题A" });
  });

  it("content.notePack 的产出被识别为 draft 工件并带跳转链接", () => {
    const artifacts = extractArtifacts("content.notePack", {
      draft_id: 128,
      titles: ["标题A"],
    });
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({
      kind: "draft",
      id: 128,
      href: "/platforms/xhs/drafts?id=128",
    });
  });

  it("review.submit 的产出被识别为 review 工件", () => {
    const artifacts = extractArtifacts("review.submit", { review_id: 7, gate_status: "pass" });
    expect(artifacts[0]).toMatchObject({ kind: "review", id: 7 });
  });

  it("无产出的工具返回空数组", () => {
    expect(extractArtifacts("hot.refresh", { collected: 30 })).toEqual([]);
  });

  it("script.generate 无 artifact 声明，返回空数组（返回纯文本无 id 可映射）", () => {
    expect(extractArtifacts("script.generate", { script: "开场钩子…" })).toEqual([]);
  });

  it("未知工具返回空数组", () => {
    expect(extractArtifacts("not.exist", {})).toEqual([]);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
npx vitest run src/lib/server/agent/persist.test.ts
```

Expected: FAIL —— `Failed to resolve import "./persist"`

- [ ] **Step 3: 实现 persist.ts**

创建 `src/lib/server/agent/persist.ts`：

```ts
/**
 * Agent 事件与工具调用落库
 *
 * 【本文件不含 Pi 依赖】—— 用结构化最小接口接收事件，便于离线单测。
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "../core/db";
import { shanghaiNow } from "../core/time";
import { findSkillDefinition, type ArtifactKind } from "./skill-catalog";

/** 体积较大的事件类型：只记录摘要，不记录完整消息体 */
const TRIMMED_EVENT_TYPES = new Set(["message_update", "message_start", "message_end"]);

export interface SerializedEvent {
  type: string;
  payload: Prisma.InputJsonValue;
}

/** 事件 → 可落库的 { type, payload }，大体积事件只留摘要 */
export function serializeEventForDb(event: Record<string, unknown>): SerializedEvent {
  const type = String(event.type ?? "unknown");

  if (TRIMMED_EVENT_TYPES.has(type)) {
    const message = event.message as { role?: string } | undefined;
    return {
      type,
      payload: { role: message?.role ?? "assistant", trimmed: true },
    };
  }

  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event)) {
    if (key === "type") continue;
    payload[key] = value as unknown;
  }
  return { type, payload: payload as Prisma.InputJsonValue };
}

/** 落一条 Agent 事件 */
export async function persistAgentEvent(runId: number, event: Record<string, unknown>): Promise<void> {
  const serialized = serializeEventForDb(event);
  await prisma.agentEvent.create({
    data: {
      runId,
      type: serialized.type,
      payload: serialized.payload,
      createdAt: shanghaiNow(),
    },
  });
}

export interface ArtifactRef {
  kind: ArtifactKind;
  id: number;
  title: string;
  href: string;
}

/**
 * 从工具产出中抽取工件引用（驱动右栏工件面板）
 *
 * 产出物配方来自 catalog 里各技能的 artifact 声明，**不另建映射表** ——
 * 单一真相源，避免两张表失配导致静默返回空工件。
 */
export function extractArtifacts(toolName: string, output: Record<string, unknown>): ArtifactRef[] {
  const definition = findSkillDefinition(toolName);
  const spec = definition?.artifact;
  if (!spec) return [];

  const rawIds = output[spec.idField];
  const titles =
    spec.titleField && Array.isArray(output[spec.titleField]) ? (output[spec.titleField] as string[]) : [];

  // 多产出（如选题批量生成）：idField 是数组，标题按索引对应
  if (Array.isArray(rawIds)) {
    return rawIds
      .map((rawId, index) => {
        const id = Number(rawId);
        if (!id) return null;
        return {
          kind: spec.kind,
          id,
          title: titles[index] ?? `${definition.name} #${id}`,
          href: `${spec.hrefPrefix}${id}`,
        };
      })
      .filter((item): item is ArtifactRef => item !== null);
  }

  // 单产出（如草稿、审校工单）
  const id = Number(rawIds);
  if (!id) return [];
  return [
    {
      kind: spec.kind,
      id,
      title: titles[0] ?? `${definition.name} #${id}`,
      href: `${spec.hrefPrefix}${id}`,
    },
  ];
}

/** 落一条工具调用记录 */
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
      createdAt: shanghaiNow(),
    },
  });
  return created.id;
}

/** 更新工具调用记录（执行结束时回填结果） */
export async function finalizeToolCall(options: {
  id: number;
  result: Record<string, unknown> | null;
  status: "succeeded" | "failed";
  errorType?: string | null;
  durationMs?: number | null;
}): Promise<void> {
  await prisma.agentToolCall.update({
    where: { id: options.id },
    data: {
      result: (options.result ?? undefined) as Prisma.InputJsonValue | undefined,
      status: options.status,
      errorType: options.errorType ?? null,
      durationMs: options.durationMs ?? null,
    },
  });
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
npx vitest run src/lib/server/agent/persist.test.ts
```

Expected: PASS，8 个测试全通过。

- [ ] **Step 5: 提交**

```bash
git add src/lib/server/agent/persist.ts src/lib/server/agent/persist.test.ts
git commit -m "feat(agent): 新增事件与工具调用落库、工件抽取"
```

---

## Task 9: agent-service.ts 会话与 Run 管理

**Files:**
- Create: `src/lib/server/services/agent-service.ts`
- Test: `src/lib/server/services/agent-service.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `src/lib/server/services/agent-service.test.ts`：

```ts
/**
 * Agent 会话服务单元测试
 * 覆盖：默认值、状态判定等纯逻辑（DB 交互部分由 Task 12 端到端覆盖）
 */
import { describe, expect, it } from "vitest";
import { buildRunDefaults, isRunTerminal, deriveConversationTitle } from "./agent-service";

describe("buildRunDefaults（Run 默认值）", () => {
  it("返回默认护栏阈值", () => {
    const defaults = buildRunDefaults();
    expect(defaults.maxSteps).toBeGreaterThan(0);
    expect(defaults.tokenBudget).toBeGreaterThan(0);
    expect(defaults.status).toBe("pending");
    expect(defaults.stepCount).toBe(0);
    expect(defaults.tokensUsed).toBe(0);
  });

  it("环境变量可覆盖默认值", () => {
    const defaults = buildRunDefaults({ AGENT_MAX_STEPS: "30", AGENT_TOKEN_BUDGET: "50000" });
    expect(defaults.maxSteps).toBe(30);
    expect(defaults.tokenBudget).toBe(50000);
  });

  it("非法环境变量回退到默认值", () => {
    const defaults = buildRunDefaults({ AGENT_MAX_STEPS: "abc" });
    expect(defaults.maxSteps).toBe(20);
  });
});

describe("isRunTerminal（终态判定）", () => {
  it("succeeded / failed / cancelled 是终态", () => {
    expect(isRunTerminal("succeeded")).toBe(true);
    expect(isRunTerminal("failed")).toBe(true);
    expect(isRunTerminal("cancelled")).toBe(true);
  });

  it("pending / running 不是终态", () => {
    expect(isRunTerminal("pending")).toBe(false);
    expect(isRunTerminal("running")).toBe(false);
  });
});

describe("deriveConversationTitle（会话标题）", () => {
  it("取首条用户消息前 20 字", () => {
    expect(deriveConversationTitle("帮我生成三篇露营主题的小红书笔记")).toBe("帮我生成三篇露营主题的小红书笔记");
  });

  it("超长标题截断并加省略号", () => {
    const long = "帮我生成三篇露营主题的小红书笔记，要求口语化、有信息密度、带话题标签";
    const title = deriveConversationTitle(long);
    expect(title.length).toBeLessThanOrEqual(21);
    expect(title.endsWith("…")).toBe(true);
  });

  it("空输入返回默认标题", () => {
    expect(deriveConversationTitle("")).toBe("新任务");
    expect(deriveConversationTitle("   ")).toBe("新任务");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
npx vitest run src/lib/server/services/agent-service.test.ts
```

Expected: FAIL —— `Failed to resolve import "./agent-service"`

- [ ] **Step 3: 实现 agent-service.ts**

创建 `src/lib/server/services/agent-service.ts`：

```ts
/**
 * Agent 会话服务
 *
 * 会话 / 消息 / Run 的持久化操作，以及 worker 侧的任务领取。
 * 【本文件不含 Pi 依赖】—— 可被 Next.js API 路由安全 import。
 */
import type { AgentConversation, AgentRun, Prisma } from "@prisma/client";
import { prisma } from "../core/db";
import { shanghaiNow } from "../core/time";

/** 会话标题最大长度 */
const TITLE_MAX_LENGTH = 20;

export interface RunDefaults {
  status: string;
  stepCount: number;
  tokensUsed: number;
  maxSteps: number;
  tokenBudget: number;
}

/** 从环境变量读整数，非法或缺失时用默认值 */
function readInt(env: Record<string, string | undefined>, key: string, fallback: number): number {
  const parsed = Number(env[key]);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** Run 默认值（护栏阈值可由环境变量覆盖） */
export function buildRunDefaults(env: Record<string, string | undefined> = process.env): RunDefaults {
  return {
    status: "pending",
    stepCount: 0,
    tokensUsed: 0,
    maxSteps: readInt(env, "AGENT_MAX_STEPS", 20),
    tokenBudget: readInt(env, "AGENT_TOKEN_BUDGET", 200_000),
  };
}

/** Run 是否已处于终态 */
export function isRunTerminal(status: string): boolean {
  return ["succeeded", "failed", "cancelled"].includes(status);
}

/** 由首条用户消息派生会话标题 */
export function deriveConversationTitle(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "新任务";
  if (trimmed.length <= TITLE_MAX_LENGTH) return trimmed;
  return `${trimmed.slice(0, TITLE_MAX_LENGTH)}…`;
}

/** 新建会话 */
export async function createConversation(userId: number, title = "新任务"): Promise<AgentConversation> {
  return prisma.agentConversation.create({
    data: { userId, title, status: "idle", createdAt: shanghaiNow() },
  });
}

/** 列出用户会话（按更新时间倒序） */
export async function listConversations(userId: number): Promise<AgentConversation[]> {
  return prisma.agentConversation.findMany({
    where: { userId, status: { not: "archived" } },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
  });
}

/** 追加一条消息 */
export async function appendMessage(options: {
  conversationId: number;
  role: "user" | "assistant" | "tool";
  content: string;
  runId?: number | null;
  toolCalls?: Prisma.InputJsonValue;
  toolCallId?: string | null;
}): Promise<{ id: number }> {
  const message = await prisma.agentMessage.create({
    data: {
      conversationId: options.conversationId,
      role: options.role,
      content: options.content,
      runId: options.runId ?? null,
      toolCalls: options.toolCalls,
      toolCallId: options.toolCallId ?? null,
      createdAt: shanghaiNow(),
    },
  });
  return { id: message.id };
}

/**
 * 用户发消息 → 建 Run。
 * 同时复用 Task 表（taskType="agent_run"），让任务中心能展示 Agent 任务。
 */
export async function createRunForMessage(options: {
  conversationId: number;
  userId: number;
  messageId: number;
  env?: Record<string, string | undefined>;
}): Promise<AgentRun> {
  const defaults = buildRunDefaults(options.env);
  const task = await prisma.task.create({
    data: {
      userId: options.userId,
      platform: "xhs",
      taskType: "agent_run",
      status: "pending",
      progress: 0,
      payload: { conversation_id: options.conversationId } as Prisma.InputJsonValue,
      createdAt: shanghaiNow(),
    },
  });
  return prisma.agentRun.create({
    data: {
      conversationId: options.conversationId,
      userId: options.userId,
      taskId: task.id,
      triggerMessageId: options.messageId,
      status: defaults.status,
      stepCount: defaults.stepCount,
      tokensUsed: defaults.tokensUsed,
      maxSteps: defaults.maxSteps,
      tokenBudget: defaults.tokenBudget,
      createdAt: shanghaiNow(),
    },
  });
}

/**
 * worker 侧：原子领取待执行的 Run。
 * 用 FOR UPDATE SKIP LOCKED 避免并发重复领取。
 */
export async function claimPendingRuns(limit: number): Promise<AgentRun[]> {
  const rows = await prisma.$queryRaw<Array<{ id: number }>>`
    UPDATE agent_runs
    SET status = 'running', started_at = now()
    WHERE id IN (
      SELECT id FROM agent_runs
      WHERE status = 'pending'
      ORDER BY id
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id
  `;
  if (rows.length === 0) return [];
  return prisma.agentRun.findMany({
    where: { id: { in: rows.map((row) => row.id) } },
    orderBy: { id: "asc" },
  });
}

/** 标记 Run 结束 */
export async function finishRun(options: {
  runId: number;
  status: "succeeded" | "failed" | "cancelled";
  errorType?: string | null;
  stepCount?: number;
  tokensUsed?: number;
}): Promise<void> {
  const run = await prisma.agentRun.update({
    where: { id: options.runId },
    data: {
      status: options.status,
      errorType: options.errorType ?? null,
      stepCount: options.stepCount,
      tokensUsed: options.tokensUsed,
      finishedAt: shanghaiNow(),
    },
  });
  // 同步 Task 状态，让任务中心显示一致
  await prisma.task.update({
    where: { id: run.taskId },
    data: {
      status: options.status === "succeeded" ? "completed" : "failed",
      progress: options.status === "succeeded" ? 100 : 0,
      finishedAt: shanghaiNow(),
    },
  });
}

/**
 * worker 启动时的崩溃清扫：
 * 把卡在 running 且超过阈值的 Run 标记为失败（不自动重跑，避免重复产出）。
 */
export async function sweepStuckRuns(thresholdMinutes: number): Promise<number> {
  const cutoff = new Date(Date.now() - thresholdMinutes * 60 * 1000);
  const result = await prisma.agentRun.updateMany({
    where: { status: "running", startedAt: { lt: cutoff } },
    data: {
      status: "failed",
      errorType: "worker_restart",
      finishedAt: shanghaiNow(),
    },
  });
  return result.count;
}

/** 取会话消息（供循环组装上下文） */
export async function listMessages(conversationId: number, limit = 100): Promise<Array<{ role: string; content: string; toolCallId: string | null }>> {
  const messages = await prisma.agentMessage.findMany({
    where: { conversationId },
    orderBy: { id: "asc" },
    take: limit,
  });
  return messages.map((message) => ({
    role: message.role,
    content: message.content,
    toolCallId: message.toolCallId,
  }));
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
npx vitest run src/lib/server/services/agent-service.test.ts
```

Expected: PASS，9 个测试全通过。

- [ ] **Step 5: 提交**

```bash
git add src/lib/server/services/agent-service.ts src/lib/server/services/agent-service.test.ts
git commit -m "feat(agent): 新增会话/Run 管理服务与原子任务领取"
```

---

## Task 10: agent.md 提示词与 agent-loop.ts 循环装配

**Files:**
- Create: `src/prompts/agent.md`
- Create: `src/lib/server/agent/agent-loop.ts`
- Test: `src/lib/server/agent/agent-loop.test.ts`

- [ ] **Step 1: 创建 agent.md 提示词**

创建 `src/prompts/agent.md`：

```markdown
<!-- prompt:system -->
你是 xhs-assistant 平台的运营 Agent，帮助用户完成小红书内容运营任务。

## 工作方式

1. **先预告再动手**：每次调用工具前，先用一句话说明你要做什么，让用户看得懂你的思路。
2. **先查再产**：需要参考数据时，先用检索类工具了解现状（热点、内容库、知识库），再生成内容。
3. **一步一个工具**：按顺序调用工具，观察结果后再决定下一步。工具失败时读错误信息，判断是重试、换参数还是换方案。
4. **产出即交付**：生成的草稿、选题、图片会自动进入右侧工件面板，用户可点击跳转精修。

## 可用工具

{{toolCatalog}}

## 边界

- 只做内容生产与数据检索。发布类操作不开放，如用户要求发布，说明需人工在发布中心操作。
- 不要编造数据。需要数据时调用工具获取；工具返回为空就如实说明。
- 任务完成后简要总结做了什么、产出了什么（附 ID）。
<!-- /prompt:system -->
```

- [ ] **Step 2: 写失败测试**

创建 `src/lib/server/agent/agent-loop.test.ts`：

```ts
/**
 * Agent 循环集成测试（离线）
 *
 * 关键：注入假 streamFn，完全不调真实 LLM，不烧 token。
 * 验证「思考 → 调工具 → 看结果 → 收尾」全流程与事件序列。
 */
import { describe, expect, it, vi } from "vitest";
import { buildToolCatalogText, runAgentLoop } from "./agent-loop";

describe("buildToolCatalogText（工具目录文本）", () => {
  it("列出全部 6 个技能的 skillKey 与描述", () => {
    const text = buildToolCatalogText();
    expect(text).toContain("topic.generate");
    expect(text).toContain("content.notePack");
    expect(text).toContain("选题生成");
  });
});

describe("runAgentLoop（循环编排）", () => {
  it("事件按顺序落库，agent_start 在最前、agent_end 在最后", async () => {
    const events: string[] = [];
    const persistEvent = vi.fn(async (_runId: number, event: Record<string, unknown>) => {
      events.push(String(event.type));
      return "1200";
    });

    await runAgentLoop({
      runId: 1,
      conversationId: 1,
      userId: 1,
      userMessage: "你好",
      fakeStreamFn: createFakeStreamFn(["你好，我是运营助手。"]),
      persistEvent,
      model: {} as never,
      tools: [],
      systemPrompt: "系统提示",
    });

    expect(events[0]).toBe("agent_start");
    expect(events[events.length - 1]).toBe("agent_end");
  });

  it("模型不调用工具时直接收尾，产出助手消息", async () => {
    const persisted: Array<Record<string, unknown>> = [];
    const persistMessage = vi.fn(async (message: Record<string, unknown>) => {
      persisted.push(message);
    });

    const result = await runAgentLoop({
      runId: 1,
      conversationId: 1,
      userId: 1,
      userMessage: "你好",
      fakeStreamFn: createFakeStreamFn(["你好，我是运营助手。"]),
      persistEvent: async () => "1",
      persistMessage,
      model: {} as never,
      tools: [],
      systemPrompt: "系统提示",
    });

    expect(result.status).toBe("succeeded");
    expect(persisted.some((message) => message.role === "assistant")).toBe(true);
  });
});
```

同时在该测试文件顶部加入假 streamFn 的构造辅助（放在 `describe` 之前）：

```ts
/**
 * 构造一个假的 streamFn：按脚本依次返回助手回复，不发起任何网络请求。
 * 每轮取一个文本；用完则返回空回复以结束循环。
 */
function createFakeStreamFn(scriptedTexts: string[]) {
  let turn = 0;
  return (() => {
    const text = scriptedTexts[turn] ?? "";
    turn += 1;
    return createFakeStream(text);
  }) as never;
}

/** 把一段文本包装成 pi 期望的 AssistantMessageEventStream */
function createFakeStream(text: string) {
  const message = {
    role: "assistant",
    content: text ? [{ type: "text", text }] : [],
    stopReason: "stop",
    timestamp: 0,
  };
  const events = [
    { type: "start" },
    { type: "text_start", contentIndex: 0 },
    { type: "text_delta", contentIndex: 0, delta: text },
    { type: "text_end", contentIndex: 0 },
    { type: "done", message },
  ];
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
    },
    result: async () => message,
  };
}
```

- [ ] **Step 3: 运行测试确认失败**

```bash
npx vitest run src/lib/server/agent/agent-loop.test.ts
```

Expected: FAIL —— `Failed to resolve import "./agent-loop"`

- [ ] **Step 4: 实现 agent-loop.ts**

创建 `src/lib/server/agent/agent-loop.ts`：

```ts
/**
 * Agent 循环装配与驱动
 *
 * 用 Pi 的 Agent 跑 ReAct 循环，所有可观测动作经钩子落库。
 *
 * 【本文件含 Pi 依赖】—— 仅 worker 侧使用，Next.js 侧禁止 import。
 */
import { Agent, type AgentTool, type StreamFn } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { renderPrompt } from "../../prompts/loader";
import { pruneByCharBudget } from "./context";
import { checkToolAllowed, createFailureTracker } from "./guards";
import { SKILL_CATALOG } from "./skill-catalog";
import { extractArtifacts } from "./persist";

/** 默认字符预算（约 100k token，按字符数/2 估算） */
const DEFAULT_CHAR_BUDGET = 200_000;

/** 默认连续工具失败阈值 */
const DEFAULT_MAX_TOOL_FAILURES = 3;

/** 默认单次运行墙钟超时（毫秒） */
const DEFAULT_RUN_TIMEOUT_MS = 600_000;

/** 渲染给模型的工具目录文本 */
export function buildToolCatalogText(): string {
  return SKILL_CATALOG.map(
    (definition) =>
      `- **${definition.skillKey}**（${definition.name}）${definition.riskLevel === "read" ? "［只读］" : "［会产生内容］"}\n  ${definition.description}`,
  ).join("\n");
}

export interface RunAgentLoopOptions {
  runId: number;
  conversationId: number;
  userId: number;
  userMessage: string;
  model: Model<"openai-completions">;
  tools: AgentTool[];
  apiKey?: string;
  systemPrompt?: string;
  /** 注入假 streamFn 供离线测试；不传则用 pi-ai 的真实实现 */
  fakeStreamFn?: StreamFn;
  persistEvent: (runId: number, event: Record<string, unknown>) => Promise<string>;
  persistMessage?: (message: { role: string; content: string }) => Promise<void>;
  charBudget?: number;
  maxToolFailures?: number;
  runTimeoutMs?: number;
}

export interface RunAgentLoopResult {
  status: "succeeded" | "failed";
  errorType?: string;
}

/**
 * 跑一次完整的 ReAct 循环。
 *
 * 所有事件经 persistEvent 落库；工具调用与工件经 afterToolCall 钩子处理。
 */
export async function runAgentLoop(options: RunAgentLoopOptions): Promise<RunAgentLoopResult> {
  const { runId, userMessage, model, tools, apiKey, persistEvent, persistMessage } = options;
  const charBudget = options.charBudget ?? DEFAULT_CHAR_BUDGET;
  const maxToolFailures = options.maxToolFailures ?? DEFAULT_MAX_TOOL_FAILURES;
  const runTimeoutMs = options.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
  const failureTracker = createFailureTracker(maxToolFailures);

  const systemPrompt =
    options.systemPrompt ?? renderPrompt("agent.md", "system", { toolCatalog: buildToolCatalogText() });

  const agent = new Agent({
    streamFn: (options.fakeStreamFn ?? streamSimple) as never,
    getApiKey: async () => apiKey,
    initialState: {
      model,
      tools,
      systemPrompt,
    },
    // 上下文预算：字符数估算裁剪
    transformContext: async (messages: never[]) => pruneByCharBudget(messages, charBudget) as never,
    // 护栏：阻断 publish 级与未注册工具
    beforeToolCall: async ({ toolCall }: { toolCall: { name: string } }) => {
      const verdict = checkToolAllowed(toolCall.name);
      if (!verdict.allowed) {
        return { block: true, reason: verdict.reason };
      }
      return undefined;
    },
    toolExecution: "sequential",
    sessionId: `conv-${options.conversationId}`,
  });

  // 事件 → 落库
  agent.subscribe(async (event: unknown) => {
    const record = event as Record<string, unknown>;
    await persistEvent(runId, record);

    // 工具执行结束 → 抽取工件并落 artifact 事件；同时累计连续失败
    if (record.type === "tool_execution_end") {
      const toolName = String(record.toolName ?? "");
      const isError = Boolean(record.isError);
      const failure = failureTracker.record(!isError);
      if (failure.exceeded) {
        await persistEvent(runId, {
          type: "status",
          level: "error",
          message: `连续 ${failure.count} 次工具调用失败，已停止执行`,
        });
        agent.abort();
        return;
      }
      const result = record.result as { details?: Record<string, unknown> } | undefined;
      const artifacts = extractArtifacts(toolName, result?.details ?? {});
      for (const artifact of artifacts) {
        await persistEvent(runId, { type: "artifact", ...artifact });
      }
    }
  });

  // 墙钟超时：到点中止循环（已产出的工件仍然有效）
  const timeoutTimer = setTimeout(() => {
    void persistEvent(runId, {
      type: "status",
      level: "warning",
      message: `执行超过 ${Math.round(runTimeoutMs / 60_000)} 分钟，已中止`,
    });
    agent.abort();
  }, runTimeoutMs);

  try {
    await agent.prompt(userMessage);
    await agent.waitForIdle();

    if (persistMessage) {
      const last = agent.state.messages[agent.state.messages.length - 1] as
        | { role?: string; content?: Array<{ type?: string; text?: string }> }
        | undefined;
      const text = (last?.content ?? [])
        .filter((block) => block.type === "text" && typeof block.text === "string")
        .map((block) => block.text as string)
        .join("");
      if (text) await persistMessage({ role: "assistant", content: text });
    }

    return { status: "succeeded" };
  } catch (error) {
    await persistEvent(runId, {
      type: "error",
      message: (error as Error).message,
    });
    return { status: "failed", errorType: "loop_error" };
  } finally {
    clearTimeout(timeoutTimer);
  }
}
```

- [ ] **Step 5: 运行测试确认通过**

```bash
npx vitest run src/lib/server/agent/agent-loop.test.ts
```

Expected: PASS，3 个测试全通过。

**若假 streamFn 与 pi-ai 的流协议不匹配**（`createFakeStream` 的事件形状不对导致循环报错），按 `AssistantMessageEvent` 的实际类型定义调整 `events` 数组。这一步是 P0 的关键验证点 —— 假 streamFn 跑通，说明循环可离线测试。

- [ ] **Step 6: 提交**

```bash
git add src/prompts/agent.md src/lib/server/agent/agent-loop.ts src/lib/server/agent/agent-loop.test.ts
git commit -m "feat(agent): 新增 Agent 系统提示词与循环装配，支持注入假 streamFn 离线测试"
```

---

## Task 11: worker 接入 agent_run_runner 与崩溃清扫

**Files:**
- Modify: `src/worker/index.ts`

- [ ] **Step 1: 加入 runAgentRunOnce 实现**

在 `src/worker/index.ts` 的 import 区追加：

```ts
import { claimPendingRuns, finishRun, sweepStuckRuns } from "../lib/server/services/agent-service";
import { buildAgentTools } from "../lib/server/agent/tool-registry";
import { buildPiModel } from "../lib/server/agent/model-bridge";
import { runAgentLoop } from "../lib/server/agent/agent-loop";
import { persistAgentEvent } from "../lib/server/agent/persist";
import { prisma } from "../lib/server/core/db";
import { decryptText } from "../lib/server/core/security";
import { shanghaiNow } from "../lib/server/core/time";
```

在 `cookieHealthChecker` 函数之后加入：

```ts
/** Agent 并发上限 */
const AGENT_MAX_CONCURRENCY = Math.max(1, Number(process.env.AGENT_MAX_CONCURRENCY) || 3);

/** 卡死 Run 的判定阈值（分钟） */
const AGENT_STUCK_THRESHOLD_MINUTES = Math.max(1, Number(process.env.AGENT_STUCK_THRESHOLD_MINUTES) || 15);

/** 连续工具失败阈值 */
const AGENT_MAX_TOOL_FAILURES = Math.max(1, Number(process.env.AGENT_MAX_TOOL_FAILURES) || 3);

/** 单次运行墙钟超时（毫秒） */
const AGENT_RUN_TIMEOUT_MS = Math.max(10_000, Number(process.env.AGENT_RUN_TIMEOUT_MS) || 600_000);

/**
 * 取用户的完整文本模型配置。
 * 注意：getTextModelForUser 返回的是裁剪过的字段集（缺 provider），
 * 而 buildPiModel 需要完整的 ModelConfigLike，因此这里直接查全表。
 */
async function getFullTextModelForUser(userId: number): Promise<[{ id: number; userId: number; name: string; modelType: string; provider: string; modelName: string; baseUrl: string; encryptedApiKey: string; isDefault: boolean } | null, string]> {
  const config = await prisma.modelConfig.findFirst({
    where: { userId, modelType: "text", isDefault: true },
  });
  if (!config || !config.encryptedApiKey) return [null, ""];
  return [config, decryptText(config.encryptedApiKey)];
}

/** 跑单个 Agent Run 的完整流程 */
async function executeAgentRun(run: {
  id: number;
  userId: number;
  conversationId: number;
  taskId: number;
  maxSteps: number;
  tokenBudget: number;
}): Promise<void> {
  const [modelConfig, apiKey] = await getFullTextModelForUser(run.userId);
  if (!modelConfig || !apiKey) {
    await persistAgentEvent(run.id, { type: "error", message: "未配置默认文本模型，无法执行" });
    await finishRun({ runId: run.id, status: "failed", errorType: "no_model_config" });
    return;
  }

  const conversation = await prisma.agentConversation.findUnique({ where: { id: run.conversationId } });
  const triggerMessage = await prisma.agentMessage.findFirst({
    where: { conversationId: run.conversationId, role: "user" },
    orderBy: { id: "desc" },
  });
  if (!triggerMessage) {
    await persistAgentEvent(run.id, { type: "error", message: "会话中没有用户消息" });
    await finishRun({ runId: run.id, status: "failed", errorType: "no_user_message" });
    return;
  }

  let stepCount = 0;

  const result = await runAgentLoop({
    runId: run.id,
    conversationId: run.conversationId,
    userId: run.userId,
    userMessage: triggerMessage.content,
    model: buildPiModel(modelConfig),
    apiKey,
    tools: buildAgentTools({
      userId: run.userId,
      textClient: new OpenAICompatibleTextClient(),
      modelConfig,
      apiKey,
    }),
    maxToolFailures: AGENT_MAX_TOOL_FAILURES,
    runTimeoutMs: AGENT_RUN_TIMEOUT_MS,
    persistEvent: async (runId, event) => {
      await persistAgentEvent(runId, event);
      if (event.type === "turn_end") stepCount += 1;
      const latest = await prisma.agentEvent.findFirst({ where: { runId }, orderBy: { id: "desc" } });
      return String(latest?.id ?? "0");
    },
    persistMessage: async (message) => {
      await prisma.agentMessage.create({
        data: {
          conversationId: run.conversationId,
          runId: run.id,
          role: message.role,
          content: message.content,
          // createdAt 无库级默认值，必须显式传（全库一致约定）
          createdAt: shanghaiNow(),
        },
      });
    },
  });

  await finishRun({
    runId: run.id,
    status: result.status,
    errorType: result.errorType ?? null,
    stepCount,
  });

  // 会话回到 idle；若标题仍是默认值则按首条用户消息派生
  await prisma.agentConversation.update({
    where: { id: run.conversationId },
    data: {
      status: "idle",
      title: conversation?.title === "新任务" ? triggerMessage.content.slice(0, 20) : conversation?.title,
    },
  });
}

/** Agent Run 执行器：领取待执行任务并并发跑 */
async function agentRunRunner(): Promise<void> {
  const runs = await claimPendingRuns(AGENT_MAX_CONCURRENCY);
  if (runs.length === 0) return;
  console.log(`[worker] agent 领取到 ${runs.length} 个待执行 Run`);
  await Promise.allSettled(runs.map((run) => executeAgentRun(run)));
}

/** 启动时清扫卡死的 Run */
async function sweepAgentRuns(): Promise<void> {
  const count = await sweepStuckRuns(AGENT_STUCK_THRESHOLD_MINUTES);
  if (count > 0) console.log(`[worker] 清扫了 ${count} 个卡死的 Agent Run`);
}
```

- [ ] **Step 2: 注册到调度**

在 `main()` 中，`comment_reply_runner` 那行之后追加：

```ts
  const agentPollSeconds = Math.max(1, Math.min(Number(process.env.AGENT_POLL_INTERVAL_SECONDS) || 3, 59));
  schedule(`*/${agentPollSeconds} * * * * *`, "agent_run_runner", agentRunMutex, agentRunRunner);
```

在 `const commentReplyMutex = new Mutex();` 之后追加：

```ts
const agentRunMutex = new Mutex();
```

在 `main()` 的 `console.log("[worker] 启动完成...")` 之前追加：

```ts
  void sweepAgentRuns();
```

- [ ] **Step 3: 类型检查与构建验证**

```bash
cd F:/project/code/xhs-assistant
npx tsc --noEmit
```

Expected: 无错误。

若报 `executeAgentRun` 的参数类型与 `claimPendingRuns` 返回类型不匹配，把参数类型改为直接用 `AgentRun`：

```ts
import type { AgentRun } from "@prisma/client";
async function executeAgentRun(run: AgentRun): Promise<void> {
```

- [ ] **Step 4: 确认 Next.js 侧未引入 Pi**

```bash
grep -rn "@earendil-works/pi" src/app/ src/lib/api.ts src/lib/server/services/ src/components/ && echo "❌ 违规：Next.js 侧引入了 Pi" || echo "✅ 通过：Pi 仅在 worker 相关模块"
```

Expected: `✅ 通过：Pi 仅在 worker 相关模块`

如果 grep 有输出，说明违反了架构铁律，必须把该 import 移到 worker 侧。

- [ ] **Step 5: 启动 worker 验证加载**

```bash
npx tsx src/worker/index.ts
```

Expected: 输出包含 `[worker] 已注册任务 agent_run_runner：cron=*/3 * * * * *`，且无模块加载错误。按 Ctrl+C 退出。

- [ ] **Step 6: 提交**

```bash
git add src/worker/index.ts
git commit -m "feat(worker): 接入 agent_run_runner 与启动时崩溃清扫"
```

---

## Task 12: P0 端到端验收

**Files:**
- Create: `src/scripts/agent-smoke.ts`（验收脚本，保留在仓库中作为回归工具）

- [ ] **Step 1: 编写验收脚本**

创建 `src/scripts/agent-smoke.ts`：

```ts
/**
 * Agent P0 端到端验收脚本
 *
 * 用法：
 *   1. 另开终端运行 worker：npx tsx src/worker/index.ts
 *   2. 运行本脚本：npx tsx src/scripts/agent-smoke.ts
 *
 * 验收标准：
 *   - 会话与 Run 被创建
 *   - agent_events 表产生完整事件序列（agent_start → … → agent_end）
 *   - ai_draft 表出现新草稿（证明工具真的被调用并落库）
 */
import { prisma } from "../lib/server/core/db";
import { createConversation, appendMessage, createRunForMessage } from "../lib/server/services/agent-service";

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

async function main(): Promise<void> {
  const user = await prisma.user.findFirst({ orderBy: { id: "asc" } });
  if (!user) throw new Error("数据库里没有用户，请先注册一个账号");
  console.log("使用用户:", user.id);

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
  console.log("等待 worker 执行（最长 5 分钟）...");

  const status = await waitForRun(run.id, 5 * 60 * 1000);
  console.log("Run 最终状态:", status);

  const events = await prisma.agentEvent.findMany({
    where: { runId: run.id },
    orderBy: { id: "asc" },
    select: { type: true },
  });
  console.log("事件序列:", events.map((event) => event.type).join(" → "));

  const draftCountAfter = await prisma.aiDraft.count({ where: { userId: user.id } });
  console.log(`草稿数：${draftCountBefore} → ${draftCountAfter}`);

  await prisma.agentEvent.deleteMany({ where: { runId: run.id } });
  await prisma.agentToolCall.deleteMany({ where: { runId: run.id } });
  await prisma.agentRun.delete({ where: { id: run.id } });
  await prisma.agentMessage.deleteMany({ where: { conversationId: conversation.id } });
  await prisma.agentConversation.delete({ where: { id: conversation.id } });
  console.log("清理完成");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("验收失败:", error);
    process.exit(1);
  });
```

- [ ] **Step 2: 运行验收**

终端 A：

```bash
cd F:/project/code/xhs-assistant
npx tsx src/worker/index.ts
```

终端 B：

```bash
npx tsx src/scripts/agent-smoke.ts
```

Expected 输出（关键四行）：

```
创建 Run: <id> taskId: <id>
Run 最终状态: succeeded
事件序列: agent_start → turn_start → ... → agent_end
草稿数：N → N+2
```

**验收判定**：

| 标准 | 通过条件 |
|---|---|
| 循环跑通 | Run 状态为 `succeeded` |
| 事件完整 | 序列含 `agent_start`、`agent_end`，且中间有 `tool_execution_end` |
| 工具真被调用 | 草稿数增加（证明 `topic.generate` 落库了选题；若模型选择 `content.notePack` 则也应有草稿）|
| 无 Pi 泄漏 | `grep -rn "@earendil-works/pi" src/app/` 无输出 |

- [ ] **Step 3: 记录 P0 验收结果**

在 `docs/superpowers/specs/2026-10-09-agent-workspace-design.md` 的 §12 分期交付表下方追加：

```markdown
### 12.1 P0 验收记录（YYYY-MM-DD）

- 会话 ID / Run ID：
- Run 最终状态：
- 事件序列：
- 草稿数变化：
- 实测用的模型（provider / modelName）：
- 发现的问题：
```

- [ ] **Step 4: 运行全部测试与类型检查**

```bash
npx vitest run && npx tsc --noEmit
```

Expected: 全部测试通过（原 90 个 + 新增约 47 个），无类型错误。

- [ ] **Step 5: 提交**

```bash
git add src/scripts/agent-smoke.ts docs/
git commit -m "test(agent): 新增 P0 端到端验收脚本并记录验收结果"
```

---

## 完成标准

P0 全部完成后应满足：

- [ ] R1/R2/R3 三项风险已实测并记录结论
- [ ] 5 张 Agent 表已在数据库中创建
- [ ] `skill-catalog.ts` 抽取完成，`workflow-service.ts` 工作流功能无回归（原有测试全过）
- [ ] 15 个工具中 A 组 6 个已可被 Agent 调用（B/C 组留 P1）
- [ ] Agent 循环可在 worker 中跑通，事件完整落库
- [ ] 假 streamFn 离线测试可用（不烧 token 即可回归）
- [ ] `grep -rn "@earendil-works/pi" src/app/` 无输出（架构铁律）
- [ ] `npx vitest run` 与 `npx tsc --noEmit` 全绿

## 设计文档中已写、但本计划未覆盖的项（明确留到 P1）

自查设计文档时发现以下 4 项在 P0 范围内无法闭环，**明确推迟到 P1**，此处登记避免遗漏：

| 设计文档 | 内容 | 为何推迟 | 影响 |
|---|---|---|---|
| §6.5 | 把选中技能的 `instructions` 追加进 system prompt | P0 只跑通循环，先不优化 prompt 精度 | Agent 行为调优空间受限，功能不受影响 |
| §7.6 | 同会话并发用 `followUp()` 排队 | P0 的验收脚本是"一会话一 Run"，未触发并发场景 | P0 可正常验收；P1 接前端时必须有 |
| §8.3 | `CustomAgentMessages` 声明合并（工件/通知消息类型）| Task 7 已写入 `types.ts`，但 P0 的工件走 `AgentEvent(type="artifact")` 而非自定义消息 | 两条路径都可用；P1 决定统一用哪条 |
| §7.4 | `AGENT_RUN_TIMEOUT_MS` 之外，`maxSteps` / `tokenBudget` 的实际**强制**（P0 只落库了阈值，未在循环中硬性拦截）| Pi 的 `finishTurn` 钩子是拦截点，实现需额外验证 | **P0 有超时与连续失败两道硬拦，步数/预算仅记录不拦截** —— 长任务可能超出预期成本 |

最后一项需要你在 P0 验收后确认是否可接受：P0 阶段步数与 token 只记录不拦截，若模型陷入循环，靠 10 分钟墙钟超时兜底。

---

## P0 之后（不在本计划内）

P1：SSE 订阅端点、三栏前端、B 组 5 个 + C 组 4 个工具、工件面板、会话 CRUD 路由、`followUp` 排队、`instructions` 注入、步数/预算硬拦截
P2：护栏细化、崩溃恢复完善、中止功能、测试补齐、`ARCHITECTURE.md` / `CHANGELOG.md` 补齐
