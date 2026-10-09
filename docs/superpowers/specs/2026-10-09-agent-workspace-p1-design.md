# 自主 Agent 工作台 P1 设计稿

- 日期：2026-10-09
- 前置：P0 已完成并验收通过（`docs/superpowers/specs/2026-10-09-agent-workspace-design.md`，分支已合并入 `main`）
- 设计依据：P0 设计文档 §9（前端与 SSE）、§12（分期交付）
- 本稿性质：**细化并部分订正 P0 设计文档**，所有偏离均标注证据

---

## 一、目标

让 Agent 工作台**在浏览器里可用**：用户打开 `/agent`，用自然语言下任务，实时看到 Agent 的思考过程（工具调用、文字），产出物在右栏可见并可跳转到现有模块精修；同时把 Agent 的可调用工具从 6 个扩到 13 个。

P1 验收标准（沿用 P0 设计文档 §12 并细化）：浏览器里用自然语言对话完成任务，过程实时可见，工件可跳转。

---

## 二、决策记录（本轮新增，续 P0 的 D1–D18）

| # | 决策点 | 结论 | 理由 |
|---|---|---|---|
| D19 | 取消范围 | **P1 只取消 `pending` 的 Run** | 取消 pending 是纯 DB 操作（`claimPendingRuns` 只认 `pending`），零跨进程通信；中止 running 需要标志位 + worker 轮询 + 接线 `abort()`，而 P0 已有两道硬拦兜底。订正 P0 设计文档 §9.2（列在 P1）与 §12（列在 P2）的矛盾，以本节为准 |
| D20 | 工件面板 | **常驻三栏**，无工件时显示空态 | 与 P0 已定的 D2「三栏」一致；布局稳定不跳动（工件到达时弹出右栏会打断阅读，且与消息流自动滚动打架）；实现与测试成本最低（无额外交互状态）|
| D21 | 工具卡片 | **摘要卡片（两行）**，摘要由服务端生成 | 用户要求「一眼看懂工具干了什么」。为避免 P0 设计文档 §六 反对的「第二份元数据」，摘要函数放进**已有的** `SkillDefinition`（与 `artifact` 同类，同为「产出怎么展示」），且**必须在服务端算好** —— `skill-catalog.ts` import 了 prisma 与多个 service，前端不能 import |
| D22 | SSE 推送机制 | **API 轮询数据库** | 与 P0 已定的 D15（3 秒轮询而非 NOTIFY）同一哲学；零新依赖、无长连接生命周期管理；`id > lastId` 的查询天然就是断线重连语义，正好对应 `last_event_id` |
| D23 | 过程文本可见性 | **整段出现**（`message_end` 保留文本，`message_update` 继续裁）| 见 §六缺口 1。单轮约 300 条增量 vs 一次运行几条整段，**体积差两个数量级**；与 D21「一眼看懂」的取向自洽 |
| D24 | 新工具范围 | **P1 做 7 个**，图片 2 个（`image_generate` / `image_cover`）推后 | 开发库**没有 `modelType=image` 的模型**（实查仅 1 条 text 模型），做了也无法验收；且图片工具需扩展 `SkillContext`、要复刻路由里的资产落库编排、单次调用可能几十秒（`toolExecution: "sequential"` 下阻塞整个循环）|
| D25 | 前端测试策略 | **不引前端测试栈**，把归并逻辑抽成纯函数用现有 vitest 测 | 项目 vitest 为 `environment: "node"` + `include: ["src/**/*.test.ts"]`，且无 `@testing-library`/`playwright`/`cypress`。事件归并 reducer、降速判定都是纯函数，node 环境即可测；只剩 React 渲染本身靠手工验收 |

---

## 三、架构与数据流

### 3.1 核心约束

**worker 与 Next.js API 是两个进程，之间没有任何直接通信** —— 全部经由 PostgreSQL 的 5 张表。这决定了 SSE 只能是「API 主动查库再转发」的形态（D22）。

```
浏览器 ──HTTP/SSE──→ Next.js API ──┐
                                   ├──→ PostgreSQL（5 张表）
worker（独立进程）─────────────────┘
```

### 3.2 一次完整链路

| 步 | 发生方 | 动作 |
|---|---|---|
| ① | 浏览器 | 输入框发消息 → `POST /api/agent/conversations/[id]/messages` |
| ② | API | 写 `agent_messages`、建 `Task` + `AgentRun(pending)`、会话置 `running` |
| ③ | worker | 每 3s `claimPendingRuns`（`FOR UPDATE SKIP LOCKED`）→ `running` + `started_at` |
| ④ | 浏览器 | 订阅 `GET …/events?last_event_id=N`（`fetch` + `ReadableStream`）|
| ⑤ | API | 每 500ms 查 `agent_events` 的新事件，推给浏览器 |
| ⑥ | worker | 跑 ReAct 循环：每步落 `agent_events`、工具调用落 `agent_tool_calls`、工件落 `artifact` 事件 |
| ⑦ | 浏览器 | 增量渲染消息 / 工具卡 / 工件卡 |
| ⑧ | worker | `finishRun` → `succeeded`/`failed`，同步 `Task`，会话回 `idle` |
| ⑨ | 浏览器 | 右栏工件可点击，跳现有模块精修 |

### 3.3 SSE 轮询的两个必须实现的细节

**(1) 终止条件（不做则页面挂着就无限空转）**

会话内**没有** `pending`/`running` 的 Run 时，间隔从 500ms 降到 **5s**，且只查「有没有新 Run 出现」；一旦发现新 Run，切回 500ms 快查。实现时把「间隔决策」抽成纯函数以便单测（D25）。

**(2) 查询形态与索引**

```sql
SELECT * FROM agent_events
WHERE id > $lastId AND run_id = ANY($runIds)
ORDER BY id LIMIT 200
```

已核对：`agent_events` 的主键 `id` 与 `@@index([runId, id])` 恰好覆盖此查询，**不需要新增索引**。

### 3.4 一处公共层改动

现有 `handle()` 包装器的类型是 `RouteHandler = (req, ctx) => Promise<NextResponse> | NextResponse`（`src/lib/server/core/route.ts:16`），而流式响应返回的是普通 `Response`。

**改法**：把类型加宽为 `Promise<Response> | Response`。因为 `NextResponse extends Response`，对现有 **148 个路由完全无影响**，只是让 SSE 路由也能复用同一套错误处理。

---

## 四、接口契约

均位于 `src/app/api/agent/`，请求/响应体用 `snake_case`（D13），统一套 `handle()` 包装（含 SSE 路由，见 3.4）。

| # | 方法 | 路径 | 说明 |
|---|---|---|---|
| 1 | GET | `/api/agent/conversations` | 会话列表（左栏）|
| 2 | POST | `/api/agent/conversations` | 新建会话 |
| 3 | GET | `/api/agent/conversations/[id]` | 会话详情 + 消息（中栏历史）|
| 4 | POST | `/api/agent/conversations/[id]/messages` | 发消息 → 建 `AgentRun(pending)`，会话置 `running` |
| 5 | GET | `/api/agent/conversations/[id]/events` | **SSE 订阅**，支持 `last_event_id` |
| 6 | GET | `/api/agent/conversations/[id]/artifacts` | 工件列表（右栏）|
| 7 | POST | `/api/agent/runs/[runId]/cancel` | 取消 —— **仅 pending**（D19）|
| 8 | DELETE | `/api/agent/conversations/[id]` | 删除会话（DB 级联清消息与 Run）|

### 4.1 SSE 协议（接口 5）

```
GET /api/agent/conversations/[id]/events?last_event_id=123
Authorization: Bearer <jwt>
```

响应头：

```
Content-Type: text/event-stream
Cache-Control: no-cache, no-transform
X-Accel-Buffering: no
Connection: keep-alive
```

帧格式（与现有 `crawlXhsDataStream` 的 `data: ` 逐行解析一致）：

```
data: {"id":124,"type":"tool_execution_end",...}\n\n
: ping\n\n          ← 心跳，每 15s
```

**`id` 放在 JSON 载荷里**，而不是用 SSE 规范的 `id:` 字段 —— 因为客户端是手工解析（`fetch` + `ReadableStream`），与项目现有范式一致，且断线重连直接复用同一个 `last_event_id`。

**认证方式**：沿用 `fetch` + `Authorization: Bearer`（JWT 存 localStorage），**不用 `EventSource`** —— `EventSource` 无法携带自定义 header（P0 设计文档 §9.1 已定）。

### 4.2 取消语义（接口 7）

| Run 状态 | 行为 |
|---|---|
| `pending` | 置 `cancelled`，同步绑定的 Task 为 `failed`，返回 200 |
| `running` | 返回 **409**，响应体说明「已开始执行，P1 不支持中止运行中的任务」 |
| 终态 | 返回 **409**，说明已是终态 |

前端据此把「取消」按钮限制在刚发送后的窗口内，并对 409 给出可读提示。

### 4.3 工具调用卡片的摘要来源（D21 的落地）

`agent_tool_calls` **新增一列 `summary`**：

- 正常路径：在 `afterToolCall` 里用 `SkillDefinition.summarize(details)` 算出，与 `finalizeToolCall` 的更新一起写入
- 被阻断路径：在 `beforeToolCall` 里直接用 guard 返回的 `reason` 写入（**该路径不走 `afterToolCall`**，P0 已验证）

为什么必须新增列而不是读时计算：被阻断的行 `result` 为 `null`，可读原因只存在于 guard 的返回值中；落库时是唯一同时握有「工具 + 结果 + 原因」的时刻。

### 4.4 首屏契约与去重边界（避免「历史与 SSE 渲染两遍」）

**接口 3 是一次请求拿到整屏首屏数据**，响应体：

```jsonc
{
  "conversation": { "id": 12, "title": "露营选题", "status": "running" },
  "messages":   [ /* 中栏历史 */ ],
  "tool_calls": [ /* 已完成的工具调用，含 summary（4.3）*/ ],
  "artifacts":  [ /* 右栏历史工件 */ ],
  "latest_event_id": 1234          // ← 关键：SSE 的续传起点
}
```

`latest_event_id` = 该会话全部 Run 的 `agent_events.id` 最大值（无事件时为 0）。前端拿它作为 SSE 的 `last_event_id`，**只渲染 id 大于它的事件** —— 这一条同时解决了两个问题：

1. 首屏拉历史与订阅 SSE 之间存在时间窗，窗口内的事件不会重复渲染
2. 页面刷新后的断线重连天然复用同一套逻辑

**接口 6（`/artifacts`）的定位**：仅供右栏**单独刷新**用（用户手动刷新、或只想重取工件时），不参与首屏 —— 首屏的工件已由接口 3 一并返回。两个接口返回同一形状的工件数组，**不要在两处各写一份序列化逻辑**。

---

## 五、前端结构

### 5.1 路由与导航

- 新增 `src/app/(protected)/agent/page.tsx`（三栏容器）
- `src/components/layout/app-shell.tsx` 的 `mainNavItems` 新增一级入口「Agent 工作台」→ `/agent`（P0 设计文档 D6：Agent 是跨模块总入口，不埋在 xhs 平台下）

### 5.2 组件划分

沿用 P0 设计文档 §9.4 的 8 个划分，无需调整：

```
src/app/(protected)/agent/page.tsx
src/components/agent/
  ├── conversation-list.tsx     左栏：会话列表 + 新建
  ├── message-stream.tsx        中栏：消息流 + 自动滚动
  ├── message-bubble.tsx        用户/助手气泡
  ├── tool-call-card.tsx        工具卡片：状态、耗时、摘要、可展开详情
  ├── thinking-indicator.tsx    执行中态
  ├── artifact-panel.tsx        右栏：工件聚合（常驻 + 空态，D20）
  ├── artifact-card.tsx         工件卡片（点击跳对应模块）
  └── use-agent-events.ts       SSE 订阅 + 重连
```

UI 复用 antd 6，不引新 UI 依赖；状态用 `useReducer`，不引状态库。

### 5.3 状态归并（D25：逻辑抽成纯函数）

单一状态树：`{ messages, toolCalls, artifacts, runStatus }`。

**两个输入源必须严格分工**，否则会重复渲染：

| 来源 | 负责 |
|---|---|
| `GET /api/agent/conversations/[id]`（首屏，契约见 §4.4）| 历史消息 + 历史工具调用 + 历史工件，并给出 `latest_event_id` |
| SSE 事件流 | **只处理 `id > latest_event_id` 的事件** |

首屏拉历史与订阅 SSE 之间存在时间窗，不加此约束则窗口内的事件会被渲染两遍（历史一次、SSE 一次）。§4.4 已把该边界固化成接口契约。

**工具调用必须按 `tool_call_id` 归并更新，而不是按事件追加。** 存在一种跨界情形：某次工具调用的 `tool_execution_start` 早于 `latest_event_id`（因此已包含在首屏 `tool_calls` 里，状态为 `running`），而它的 `tool_execution_end` 晚于该分界（只从 SSE 到达）。若按事件追加，这张工具卡会出现两次（一次卡在「运行中」、一次「成功」）。归并键是 `tool_call_id`：已存在则**更新状态**，不存在才新增。

**抽成纯函数**（放 `.ts`，用现有 vitest 覆盖）：

- `reduceAgentEvents(state, events) → state`：事件 → 状态树
- `nextPollInterval(state) → number`：500ms / 5s 降速判定
- 归并去重判定（上述 id 边界规则）

`tool-call-card` 的 4 种状态必须都渲染：**运行中 / 成功 / 失败 / 被护栏阻断**（最后一种 P0 已实现，最容易被前端漏掉）。

### 5.4 自动滚动

消息流自动滚动到最新。因为右栏常驻（D20），布局宽度不随工件到达变化，不会与自动滚动打架；新消息到达时若用户已手动上滚，则暂停自动滚动并提示「有新消息」。

---

## 六、七个新工具

### 6.1 命名一致性

P0 的 D18 规定：skillKey 只能含 `[a-zA-Z0-9_-]`，且启动时由 `assertToolNamesProviderSafe()` 断言。P0 设计文档 §6.3 里这些工具写的是点号形式（`content.rewrite`），**本稿统一改为下划线形式**。

### 6.2 工具清单（riskLevel 逐个体证，不凭名字推断）

P0 曾因「凭技能名推断 riskLevel」标错 3 个（交接文档 §5.3）。以下每一项都读过函数体：

| skillKey | 名称 | risk | 实证依据 | 底层能力 | artifact |
|---|---|---|---|---|---|
| `content_rewrite` | 去 AI 味改写 | **write** | `api/ai/rewrite-note/route.ts:44` 执行 `aiDraft.update({ body })` —— 真的改草稿 | `OpenAICompatibleTextClient.rewriteNote` ✓ 已存在 | draft |
| `content_titles` | 标题生成 | **read** | service 纯返回 `string[]`；路由仅 `task.update`（进度日志，非产品数据）| `generateTitles` ✓ 已存在 | 无 |
| `content_tags` | 标签生成 | **read** | 同上 | `generateTags` ✓ 已存在 | 无 |
| `analytics_reports` | 分析报告读取 | read | `listExplosionReports` ✓ 已存在（被 `api/xhs/analytics/explosions/route.ts:4` 引用）| `exploration-service` | 无 |
| `kb_get` | 知识库读取 | read | `buildKbContext` ✓ 已存在 | `knowledge-base-service` | 无 |
| `library_search_notes` | 内容库检索 | read | ⚠️ **需新建 service** —— 查询逻辑目前内联在 `api/notes/route.ts`（144 行）| 见 6.4 | 无 |
| `library_note_detail` | 笔记详情+评论 | read | ⚠️ 同上 | 见 6.4 | 无 |

**订正 P0 设计文档 §6.3 的两处误标**：

- §6.3 把 `content.titles` / `content.tags` 标为 `write` + `produces: draft`，但**实际不写任何产品数据** —— 订正为 `read`，不声明 artifact。
- §6.3 把 `content.rewrite` 标为 `write`（正确），但未说明依据，本稿补上函数体证据。

### 6.3 设计决定：titles / tags 只返回数组，不落库

这样模型可以把结果直接喂给 `content_note_pack`（可组合），而不必先有 `draft_id` 才能用。这也与 service 方法的实际形状一致（返回 `string[]`）。

### 6.4 两个 library 工具需要先做抽取重构

`api/notes/route.ts`（144 行）把查询逻辑内联在路由里，且参数解析直接绑 `URLSearchParams`。要抽成 service（D5 要求工具调 service 而非路由），需：

1. 把查询逻辑抽成 service 函数，参数从 `URLSearchParams` 解耦为**类型化对象**
2. 路由改为调用该 service

**这不只是为了让工具能用** —— 抽完后路由与工具共用一份实现，而不是两处各写一遍筛选逻辑（与 P0 抽取 `skill-catalog` 同一模式）。

### 6.5 摘要文案

按 D21，**每个工具都要有 `summarize(result) → string`**，写进 `SkillDefinition`（与 `artifact` 同级）。这是选 D21 的既定成本，7 个新工具如数补齐。

---

## 七、测试与验收

### 7.1 测试策略

| 块 | 自动化 | 手工/脚本 |
|---|---|---|
| **A 接口层** | SSE 事件筛选（`id > lastId`）、降速规则、cancel 只对 pending 生效、`handle()` 加宽后无回归 | 脚本端到端：建会话 → 发消息 → 订阅 → 收完整事件序列 |
| **B 前端** | 归并 reducer + 降速判定（纯函数，D25）| 浏览器走完整链路：发消息 → 实时看到工具卡与助手文字 → 工件点击跳转 |
| **C 工具** | 7 个工具的 schema / 摘要 / riskLevel 断言 | 2 个走真实模型端到端，其余离线 |

### 7.2 验收清单

- [ ] `/agent` 出现在侧边栏且可访问
- [ ] 发消息后**无需刷新**即可看到工具卡与助手文字逐步出现
- [ ] 工具卡的 4 种状态（运行中/成功/失败/阻断）都渲染正确
- [ ] 工件卡片出现且点击能跳到对应模块
- [ ] 断线重连：刷新页面后历史完整，且不重复渲染
- [ ] 会话空闲时轮询降速（可通过日志或网络面板确认）
- [ ] 取消 pending 的 Run 返回 200 且 Run 变 `cancelled`；取消 running 的返回 409
- [ ] 7 个新工具可被模型调用，`agent_tool_calls` 有对应行
- [ ] `npx vitest run` 与 `npx tsc --noEmit` 全绿；`next build` 通过

### 7.3 回归要求

**P1 修改了 P0 已验收的代码，必须重跑 P0 验收** —— 见 §八 缺口 1。

---

## 八、前置条件、风险与已知缺口

### 缺口 1：中间过程的助手文本目前不落库（D23 的起因）

**两处代码证据**：

| 证据 | 事实 |
|---|---|
| `src/lib/server/agent/persist.ts:12,25` | `message_update` / `message_start` / `message_end` 三类事件落库时**正文被整个裁掉**，只留 `{ role, trimmed: true }`（仅 `message_end` 的 `usage` 例外）→ **`agent_events` 里没有任何消息文本** |
| `src/lib/server/agent/agent-loop.mts:485` | `persistMessage` **只有一处调用**，在循环结束后写最终答复 → **中间过程的助手文本从不落库** |

**后果**：P0 验收日志里看到的「我先查一下当前热点，再生成选题」这类模型预告，**数据库里根本不存在**。若不处理，P1 只能给前端「工具卡 + 最终答复」，与「过程实时可见」的验收标准冲突。

**修法（D23）**：改 `serializeEventForDb`，让 `message_end` 保留文本，`message_update` 继续裁掉。这是对 **P0 已验收代码**的修改，会影响已通过的用例，**必须单独把关并重跑 P0 验收**。

### 缺口 2：图片两个工具推后（D24）

不是「没时间」，而是**当前开发库没有 `modelType=image` 的模型**（实查 `model_configs` 仅 1 条 text 模型），做了也无法端到端验收。下一批做之前需：
1. 先在「模型配置」页添加一个 `modelType=image` 的默认模型
2. 扩展 `SkillContext`（目前只有 `{ userId, textClient, modelConfig, apiKey }`，**无任何图片模型字段**）
3. 复刻 `api/ai/images/generate-cover/route.ts` 里的编排：草稿归属校验 + 取图片模型（`imageModelContext`）+ 调用 + **落库为 `AiGeneratedAsset` 资产**（service 方法本身不做这些）

### 风险 3：`handle()` 是公共层

148 个路由共用。加宽类型后需确认零回归（`NextResponse extends Response`，理论上安全，但要有验证）。

### 风险 4：新增 skillKey 必须过 D18 断言

7 个新 skillKey 全部下划线形式；`assertToolNamesProviderSafe()` 会在启动时拦截违规名称。

### 风险 5：`content_rewrite` 会改用户草稿

它是 `write` 且直接改 `aiDraft.body`，没有撤销。P1 沿用 P0 的护栏分级（`write` 直接执行、产出进工件面板待验收），但**应在 `agent.md` 提示词里要求模型改写前说明将修改哪篇草稿**。

---

## 九、与 P0 设计文档的关系

| P0 文档位置 | 本稿的关系 |
|---|---|
| §9.1 认证方式 | 沿用（`fetch` + Bearer，不用 `EventSource`）|
| §9.2 接口表 | 沿用 8 个，其中 cancel 语义按 D19 收窄 |
| §9.3 轮询唤醒 | 沿用 D15（worker 3s 轮询），本稿新增 SSE 侧的 500ms/5s 双速轮询 |
| §9.4 组件结构 | 沿用 8 个划分，无调整 |
| §9.5 工件数据来源 | 沿用（`afterToolCall` 落 `artifact` 事件）|
| §6.3 工具清单 | **订正两处 riskLevel 误标**（见 6.2）|
| §12 分期交付 | P1 内容按本稿执行；cancel 以 D19 为准 |

---

## 十、建议实施顺序

三块可独立交付、独立验收。建议顺序：

1. **A 块（接口层）** —— 先做，因为 B 块依赖它联调；且可用脚本独立验收，不需要前端
2. **C 块（7 个工具）** —— 与 A、B 无依赖，可并行；其中 2 个 library 工具先做抽取重构
3. **B 块（前端）** —— 最后做，依赖 A

**D23 的修改（§八 缺口 1）应在 A 块之前完成** —— 它是 A 块 SSE 能推出有用内容的前提，且要重跑 P0 验收，越早越好。

---

## 附：本稿引用的实测证据

| 结论 | 证据位置 |
|---|---|
| SSE 服务端无先例可抄 | 全项目 0 处 `new ReadableStream`/`controller.enqueue`；`/api/xhs/crawl/data`（`src/lib/api.ts:421` 所 POST 的路由）**不存在** |
| `handle()` 不支持流式 | `src/lib/server/core/route.ts:16` |
| `SkillContext` 无图片模型字段 | `src/lib/server/agent/skill-catalog.ts:224` |
| 图片模型是独立配置 | `src/app/api/ai/shared.ts:62` → `getDefaultImageModel` |
| 库中无 image 模型 | 实查 `model_configs`：仅 1 条 `modelType: "text"` |
| `content_rewrite` 写库 | `src/app/api/ai/rewrite-note/route.ts:44` |
| `content_titles/tags` 不写产品数据 | 两路由仅 `task.update`（第 32 行） |
| notes 查询内联在路由 | `src/app/api/notes/route.ts`（144 行，无对应 service 文件）|
| `listExplosionReports` 已存在 | `src/lib/server/exploration-service.ts`（被 `api/xhs/analytics/explosions/route.ts:4` 引用）|
| 中间助手文本不落库 | `persist.ts:12,25` + `agent-loop.mts:485` |
| `agent_events` 索引足够 | `prisma/schema.prisma` 的 `AgentEvent` 主键 `id` + `@@index([runId, id])` |
| 无前端测试基础设施 | `vitest.config.*`（`environment: "node"`，`include: ["src/**/*.test.ts"]`）；devDependencies 无 testing-library/playwright/cypress |
