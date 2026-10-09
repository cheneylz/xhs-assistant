# 交接说明：自主 Agent 工作台 P0

- 交接日期：2026-10-09
- 分支：`docs/agent-workspace-design`
- 状态：**Task 0–9 完成，Task 10–12 未开始**

---

## 一、一句话现状

前置地基全部就绪并通过验证：Pi SDK 集成可行性已实测、5 张表已建、10 个 Agent 模块已实现并提交、163 个测试全绿。**剩下的是把 Agent 循环装配起来（Task 10）、接进 worker（Task 11）、端到端验收（Task 12）。**

---

## 二、代码状态

| 项 | 值 |
|---|---|
| 分支 | `docs/agent-workspace-design`（从 `main` 新建，**未合并**）|
| 提交数 | 27（自文档基线 `3803a7a` 起）|
| 测试 | 18 文件 / 163 用例全通过（重构前基线：10 / 90）|
| `tsc --noEmit` | 干净 |
| `next build` | 通过 |
| 工作区 | 干净。`CLAUDE.md` 处暂存状态（交接前就如此，全程未动）；`public/show/` 未跟踪 |

### 已实现的模块

```
src/lib/server/agent/
  ├── skill-catalog.ts        技能目录 + executeSkill（无 Pi 依赖）
  ├── tool-schemas.ts         TypeBox 入参 schema + 完整性断言（无 Pi 依赖）
  ├── guards.ts               工具准入护栏 + 连续失败计数（无 Pi 依赖）
  ├── context.ts              字符预算裁剪 + 工具结果摘要（无 Pi 依赖）
  ├── persist.ts              事件/工具调用落库 + 工件抽取（无 Pi 依赖）
  ├── model-bridge.mts        ModelConfig → pi-ai Model（含 Pi 依赖）
  ├── tool-registry.mts       技能 → AgentTool（含 Pi 依赖）
  └── types.mts               自定义消息类型声明合并（含 Pi 依赖）

src/lib/server/services/
  ├── agent-service.ts        会话/消息/Run CRUD + SKIP LOCKED 领取
  └── workflow-service.ts     技能目录已抽走，改为 import（行为不变）

prisma/schema.prisma          +5 张 Agent 表（含 2 个 CASCADE 外键）
tsconfig.json                 +allowImportingTsExtensions、include 纳入 **/*.mts
```

**架构铁律**：Next.js 侧永不 `import "@earendil-works/pi-*"`。仅 `*.mts` 文件（4 个）可 import Pi。已用 grep 验证。

---

## 三、R1/R2/R3 风险验证：全部闭合

| 风险 | 结论 |
|---|---|
| **R1** ESM 加载 | ❌ 原方案失败 → **改用 `.mts` 入口**解决 |
| **R2** TypeBox 校验 | ✅ 通过 |
| **R3** 自定义 baseUrl | ✅ 通过（真实 provider，两条路径）|

**R1 的教训（重要）**：失败模式是 `ERR_PACKAGE_PATH_NOT_EXPORTED`，**不是**设计文档原先假设的 `ERR_REQUIRE_ESM`。根因是 Pi 包的 `exports` 映射**只声明 `types` + `import` 条件，无 `require`、无 `default`** —— 模块解析阶段即失败，走不到 Node 的 `require(esm)` 互操作。所以"Node 24 默认支持 require(esm)"这条缓解手段**不成立**。

**R3 的最终配置**（已可用）：`modelName=deepseek-flash`，`baseUrl=https://api.deepseek.com`。自研客户端与 pi-ai 两条路径同时通过。

---

## 四、待办：Task 10 / 11 / 12

**执行入口**：读 `docs/superpowers/plans/2026-10-09-agent-workspace-p0.md` 的 **「## Task 10」** 起。该计划自包含（完整代码块 + 精确命令 + 每步预期输出），且已按独立补审修订过。

| Task | 内容 | 规模 |
|---|---|---|
| **10** | `context.ts` 补强 + `prompts/agent.md` + `agent-loop.mts` 装配 | 最大，约 12 步 TDD |
| **11** | worker 接入 `agent_run_runner` + 崩溃清扫 + `index.ts` → `index.mts` 改名 | 中 |
| **12** | 端到端验收脚本（含失败路径与 `agent_tool_calls` 断言）| 中 |

### Task 10 的三个必读前置（补审抓出的致命项，计划里也有）

1. **钩子选择铁律** —— 需要**改写**工具结果的逻辑（结果摘要、工件抽取、工具调用落库）**必须放 `afterToolCall`**。Pi 的 `subscribe` 只能**观察**事件、无法改写 `content`/`details`。把这类逻辑写进 `subscribe` 会编译通过、测试也可能过，但**永远不会生效**。这一个漂移曾导致三个导出（`summarizeToolResult`、`persistToolCall`、`finalizeToolCall`）在计划里全无调用点。

2. **`resolveLoopOutcome` 必须 fail-closed** —— 只有 `stopReason === "stop"` 才算成功。Pi 的契约是 `StreamFn` **不得抛异常**，失败编码在 `stopReason: "error" | "aborted"` 里；且 `agent.abort()` 只中止 AbortController、`waitForIdle()` **只 resolve 永不 reject**。用 `try/catch` 判成功会把超时、连续工具失败、API Key 错误、限流、provider 500 **全部记成 succeeded**。**这不是理论风险 —— R3 验证时真实撞到过**：provider 返回 400，流没抛异常，只把 `stopReason` 置为 `error`。

3. **被拦下的调用不进 `afterToolCall`** —— `beforeToolCall` 返回 `{ block: true }` 时，Pi 只派发事件、跳过 `afterToolCall`。所以 `"blocked"` 状态的工具调用记录必须在 `beforeToolCall` 里写。

---

## 五、踩过的坑（新会话可直接复用结论，不必重新发现）

### 5.1 `.mts` 与 tsconfig（Task 4）

`.mts` 后缀是运行时的**硬性要求**（Pi 包 ESM-only，tsx/Node ESM 不做扩展名推断），但原 `tsconfig.include` 是 `["**/*.ts", "**/*.tsx"]` —— **不含 `.mts`**，导致 5 个 `.mts` 文件完全逃过 `tsc` 检查，且悄无声息。已在提交 `9624f32` 修复（`include` 纳入 `**/*.mts` + 开启 `allowImportingTsExtensions`）。

**写 `.mts` 时的规则**：
- 导入 `.mts` 文件必须**显式带后缀**（`./foo.mts`）
- 导入 `.ts` 文件**不要**带后缀（`./skill-catalog`）
- **不要**用 `@ts-ignore` 绕过 `TS5097`（已全局开启该选项）
- 验证 `.mts` 确被检查的方法：往里注入一个类型错误，确认 `tsc` 报出来

### 5.2 时区（Task 9，最隐蔽的一组）

全库约定为**朴素上海墙钟**（`shanghaiNow()`，全库 0 处 `@default(now())`，`@updatedAt` 也刻意不用）。三个坑：

| 坑 | 后果 |
|---|---|
| 原始 SQL 用 `now()` | Docker 的 Postgres 跑 UTC（`docker-compose.yml` 未设 TZ），`started_at` 晚 8 小时 → **配合上海时间阈值，每个刚领取的 Run 会被立刻判定卡死并标记失败** |
| `sweepStuckRuns` 用 `Date.now()` 做基准 | 阈值早 8 小时 → 卡死 Run 要多等 8 小时才被清扫（**本机也坏**）|
| 把 `shanghaiNow()` 当 `$queryRaw` 参数传 | Prisma 把 Date 参数绑为绝对时刻，服务端再套会话时区 → 又被 +8 小时 |

**正确写法**：原始 SQL 里的时间一律走 SQL 侧表达式 `now() AT TIME ZONE 'Asia/Shanghai'`；比较基准用 `shanghaiNow()`。

### 5.3 `riskLevel` 必须按函数体实证，不能凭技能名推断（Task 2/3）

最初 6 个技能**标错 3 个**：

| skillKey | 原标 | 实为 | 实证 |
|---|---|---|---|
| `hot.refresh` | read | **write** | `hotTopic.createMany` + `deleteMany` |
| `script.generate` | write | **read** | `generateVideoScript` 无 prisma 调用 |
| `schedule.recommend` | write | **read** | 仅 `findFirst`/`findMany` |

### 5.4 单元测试不得触达外部 API（Task 7）

计划里有个测试断言 `hot.refresh` 会抛错，实际因开发库有账号+Cookie 而只短路在空关键词组 —— **一旦有人加了关键词组，`npm test` 就会向小红书真实搜索接口发请求**。已替换为确定性离线测试。

**另一条相关的**：那个"不产生孤立 toolResult"的测试是**假通过** —— 同一次运行里移除被测功能它照样绿（因为其场景里 toolResult 永远放不进预算，修正循环根本没执行）。已补了一个真正触发循环的用例。**结论：声称守护不变量的测试，要用变异测试验证它非空洞。**

### 5.5 `ModelConfig` 的能力缺口（未修，当前不影响）

`ModelConfig` **没有存放自定义请求头的字段**，三处都不支持（`ModelConfig` / `buildPiModel` / 自研客户端 `postJson`）。若接入需要自定义头的网关（如 OpenCode Zen 要求 `x-opencode-session`），**项目现有全部 AI 功能都会不可用**，不只 Agent。

**已验证修法**：`Model.headers` 挂上该头后 R3 通过。生产化需三处配套（`ModelConfig` 加 `headers` 字段 + `buildPiModel` 透传 + `postJson` 支持额外头）。当前用的标准端点不需要，故未实施。

### 5.6 其他环境注意

- **`npx tsx -e "..."` 在本项目下不产出输出** —— 一律用脚本文件
- 开发服务器运行时会占用 Prisma 引擎 DLL，期间 `prisma generate` 报 `EPERM`，需先停服务
- Windows 下 `process.exit(0)` 会刷出 libuv `Assertion failed` 噪音（输出已完整打印，无害）
- 环境实际 Node 为 **v24.16.0**（`CLAUDE.md` 写的是 24.17.0，建议订正）

---

## 六、交接时未处理的事项

| 事项 | 说明 |
|---|---|
| 开发服务器 | 交接时**仍在后台运行**（`http://localhost:3000`）。不需要就停掉 |
| `CLAUDE.md` | 处暂存状态（`A`），会话开始前即如此，全程未动。它同时被 `.gitignore` 忽略却已暂存，状态不一致 |
| `x-opencode-session` 能力缺口 | 见 5.5，已记录未修 |
| `ARCHITECTURE.md` / `REWRITE_PLAN.md` / `CHANGELOG.md` | CLAUDE.md 第 4 条要求维护，当前均不存在。`docs/` 已从 `.gitignore` 移除（提交 `d4a557b`）|
| 计划里的测试数预测 | 计划中多处预测的用例数不准（实际每次都比预测多）。**以实测为准** |

---

## 七、建议的接手顺序

1. `git status` + `npx vitest run` + `npx tsc --noEmit` 确认基线（应为 18 文件 / 163 用例全绿）
2. 读计划 Task 10 开头那段「钩子选择铁律」（这是本任务的核心约束）
3. 按计划执行 Task 10 → 11 → 12
4. Task 12 需要**真实模型 + 运行中的 worker**，模型已配好可用
5. 全部完成后走 `superpowers:finishing-a-development-branch` 收尾

**计划文件**：`docs/superpowers/plans/2026-10-09-agent-workspace-p0.md`
**设计文档**：`docs/superpowers/specs/2026-10-09-agent-workspace-design.md`（含 17 条决策记录 D1–D17 与全部实测结论）
