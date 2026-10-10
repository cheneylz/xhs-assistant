# 交接说明：Agent 工作台 P1-B（前端三栏界面 + SSE 实时过程）

- 交接日期：2026-10-10
- 分支：`feat/agent-p1b-ui`（从 `main` 的 `539f041` 切出，**未推送**）
- 状态：**B 块已完成并验收**（12 个任务 + 10 个补丁提交）；**C 块（7 个新工具）未开始**

---

## 一、一句话现状

`/agent` 三栏工作台在浏览器里可用：左栏会话列表、中栏消息流（助手 markdown 文本 / 提示行 / 4 状态工具卡 / 思考指示）、右栏产出物面板；SSE 实时推进（fetch + ReadableStream、500ms/5s 双速重连、身份幂等归并）。A 块接口层未改动（唯一的服务端改动是 `hot_refresh` 的原因透传，见 §五）。

## 二、交付物

| 文件 | 内容 |
|---|---|
| `docs/superpowers/plans/2026-10-10-agent-workspace-p1-b-ui.md` | **B 块实施计划**（12 任务 + 9 个补丁章节 +「验收发现修复」）。文首「执行进度」表是逐任务提交索引；§二 偏差表 D1–D9 解释了所有偏离设计稿的决定 |
| `src/lib/agent/agent-state.ts` | **前端状态归并的唯一真相源**（纯函数，42 条用例）：快照整体替换、事件帧身份幂等归并、SSE 缓冲解析、reducer、`runStatusFromRuns` |
| `src/lib/agent/tool-card-view.ts` | 工具卡展示派生（状态映射 / 耗时 / 截断与序列化，9 条用例）；§7.2 第 3 条的自动化守卫 |
| `src/components/agent/use-agent-events.ts` | SSE 订阅 hook（连接 / 解析 / 降速重连 / `agent_end` 回调） |
| `src/components/agent/*.tsx` | 7 个组件（conversation-list / message-stream / message-bubble（markdown）/ tool-call-card / thinking-indicator / artifact-panel / artifact-card） |
| `src/app/(protected)/agent/page.tsx` | 三栏容器与全部接线（366 行） |
| `src/components/agent/message-bubble.test.ts` | 首个 `.tsx` 组件测试（`react-dom/server` 直出；含 XSS 回归守卫） |
| `src/scripts/agent-ui-seed-toolcard.ts` | 工具卡验收夹具（`add [blocked\|failed]` / `remove`） |

## 三、实测确认（A 块契约在浏览器/脚本下逐条验证）

| 契约假设 | 实测结论 |
|---|---|
| SSE 帧格式 `data: <json>`、心跳 `: ping`、`id` 在载荷里 | ✅ 一轮约 1200–1500 帧，绝大多数是 `message_update` 噪声；忽略未知类型即可 |
| 首屏「十个字段」 | ✅ 端到端脚本断言一致（`agent-api-smoke.ts` 第 5 项） |
| 四条渲染规则 | ✅ 成立：`messages` 只含 user；助手文本只认 `message_end`（role+text 双判，SSE 与首屏共用同一函数）；工件只认 `artifacts`/artifact 帧；容忍「有帧无卡」 |
| `latest_event_id` 去重边界 | ✅ 以它为起点重连收不到旧帧（脚本第 6 项）；前端另做**身份幂等**兜底（见 §四 D1） |
| 工具卡 4 种状态 | ✅ 四种都渲染（`blocked`/`failed` 用夹具确定性验收；`not_executed` 归失败样式，摘要带「未执行：」） |
| 降速：执行中 500ms / 空闲 5s | ✅ 服务端为快查节奏；前端重连间隔同用 `nextPollInterval`（Console 可见 `[agent] 5000ms 后重连 SSE`） |
| 取消：pending 200 / running 409 | ✅ 脚本第 7 项 + 浏览器入口（409 会 toast 并自动重同步） |
| 一轮运行的体感耗时 | ✅ 约 20–30 秒（真实模型 + 3 次工具调用） |

**验收清单（§7.2 第 1–6 条）**：第 1/2/4/6/7 条用户已在浏览器确认；第 3 条四种状态已确认；第 5 条（刷新不重复）与两条针对性竞态（发送后切会话、输入法回车）在终验小修后待用户最后扫一眼。第 8 条属 C 块；第 9 条自动化全绿。

## 四、前端结构要点（改代码前先读这一节）

1. **两个输入源严格分工**：首屏/重同步 = 快照**整体替换**（`applyFirstScreen`）；SSE = 逐帧**身份幂等归并**（`applyEventFrame`）。
2. **D1（与设计稿的最大偏差）**：不做「`id ≤ latest_event_id` 就丢弃」的水位门。原因是快照与在途帧的竞态会让 `agent_end`（唯一的结束信号）被永久跳过 → UI 卡「执行中」。改为身份幂等：时间线按事件 id 去重、工具卡按 **`runId:toolCallId` 复合键**、工件按 `event_id`。`lastEventId` 只作重连起点 + 单调推进。
3. **两条必须维持的不变量**（`page.tsx` 文件头也有）：
   - **快照 ↔ 重连配对**：应用快照会把水位回退到快照值（`applyFirstScreen` 有意不取 max），所以**每次应用快照后必须 `streamKey + 1` 重连**、从快照水位重放 —— 已收进 `applySnapshot(id, detail)` 一处，别再另写第三条路径。
   - **执行中每 5s 兜底校正**：`settleRunStatus` 只发 `runStatus` 动作（不动时间线/水位/工件、不重连），覆盖「快照恰落在 `agent_end` 与 `finishRun` 之间」的毫秒级窗口（该窗口重连补不回结束信号）。
4. **竞态守卫成组出现**：所有 `await` 之后都要比对 `selectionRef.current !== id`（发送 / 取消 / 右栏刷新 / 重同步 / 详情加载五处），否则会把 A 会话的响应写进 B。
5. **memo 是一套约定**：`MemoMessageStream`（页面里 `memo(MessageStream)`）、`ToolCallCard`、`ArtifactPanel`、`MessageBubble` 都 memo 化，前提是调用方传**稳定引用**（`page.tsx` 的 `onRefresh={handleRefreshArtifacts}` 等；内联箭头会让 memo 永远失效）。
6. **SSE hook 的 ref 模式**：`lastEventId`/`hasActiveRun`/两个回调走「最新值 ref」，effect 依赖只有 `[conversationId, streamKey]` —— **不要把值加进依赖数组**（会让每帧重连）。
7. 时间语义：`created_at` 是「朴素上海墙钟」`YYYY-MM-DDTHH:mm:ss`，字典序即时间序；展示一律切片，**不要 `new Date()` 解析**。
8. 助手文本走 `react-markdown` + `remark-gfm`（用户消息保持纯文本）；样式块在 `globals.css` 的 `.agent-markdown`（不要在组件里内联 markdown 元素样式）。

## 五、本轮修复（验收发现）

| # | 问题 | 处置 |
|---|---|---|
| 1 | 助手回复的 markdown 原生语法未解析 | 加 `react-markdown@10` + `remark-gfm@4`（+153.6KB / gzip 47KB，只进 `/agent` 路由 chunk），助手气泡渲染 markdown；`MessageBubble` 补 memo；3 条渲染用例（含 XSS 守卫） |
| 2 | `hot_refresh` 总是返回空 | 根因是**数据侧**：`keyword_groups = 0` 且 `hot_topics = 0` → 无种子关键词（`seedKeywords` 的兜底是「上期榜单 TOP10」，首次为空是必然）→ 返回 `collected: 0` + reason；**执行器曾把 reason 吞掉**。已改为透传 `reason`/`snapshotTime`，摘要显示「收录 0 条热点（无种子关键词，请先配置关键词组）」。**要让 hot_refresh 真正出数：去「关键词组」页配几个词**（30 分钟的 `hot_topics_runner` 走同一路径） |
| — | 环境缺口 | `vitest.config.ts` 加 `esbuild: { jsx: "automatic" }`（项目 `jsx: "preserve"` 会让首个 `.tsx` 测试挂 `React is not defined`）—— 后续组件测试直接可用 |

## 六、本机陷阱（复述，照抄）

1. **停 worker 必须按进程树清**（`TaskStop`/杀父进程都杀不掉子 `node`；残留 worker 会用旧代码领任务）：
   ```powershell
   Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
     Where-Object { $_.CommandLine -like '*worker/index.mts*' } |
     ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
   ```
2. **跑 `next build` / `prisma generate` 前先停 dev server**；build 后要 `rm -rf .next` 再起 dev（否则未编译过的路由稳定 500）。
3. **命令行传中文会损坏字节**（用 UTF-8 文件 + `git commit -F` / `curl --data-binary @file`）。
4. **改了 worker/loop/persist/catalog 必须重跑 `npx tsx src/scripts/agent-smoke.ts`**；改了接口层必须重跑 `agent-api-smoke.ts`。

## 七、已知局限与遗留项（P1 明确接受）

**归并/排序类**
- 同秒内「工具结束 → 下一条助手文本」的**回放排序**可能把文本排在卡片前（只影响首屏/重同步回放；直播按到达顺序）。
- 快照与 `agent_end` 的毫秒级窗口由 `settleRunStatus` 收敛；**I1 的第二窗口**（resync 在途时发送 → 该快照不含刚发的消息 → 被整体替换）已登记：对人手几乎不可达（执行中输入框禁用、发送清草稿），收口改法见计划 §七。
- `settleRunStatus` 的过期响应竞态：无害且自愈（再发 409 → 自动重同步）。
- 重复应用同一 `tool_execution_*` 帧是**值幂等而非引用幂等**（一次多余重渲染）；`memo` 命中率描述略乐观，无正确性影响。

**展示/数据类**
- **直播与首屏 DTO 的两处差异**（都由重同步收敛）：① SSE 帧不带 `status`/`error_type`，护栏阻断在直播里先显示为「失败」（摘要仍含「已阻断」）；② 失败调用的展开详情（错误文本）只有 DTO 里有 —— 若将来 `publish` 级技能落地，考虑让 SSE 出口连 `status`/`error_type` 一起补。
- 接口 6（工件）只返回 `{ items }`，无截断标记 → 右栏手动刷新后截断提示可能过期。
- 接口 3 无字段过滤：`settleRunStatus` 每 5s 拉的是**完整首屏契约**（只为读 `runs`）。
- 工具卡截断文案有一处纳秒级竞态（`upsertToolCard` 应用帧结果时不清 `resultTruncated`）；两个 4000 的口径不同（服务端紧凑 JSON / 前端 pretty-print）；服务端的 `slice` 有把代理对切半的风险（只修了前端）。
- 不显示 `step_count`/token 进度与 `task_id` 深链（实时不可得，留 P2）。

**交互/可访问性类**
- 全站列表项不可键盘访问（`div onClick`，与既有页面一致）；工件卡跳转用 `router.push` 而非 `next/link`（无 cmd/中键新开标签）。
- 窄视口：三栏固定宽约 880px（中栏 `minWidth: 420` 兜底），舒适使用建议视口 ≥1280。
- 自动滚动的上滚信号：滚轮有同步 `onWheel`，触摸/键盘仍依赖异步 scroll 事件（窗口极窄）；内容不足一屏时上滚可能短暂弹一次「有新消息 ↓」。
- 会话行时间戳不带年份；组件内时间切片未归口 `src/lib/time.ts`；三栏圆角 10 与项目 token 12 不同（有意）。
- 左栏「执行中」标记只随列表接口更新（非当前会话在后台跑完时其标记会滞留到用户切到它）。
- 详情加载失败时中/右栏显示空态文案而非「加载失败」；`syncedId` 保持 null → 输入区禁用且提示「正在加载会话…」（措辞在失败态下不准确）；重新点选该会话可恢复。

**会话/鉴权类**
- SSE 的 401 在 refresh 失败后停流（fail-safe），而 `clearAuthTokens()` 不通知 `use-auth`，**路由守卫不会跳登录** —— 用户可见行为是「工作台不再实时更新」，恢复手段是手动刷新页面（根治需让 `clearAuthTokens` 通知 `use-auth`，属跨页面的独立改进）。
- `refreshAccessToken` 自身也走 axios 实例，refresh token 失效时会多一次无谓往返（`_authRetry` 限一次）。

**建议的独立改进项**
- **页面级竞态守卫加 jsdom 挂载冒烟测试**：`jsdom` 已在 devDependencies，vitest 现支持 `.tsx`（`esbuild.jsx: automatic` 已就位），用 `react-dom/client` + 假 fetch 流即可；本轮审查正是靠它复现了 4 个接线层缺陷（其中 2 个会丢用户输入），纯函数测试结构上抓不到这一类。是否引入属产品决策（D25 说不引前端测试栈）。
- `package.json` 的 `db:import` 指向不存在的 `src/scripts/import_old_db.ts`（悬空引用，与 B 块无关）。

## 八、C 块（下一个块）的决策点

1. **「阻断」工具卡状态的生产可及性**：要让它可见需引入一个 `publish` 级技能（跨块产品决策）—— 当前靠夹具验收。
2. **`content_rewrite` 的护栏**：它是 `write` 且直接改用户草稿、**无撤销**（P1 沿用「write 直接执行、产出进工件面板待验收」），需要确认是否维持，并在 `agent.md` 里加「改写前说明将修改哪篇」的要求。
3. `library_search_notes` / `library_note_detail` 需先把 `api/notes/route.ts` 的内联查询抽成 service（设计稿 §6.4）。

## 九、推送与收尾

- 本分支共 **50 个提交**（`git log --oneline 539f041..HEAD | wc -l`），**未推送**；push 一贯由你本人执行。
- 收尾按 `superpowers:finishing-a-development-branch` 走：本地合并回 `main`（推荐）或保留分支。
- 环境：dev server（:3000）与 worker 都在后台跑着（worker 已用最新代码重启）；停 worker 用 §六.1 的命令。
