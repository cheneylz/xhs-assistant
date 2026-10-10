# 交接说明：Agent 工作台 P1 剩余工作（C 块 + B 块）

- 交接日期：2026-10-10
- 分支：`main`（**已推送，与 origin 同步**）
- 状态：**A 块（D23 + 接口层）已完成并推送；C 块（7 个工具）与 B 块（前端）未开始**

**本文件的性质**：给下一会话的**总交接** —— 只界定范围、依赖、风险与验收方式，**不含详细实施计划**。下一会话选定方向后，按 `superpowers:writing-plans` 写那一块的计划，再用 `superpowers:subagent-driven-development` 实施。

---

## 一、接手时先读这三份（按顺序）

| # | 文件 | 为什么 |
|---|---|---|
| 1 | **本文档** | 剩余工作的范围与决策点 |
| 2 | `docs/superpowers/HANDOFF-agent-p1a.md` | **唯一权威的接口契约**（实测值），含 **B 块必守的 4 条渲染规则**、已知局限表、本机陷阱 |
| 3 | `docs/superpowers/specs/2026-10-09-agent-workspace-p1-design.md` | P1 设计稿（D19–D25、§六 工具清单、§7.2 验收清单） |

`docs/superpowers/plans/2026-10-09-agent-workspace-p1-a-api.md` 是 A 块的实施计划，**文首的「执行进度」与「实施后订正」两张表**是了解「计划与最终实现差异」的入口；写 C/B 计划时不必通读全部任务。

### 当前状态（实测）

- 基线：`npx vitest run` = **24 文件 / 248 用例全绿**；`npx tsc --noEmit` 无输出；`npx next build` 通过
- 两个端到端脚本都可跑：`src/scripts/agent-smoke.ts`（P0）、`src/scripts/agent-api-smoke.ts`（A 块 9 项）
- 环境：dev server 在 3000 端口跑着；**worker 没跑**（要跑 `npx tsx src/worker/index.mts`，停之前先读陷阱第 1 条）
- 技能目录当前 6 个：`hot_refresh` / `topic_generate` / `content_note_pack` / `review_submit` / `script_generate` / `schedule_recommend`

---

## 二、C 块：7 个新工具

**目标**：把 Agent 可调用工具从 6 个扩到 13 个（设计稿 §六）。

| skillKey | 名称 | risk | 底层能力 | 备注 |
|---|---|---|---|---|
| `content_rewrite` | 去 AI 味改写 | **write** | `OpenAICompatibleTextClient.rewriteNote` ✓ | **会直接改用户草稿、无撤销** |
| `content_titles` | 标题生成 | read | `generateTitles` ✓ | 只返回数组，不落库（§6.3） |
| `content_tags` | 标签生成 | read | `generateTags` ✓ | 同上 |
| `analytics_reports` | 分析报告读取 | read | `listExplosionReports` ✓ | |
| `kb_get` | 知识库读取 | read | `buildKbContext` ✓ | |
| `library_search_notes` | 内容库检索 | read | ⚠️ **需新建 service** | 查询逻辑现内联在 `src/app/api/notes/route.ts`（144 行） |
| `library_note_detail` | 笔记详情+评论 | read | ⚠️ **同上** | 抽完让路由与工具共用一份实现 |

**必做的配套**（漏一个就会返工）：

1. 每个技能都要在 `SkillDefinition.summarize` 补一份摘要 —— **必填字段，漏写过不了 `tsc`**；`summarizeCount` 已导出且有单测钉死语义
2. 每个 skillKey 加进 `tool-schemas.ts` 的 `TOOL_SCHEMAS`（`assertSchemasComplete()` 会在启动时断言一一对应）
3. 新 skillKey 必须用**下划线**（P0 D18），`assertToolNamesProviderSafe()` 会拦截违规名
4. `src/prompts/agent.md` 补一条：`content_rewrite` 会改草稿，要求模型改写前说明将修改哪篇（设计稿 §八 风险 5）
5. **加完后要同步改两处既有断言**（预期内，不是回归）：`skill-catalog.test.ts` 的「包含全部 6 个预置技能」、`agent-loop.test.ts` 的「列出全部 6 个技能的 skillKey」

**验收**：单测覆盖 schema / 摘要 / riskLevel（risk 要**读函数体核**、不能凭名字推断 —— P0 曾因此标错 3 个）+ 其中 2 个走真实模型端到端（设计稿 §7.1 C 块）。对应验收清单第 8 条。

**决策点 / 风险**：

- **图片两个工具仍推后**（`image_generate` / `image_cover`）：设计稿 D24 —— 开发库没有 `modelType=image` 的模型，做了无法端到端验收；且需扩展 `SkillContext`、复刻路由里的资产落库编排
- **`content_rewrite` 无撤销**：P1 沿用「write 直接执行、产出进工件面板待验收」的护栏分级
- **「阻断」状态仍是生产不可达**：要让它可见就得引入一个 `publish` 级技能 —— 这是跨块的产品决策，**先问用户**
- 单测不得触达外部 API（`hot_refresh` 会打真实小红书接口）

---

## 三、B 块：前端三栏界面

**目标**：`/agent` 入口 + 三栏界面 + SSE 实时过程（设计稿 §五、D20/D21/D25）。**这一块做完，P1 才算「在浏览器里可用」。**

**范围**（8 个文件，antd 6 + `useReducer`，不引新 UI/状态依赖）：

```
src/app/(protected)/agent/page.tsx
src/components/agent/conversation-list.tsx    左栏：会话列表 + 新建
src/components/agent/message-stream.tsx       中栏：消息流 + 自动滚动
src/components/agent/message-bubble.tsx
src/components/agent/tool-call-card.tsx       4 种状态：运行中/成功/失败/被阻断
src/components/agent/thinking-indicator.tsx
src/components/agent/artifact-panel.tsx       右栏：常驻 + 空态（D20）
src/components/agent/artifact-card.tsx        点击跳对应模块
src/components/agent/use-agent-events.ts      SSE 订阅 + 重连
```

外加 `src/components/layout/app-shell.tsx` 的 `mainNavItems` 加一级入口「Agent 工作台」（Agent 是跨模块总入口，不埋在 xhs 平台下）。

**必做**：

1. **严格遵守 `HANDOFF-agent-p1a.md` §三 的 4 条渲染规则**（不遵守会重复渲染 / 空白气泡 / 漏卡片）
2. 复用现成的 `src/lib/agent/polling.ts`（`nextPollInterval`，零依赖、客户端可安全 import）
3. **纯函数抽出来用现有 vitest 覆盖**（D25：项目没有前端测试栈）：事件归并 reducer、降速判定、`id > latest_event_id` 的去重边界
4. 状态树 `{ messages, toolCalls, artifacts, runStatus }`，两个输入源严格分工（首屏 vs SSE）
5. 工具卡按 `tool_call_id` **归并更新**，不是按事件追加（跨边界情形见设计稿 §5.3）

**验收**：设计稿 §7.2 的第 1/2/3/4/5/6 条 —— 全是浏览器手工（无前端测试栈）。清单见 §五。

**踩过的坑（照抄即可）**：

- **SSE 会推全部事件类型**：一次运行约 1400 帧，绝大多数是 `message_update`/`message_start` 噪声（载荷只有 `{role, trimmed}`）。必须忽略未知类型；**若日后要在服务端按类型过滤，别把 `agent_end` 滤掉**（它是前端唯一可靠的结束信号）
- **刷新后要能取消 pending 的 Run**：runId 在首屏的 `runs` 字段里（已备好）
- **别只信 `conversation.status`**：它是前端的「执行中」信号，但服务端的真实准入判据是 409（`hasActiveRun`）
- **三来源的归并顺序**：`messages` / `events` / `tool_calls` 的 `created_at` 都是 `YYYY-MM-DDTHH:mm:ss` 格式，**按字符串字典序比较即时间序**
- **「阻断」状态演示不出来**（见 C 块的风险条），照实现即可

---

## 四、建议顺序

设计稿 §十 给的顺序是 **A → C → B**。但 A 已完成，剩下的两块：

- **C 与 B 之间没有依赖**（接口契约已冻结并实测），可任选
- **倾向先 B**：P1 的验收清单（§7.2）9 条里有 6 条是浏览器可观测的，而接口形状刚实测完 —— 这是写 B 计划的最佳时机（再往后接口可能因 C 块的改动而小幅变化）
- **倾向先 C** 的理由：它是纯后端、可脚本验收、不依赖人工点浏览器

**由你定。** 两块都不要跳过「写计划」这一步 —— 本次 A 块的经验是：计划写得足够具体（含完整代码与预期输出）时，子 agent 的实现几乎不需要返工。

---

## 五、验收总清单（设计稿 §7.2 逐条对账）

| # | 验收项 | 现状 |
|---|---|---|
| 1 | `/agent` 出现在侧边栏且可访问 | ⬜ 等 B |
| 2 | 发消息后**无需刷新**即可看到工具卡与助手文字逐步出现 | 数据侧已由 A 覆盖（端到端脚本第 4 项）；渲染待 B |
| 3 | 工具卡的 4 种状态都渲染正确 | ⬜ 等 B（「阻断」无数据可演示，见 §二 决策点） |
| 4 | 工件卡片出现且点击能跳到对应模块 | 接口已备好（首屏 `artifacts` 与接口 6 同源同形状，端到端脚本已断言一致）；渲染待 B |
| 5 | 断线重连：刷新后历史完整且不重复渲染 | 数据侧已由 A 覆盖（`latest_event_id` 边界，端到端脚本第 6 项）；渲染待 B |
| 6 | 会话空闲时轮询降速 | 服务端已实现并有单测（`polling.test.ts`）；前端侧待 B |
| 7 | 取消 pending → 200、取消 running → 409 | ✅ **A 已完成**（端到端脚本第 7 项） |
| 8 | 7 个新工具可被模型调用、`agent_tool_calls` 有对应行 | ⬜ 等 C |
| 9 | `vitest` / `tsc` / `next build` 全绿 | ✅ 当前 24 文件 / 248 用例；每块完成后重跑 |

---

## 六、环境与陷阱

**必读 `HANDOFF-agent-p1a.md` §五**（6 条本机陷阱）。最常踩的三条：

1. **停 worker 必须按进程树清**（`TaskStop` 与杀父进程都杀不掉子 `node`；残留进程会用旧代码领任务，制造「改了代码行为没变」的假象）
2. **跑 `next build` 或 `prisma generate` 前先停 dev server**（build 会覆盖 dev 的 `.next` → 未编译过的路由稳定 500；generate 会被 DLL 占用报 EPERM）。恢复方式：停 dev → `rm -rf .next` → 再起
3. **命令行传中文会损坏字节、多行 `tsx -e` 只跑首行**（需要发中文请求体时用 tsx 写 UTF-8 文件 + `curl --data-binary @file`）

---

## 七、本次（A 块）的流程经验，建议沿用

1. **每个任务走「实现 → 规格审查 → 质量审查」两段审查**（`superpowers:subagent-driven-development`）。本次共修掉 3 个用户可见缺陷，其中两个会让 UI 永久卡在「执行中」
2. **审查者必须被要求「不要相信实现者的报告」并独立复核**。本次最有价值的发现全部来自「真跑 HTTP/DB 探针」「读 Pi 源码验证假设」的审查者；只读 diff 的审查价值低得多
3. **给实现者的计划要含完整代码与预期输出**，并明确「认为有硬伤就停下报告，不要自行改进」
4. **验收脚本要能真的失败**（`assert` 抛错 + 退出码），且清理断言用「基线对比」而不是「绝对归零」—— 否则库里已有数据时会误报
5. **每块收尾跑全量**：`vitest` + `tsc` + `next build` + 两个端到端脚本；改动 P0 代码（loop / persist / worker）后**必须**重跑 `agent-smoke.ts`

---

## 八、仍然缺的东西（P0 起就有）

`docs/` 下**没有「总的项目代码文档」**（CLAUDE.md 开发原则 4 要求维护一份）。目前 `docs/` 只有 `superpowers/` 下的设计稿、计划与交接文档。建议作为独立任务补，不要塞进 C 或 B 里。
