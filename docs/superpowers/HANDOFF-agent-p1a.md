# 交接说明：自主 Agent 工作台 P1-A（接口层）

- 交接日期：2026-10-09
- 分支：`main`（本地领先 `origin/main`，未推送）
- 状态：**A 块（D23 + 接口层）已完成并端到端验收通过；C 块（7 个工具）与 B 块（前端）未开始**

---

## 一、一句话现状

P1 的 A 块做完了：Agent 的中间过程文本现在会落库（D23），8 个 REST/SSE 接口全部可用，工具卡摘要在服务端算好落库并随 SSE 推送。**端到端验收脚本 `src/scripts/agent-api-smoke.ts` 9 项全过**（含一轮真实模型的 ReAct 运行）。

下一步按设计稿 §十：**C 块（7 个新工具）与 B 块（前端三栏界面）**。建议先写 C 块（与 B 无依赖），B 块的计划等前端开工时再写 —— 那时接口形状已经是实测值而非推测。

---

## 二、交付物

| 文件 | 内容 |
|---|---|
| `docs/superpowers/plans/2026-10-09-agent-workspace-p1-a-api.md` | **A 块实施计划**（17 个任务），文首「执行进度」表与「实施后订正」表是**了解最终实现与计划差异的唯一入口**，务必先读那两张表 |
| `src/scripts/agent-api-smoke.ts` | **A 块端到端验收脚本**（9 项）。改任何接口层代码后必须重跑 |
| `src/scripts/agent-smoke.ts` | P0 验收脚本。**改了 worker / agent 循环 / persist 后必须重跑** |
| `docs/superpowers/specs/2026-10-09-agent-workspace-p1-design.md` | P1 设计稿（D19–D25）。**§八 缺口 1 已由本块解决**；缺口 2（图片工具）仍待 C 块之后处理 |

---

## 三、实测后的接口契约（B 块按这个写）

全部在 `src/app/api/agent/` 下，认证统一 `Authorization: Bearer <jwt>`，请求/响应体 `snake_case`。

| # | 方法 | 路径 | 说明 |
|---|---|---|---|
| 1 | GET | `/conversations` | 会话列表 → `{ items: [conversation] }` |
| 2 | POST | `/conversations` | 新建会话 → `conversation`。**请求体必须发 `{}`**（空 body 会 400）|
| 3 | GET | `/conversations/[id]` | **首屏契约**（见下）|
| 4 | POST | `/conversations/[id]/messages` | 发消息 → `{ conversation, message, run }`；会话执行中 → 409 |
| 5 | GET | `/conversations/[id]/events` | **SSE 订阅**（见下）|
| 6 | GET | `/conversations/[id]/artifacts` | 工件列表 → `{ items: [artifact] }`（右栏单独刷新用）|
| 7 | POST | `/runs/[runId]/cancel` | 取消（仅 pending）→ `{ run }`；running/终态 → 409；不存在/他人 → 404 |
| 8 | DELETE | `/conversations/[id]` | 删除会话；**执行中 → 409**；不存在/他人 → 404 |

### 3.1 首屏契约（接口 3）—— 十个字段

```jsonc
{
  "conversation": { "id": 12, "title": "露营选题", "status": "running", "created_at": "…", "updated_at": "…" },
  "messages":   [ /* 只含 role="user" 的消息 */ ],
  "events":     [ /* 只含 message_end / status / error 三类，id ≤ latest_event_id */ ],
  "tool_calls": [ /* 已完成的工具卡，含 summary */ ],
  "artifacts":  [ /* 右栏工件 */ ],
  "runs":       [ /* 会话的全部 Run，含 step_count/max_steps/task_id */ ],
  "latest_event_id": 1234,
  "events_truncated": false,
  "tool_calls_truncated": false,
  "artifacts_truncated": false
}
```

**B 块必须遵守的四条渲染规则**（不遵守就会重复渲染、出空白气泡或漏卡片）：

1. **`messages` 只含 user 消息** —— 助手文本一律从 `events`（历史）与 SSE（实时）来。最终答复同时存在于 `agent_messages` 与 `message_end` 事件里，`messages` 若也返回 assistant 行，同一段话会渲染两遍。
2. **`events` 里不含 artifact、也不含 tool_execution_\*** —— 工件只认 `artifacts` 字段，工具卡只认 `tool_calls`（按 `tool_call_id` 归并，见设计稿 §5.3）。`tool_calls` **不按 status 过滤**，可能含 `running` 行 —— 这正是跨边界归并需要的（设计稿 §5.3 的「start 早于分界、end 晚于分界」情形）。
3. **`message_end` 的 `payload.text` 是可选的** —— 渲染前必须同时判定 `payload.role === "assistant"` 与 `text` 非空，否则会出空白气泡（Pi 对 user / toolResult / system 也发 message_end，且升级前落库的旧行是 `{role, trimmed:true}`）。
4. **每个工具调用都会有行、有摘要** —— Pi 在三种情况下会在走钩子**之前**就短路（① 模型幻觉出不存在的工具名；② 参数 schema 校验失败；③ 输出被 `length` 截断），这些调用不经过 `beforeToolCall`/`afterToolCall`。**已由事件回填解决**：`agent-loop.mts` 的 `subscribe` 在 `tool_execution_end` 上用事件载荷补一行（`errorType: "not_executed"`、摘要形如「未执行：Tool xxx not found」）。

   仍要防的**唯一情况**是回填那次落库也失败（DB 异常）—— 此时该帧确实没有行。B 块按 toolCallId 归并时应容忍「有帧无卡」，不要假设帧与卡片一一对应。

`*_truncated` 三个标记：达到上限即置位（**恰好等于上限时是假阳性**：events 1000 / tool_calls 200 / artifacts 200，取的都是**最新**那批，丢的是更早的）。

### 3.2 SSE 帧格式（接口 5）

```
data: {"id":124,"run_id":31,"type":"tool_execution_end","payload":{…},"created_at":"2026-10-09T23:11:19"}
                                                                    ↑ 工具事件这里会有 summary
: ping          ← 心跳，每 15s
```

- **id 在 JSON 载荷里**（不是 SSE 规范的 `id:` 字段）—— 客户端手工解析，断线重连复用同一个 `last_event_id`
- 认证用 `fetch` + `Authorization: Bearer`，**不能用 `EventSource`**（它无法携带自定义 header）
- 响应头：`Content-Type: text/event-stream; charset=utf-8` / `Cache-Control: no-cache, no-transform` / `X-Accel-Buffering: no`
- 轮询节奏：会话内有 pending/running 的 Run 时 **500ms**，全部终态降到 **5s**（`src/lib/agent/polling.ts` 的 `nextPollInterval`，前后端共用）
- 服务端**不会主动关流**：靠客户端 abort 或 `cancel()` 退出

### 3.3 `last_event_id` 的语义（去重边界）

- 首屏拿到的 `latest_event_id` 就是 SSE 的起点，**只渲染 id 大于它的事件**
- 订阅接口支持 `?last_event_id=N`：断线重连、页面刷新都复用它
- 首屏与订阅之间的时间窗内产生的事件，既不会重复渲染（首屏不含它们），也不会丢（SSE 会以 `id > latest_event_id` 捡回）

---

## 四、验收方式

### 4.1 A 块端到端（三终端）

```
终端 A：npx tsx src/worker/index.mts
终端 B：npm run dev
终端 C：npx tsx src/scripts/agent-api-smoke.ts
```

**实测耗时**：整脚本约 60 秒/次，其中 SSE 那一步 16–25 秒（一轮真实模型的 ReAct：3 次工具调用、约 1400 帧）。

### 4.2 P0 回归（改了 loop / persist / worker 后必跑）

```
终端 A：npx tsx src/worker/index.mts
终端 B：npx tsx src/scripts/agent-smoke.ts
```

### 4.3 基线

`npx vitest run` = **24 文件 / 241 用例全绿**；`npx tsc --noEmit` 无输出；`npx next build` 通过。

---

## 五、⚠️ 本机操作陷阱（本轮又踩到两次）

1. **`TaskStop` / 杀父进程都杀不掉 worker 派生的子 `node`** —— 残留 worker 会继续按 cron 领任务、跑**旧代码**，制造「改了代码行为没变」的假象。停 worker 必须按命令行过滤后按进程树清：

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*worker/index.mts*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

2. **跑 `npx next build` 或 `npx prisma generate` 前，先停 dev server**：
   - **`next build` 会覆盖 dev 的 `.next`** —— 本轮踩到：build 之后 dev server 对「此前从未被请求过」的路由做懒编译时，会加载坏掉的布局，表现为该路由**稳定 500**（其他接口正常），极难判断是环境问题还是代码问题。**修法：停 dev → `rm -rf .next` → 再起 dev**（只重启 dev 不清 `.next` 可能不够）。
   - `prisma generate` 会被 `next dev` 占住的 `query_engine-windows.dll.node` 挡成 `EPERM`。

3. **bash 传中文参数到命令串会损坏字节**：`curl -d '{"content":"帮我生成"}'` 到服务端会变成 U+FFFD。需要发中文请求体时，用 tsx 写 UTF-8 文件 + `curl --data-binary @file`。

4. **多行 `tsx -e` 只执行首行**：验证脚本一律写成单行。

5. **没有 `prisma/migrations/` 目录**：schema 变更走 `npx prisma db push`（本轮加过 `summary` 列与两个索引，`db push` 都是安全的增量）。

---

## 六、已知局限（P1 明确接受，不是遗漏）

| 局限 | 说明 |
|---|---|
| `POST /messages` 的并发保护是 TOCTOU | 两个并发 POST 可能都通过检查（窗口毫秒级）。无部分唯一索引可用（`db push` 管不了 partial unique index）；前端在运行中禁用输入框已覆盖常见场景 |
| DELETE 与 `POST /messages` 存在竞态 | 极端时序下可能留下孤儿**事件行与 Task 行**（`tasks` 表没有清理者，比事件行更值得注意），或让 `finishRun` 抛一次错（worker 现在会打日志，不再静默） |
| **「阻断」这种工具卡状态在 P1 生产不可达** | 设计稿 §7.2 要求 4 种状态（运行中/成功/失败/阻断）都渲染正确，但要产生阻断数据需要目录里有 `publish` 级技能（当前 6 个都不是）；「工具名在目录外」已被 Pi 在 `beforeToolCall` 之前短路 → 走的是「未执行」回填而非阻断。**B 块照实现即可，但验收时演示不出来** |
| 被中止的调用可能永远停在 `running` | 若 `beforeToolCall` 已落 running 行、而该调用因中止（超时 / 连续失败中止）没走到 `afterToolCall`，那行的 `rowId != null` 会让回填跳过它 → 卡片永远显示「运行中」。窗口很窄（P1 的取消只作用于 pending，触发源是墙钟超时），暂登记不修 |
| SSE 推送全部事件类型 | 一次运行约 1400 帧里绝大多数是 `message_update`/`message_start` 噪声（载荷只有 `{role, trimmed}`）。B 块必须忽略未知类型。**若日后要在服务端按类型过滤，别把 `agent_end` 滤掉** —— 它是前端唯一可靠的结束信号 |
| SSE 无并发连接上限 | 每个连接每 500ms 一次查询。单机自用够用；多实例/多标签页场景需限流（P2） |
| 首屏 `result` 截断到 4000 字符 | 超出部分以 `result_truncated: true` 标记，展开只能看到前 4000 字符。`params` **未截断**（工具参数由模型按 schema 产出，体积可控） |
| `listConversations` 无分页 | 左栏一次拉全量。会话数到几百时需要考虑分页（P2） |
| 设计稿 §3.3(1) 与实现有出入 | 设计稿说空闲时「只查有没有新 Run」，实现里空闲 tick 仍照查 events（代价可忽略）。**以代码为准** |
| 图片两个工具未做 | 设计稿 D24：开发库没有 `modelType=image` 的模型，做了也无法验收 |

---

## 七、遗留项

### 7.1 C 块：7 个新工具（设计稿 §六）

- `content_rewrite`（**write，会直接改用户草稿**）、`content_titles`、`content_tags`、`analytics_reports`、`kb_get`、`library_search_notes`、`library_note_detail`
- 后两个需要**先做抽取重构**：查询逻辑目前内联在 `src/app/api/notes/route.ts`，要抽成 service 并让路由与工具共用
- 每个工具都要在 `SkillDefinition.summarize` 补一份摘要（**必填字段，漏写过不了 `tsc`**），`summarizeCount` 已导出可复用
- `agent.md` 提示词要补一条：`content_rewrite` 会改草稿，要求模型改写前说明将修改哪篇（设计稿 §八 风险 5）
- **加完工具后要同步改两处断言**：`skill-catalog.test.ts` 的「包含全部 6 个预置技能」与 `agent-loop.test.ts` 的「列出全部 6 个技能的 skillKey」（预期内，不是回归）
- 若想让「阻断」状态可见（§六 那条局限），需要引入一个 `publish` 级技能 —— **这是跨块的产品决策，先问用户**

### 7.2 B 块：前端三栏界面（设计稿 §五）

- 8 个文件（`/agent` 页 + 7 个组件 + `use-agent-events.ts`），antd 6 + `useReducer`，不引新依赖
- 纯函数（`reduceAgentEvents` / `nextPollInterval`）用现有 vitest 覆盖；`nextPollInterval` **已经在 `src/lib/agent/polling.ts` 里，直接复用**
- 侧边栏入口：`src/components/layout/app-shell.tsx` 的 `mainNavItems`（Agent 是跨模块总入口，不埋在 xhs 平台下）

### 7.3 `docs/` 下仍没有「总的项目代码文档」

CLAUDE.md 原则 4 要求维护一份总的项目代码文档，**P0 起就一直缺**（`docs/` 下只有 `superpowers/`）。建议作为独立任务补，不要塞进 P1 的某一小块里。

---

## 八、本轮的工程经验（可直接复用）

| 结论 | 出处 |
|---|---|
| **服务层不得 import `http-error`**（它依赖 `next/server`，会污染 worker 的依赖图）。服务层只表达「查不到」（返回 `null` / `boolean` / `outcome` 联合），状态码由路由层决定 | `agent-service.ts` 文件头 |
| **摘要键必须是 `runId:toolCallId` 复合键**：provider 常按 Run 重置工具调用计数（每个 Run 都有 `call_1`），只用 toolCallId 会让同会话两个 Run 互相串摘要 | `stream-events.ts` 的 `toolCallSummaryKey` |
| **多次写入要么同事务，要么会留下不可修复的不一致**：本轮修了两处（`cancelPendingRun` 的三步写入、`createRunForMessage` 的 Task+Run+会话状态） | `agent-service.ts` |
| **`message_end` 载荷的 `text` 是可选字段**：Pi 对所有角色都发 message_end，渲染方必须判 `role === "assistant"` | `stream-events.ts` 的注释 |
| **SSE 的 `id > lastId` 天然就是断线重连语义**，`latest_event_id` 一个值同时解决了「首屏与订阅的时间窗」与「刷新后不重复渲染」 | 设计稿 §4.4 |
| **回填/补写必须在「事件行落库」之前完成**：SSE 出口是「查到事件行就转发」，转发那一刻才查 `agent_tool_calls` 补摘要 —— 先把事件行写下去就会留下「帧已发出、行还没写完」的窗口，且 `lastId` 前移后该帧永不重发（客户端永久缺摘要） | `agent-loop.mts` 的 `subscribe` 注释 |
| **`tool_execution_start` 在任何钩子之前发出**（Pi 源码 `agent-loop.js:377`），所以「每个调用的序号」要在它上面分配 —— 短路调用不进钩子，序号在钩子里分配会让 `step_index` 不连续（P0 验收脚本会断言连续性） | `agent-loop.mts` 的 `toolCallRows` 注释 |
| **`Promise.allSettled` 会静默吞掉异常**：不逐条检查 rejected，Run 执行的异常会完全消失在日志里 | `worker/index.mts` 的 `agentRunRunner` |
