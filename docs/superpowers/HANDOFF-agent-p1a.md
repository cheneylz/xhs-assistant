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

**B 块必须遵守的三条渲染规则**（不遵守就会重复渲染或出现空白气泡）：

1. **`messages` 只含 user 消息** —— 助手文本一律从 `events`（历史）与 SSE（实时）来。最终答复同时存在于 `agent_messages` 与 `message_end` 事件里，`messages` 若也返回 assistant 行，同一段话会渲染两遍。
2. **`events` 里不含 artifact、也不含 tool_execution_\*** —— 工件只认 `artifacts` 字段，工具卡只认 `tool_calls`（按 `tool_call_id` 归并，见设计稿 §5.3）。
3. **`message_end` 的 `payload.text` 是可选的** —— 渲染前必须同时判定 `payload.role === "assistant"` 与 `text` 非空，否则会出空白气泡（Pi 对 user / toolResult / system 也发 message_end，且升级前落库的旧行是 `{role, trimmed:true}`）。

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

2. **跑 `npx prisma generate` 前先停 dev server**：`next dev` 会占住 `query_engine-windows.dll.node`，generate 报 `EPERM`（本轮踩到一次，靠事后补跑修掉）。

3. **bash 传中文参数到命令串会损坏字节**：`curl -d '{"content":"帮我生成"}'` 到服务端会变成 U+FFFD。需要发中文请求体时，用 tsx 写 UTF-8 文件 + `curl --data-binary @file`。

4. **多行 `tsx -e` 只执行首行**：验证脚本一律写成单行。

5. **没有 `prisma/migrations/` 目录**：schema 变更走 `npx prisma db push`（本轮加过 `summary` 列与两个索引，`db push` 都是安全的增量）。

---

## 六、已知局限（P1 明确接受，不是遗漏）

| 局限 | 说明 |
|---|---|
| `POST /messages` 的并发保护是 TOCTOU | 两个并发 POST 可能都通过检查（窗口毫秒级）。无部分唯一索引可用（`db push` 管不了 partial unique index）；前端在运行中禁用输入框已覆盖常见场景 |
| DELETE 与 `POST /messages` 存在竞态 | 极端时序下可能留下孤儿事件行或让 `finishRun` 抛一次错（worker 现在会打日志，不再静默） |
| 首屏 `result` 截断到 4000 字符 | 超出部分以 `result_truncated: true` 标记，展开只能看到前 4000 字符 |
| `listConversations` 无分页 | 左栏一次拉全量。会话数到几百时需要考虑分页（P2） |
| 图片两个工具未做 | 设计稿 D24：开发库没有 `modelType=image` 的模型，做了也无法验收 |

---

## 七、遗留项

### 7.1 C 块：7 个新工具（设计稿 §六）

- `content_rewrite`（**write，会直接改用户草稿**）、`content_titles`、`content_tags`、`analytics_reports`、`kb_get`、`library_search_notes`、`library_note_detail`
- 后两个需要**先做抽取重构**：查询逻辑目前内联在 `src/app/api/notes/route.ts`，要抽成 service 并让路由与工具共用
- 每个工具都要在 `SkillDefinition.summarize` 补一份摘要（**必填字段，漏写过不了 `tsc`**），`summarizeCount` 已导出可复用
- `agent.md` 提示词要补一条：`content_rewrite` 会改草稿，要求模型改写前说明将修改哪篇（设计稿 §八 风险 5）

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
| **`Promise.allSettled` 会静默吞掉异常**：不逐条检查 rejected，Run 执行的异常会完全消失在日志里 | `worker/index.mts` 的 `agentRunRunner` |
