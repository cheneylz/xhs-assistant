# 交接说明：Agent 工作台 P1（A/B/C 三块）全部完成

- 交接日期：2026-10-10（**C 块收尾当日刷新：本文件由「只剩 C 块」的总交接改写为 P1 收口版**）
- 分支：`feat/agent-p1c-tools`（**本地分支，未推送**；push 一律由用户本人执行，既定分工）
- 状态：**P1（A 块接口层 / B 块前端三栏 / C 块 7 个新工具）全部完成，等待推送**。C 块关键提交区间：`b80b3f7`（Task 1 抽 note-service）→ `9a731e0`（Task 10a 全分支终审修复），共 15 个功能提交；其后是收口文档提交（见 `git log --oneline aec83b6..HEAD` 尾部）

**本文件的性质**：P1 的**收口总交接** —— C 块结论与三处关键偏差、验收总清单的证据链、遗留项 R1–R10 与独立改进项、以及下一位接手者最需要的**运行时状态**。C 块的详细任务明细与逐条审查结论见其计划（执行进度表 16 行全绿）。

---

## 一、接手时先读这几份（按顺序）

| # | 文件 | 为什么 |
|---|---|---|
| 1 | **本文档** | P1 收口：C 块结论/偏差、验收证据链、R1–R10、运行时状态 |
| 2 | `docs/superpowers/plans/2026-10-10-agent-workspace-p1-c-tools.md` | C 块计划与执行进度表（16 行全绿）；文末 R1–R10 的原始登记（含证据与文件行号） |
| 3 | `docs/superpowers/HANDOFF-agent-p1a.md` | **唯一权威的接口契约**（实测值）+ §五 本机陷阱 |
| 4 | `docs/superpowers/HANDOFF-agent-p1b.md` | B 块交接：前端结构、竞态守卫约定、§七 已知局限（§八 决策点已被 C 块拍板，结论见本文 §二） |
| 5 | `docs/superpowers/specs/2026-10-09-agent-workspace-p1-design.md` | P1 设计稿：§六 工具清单、§7.1 测试策略、§7.2 验收清单 |
| — | `docs/superpowers/plans/2026-10-10-agent-workspace-p1-b-ui.md` | B 块计划：**任务粒度与两段审查写法的模板**（C 块计划即照此写） |

### 当前状态（实测，C 块收尾后）

- 基线：`npx vitest run` = **30 文件 / 359 用例全绿**；`npx tsc --noEmit` 无输出；`npx next build` 成功（产物含 `/agent`）
- 三个端到端脚本**全部通过**（本机实证）：`src/scripts/agent-smoke.ts`（P0）、`src/scripts/agent-api-smoke.ts`（P1-A 9/9）、`src/scripts/agent-c-tools-smoke.ts`（C，真模型两轮）
- 技能目录 **13 个**（P0 的 6 个 + C 新增 7 个），全部有执行分支；「目录已登记却缺执行分支」由 `default:` 分支的运行时守卫响亮拦截
- 测试基建（B 块引入，继续可用）：`vitest.config.ts` 有 `esbuild: { jsx: "automatic" }`；依赖里有 `react-markdown` + `remark-gfm`（**只用于助手气泡的 markdown 渲染，工具摘要仍是纯文本一行**，不要往 summarize 里塞 markdown）
- 验收夹具：`src/scripts/agent-ui-seed-toolcard.ts`（`add blocked|failed` / `remove`）—— 「阻断」状态在 P1 生产不可达，靠它做确定性验收

---

## 二、C 块：7 个新工具（已完成）

**结论**：Agent 可调用工具从 6 个扩到 13 个（设计稿 §六）。7 个新工具全部落进 `SKILL_CATALOG`（含必备的 `summarize` 与 `artifact` 声明）+ `TOOL_SCHEMAS` + `executeSkill` 的执行分支；两个 `library_*` 工具先把 `api/notes` 路由内联的查询逻辑抽成 `note-service.ts`，路由与工具共用一份实现。验收方式：2 个走真模型端到端，其余 5 个离线覆盖（schema / 摘要 / 参数映射与空结果 reason）。

| skillKey | 名称 | risk | 底层能力 | 验收方式 |
|---|---|---|---|---|
| `content_rewrite` | 去 AI 味改写 | **write** | `textClient.rewriteNote` | **真模型 e2e**（C 脚本第 2 条路径） |
| `content_titles` | 标题生成 | read | `textClient.generateTitles` | 离线 |
| `content_tags` | 标签生成 | read | `textClient.generateTags` | 离线 |
| `analytics_reports` | 分析报告读取 | read | `exploration-service.listExplosionReports` | 离线 + P0 真模型自发调用 |
| `kb_get` | 知识库读取 | read | `knowledge-base-service.buildKbContext` | 离线 + P0 真模型自发调用 |
| `library_search_notes` | 内容库检索 | read | `note-service`（新建） | **真模型 e2e**（C 脚本第 1 条路径） |
| `library_note_detail` | 笔记详情+评论 | read | `note-service`（新建） | 离线 |

**三处关键偏差**（计划 §二 的 D-C1/C2/C3，实施按「本计划为准」落地）：

| # | 原方案 | 实际采用 |
|---|---|---|
| D-C1 | 设计稿 §6.4：抽查询逻辑成 service，路由改为调用该 service | **七条笔记路由的序列化副本一并去重**：除工具直接使用的路由外，`batch-save` / `batch-tag` / `export` / `[noteId]/assets` 里的本地副本也删除改 import（哈希证据：5 份 `serializeNote` 的 md5 全等于 `440de036c90ee5a1e82b690056268d07`）；`batch-create-drafts` 的 `getOwnedNote` 是另一形态，未动 |
| D-C2 | 设计稿未提 `content_rewrite` 的工件标题 | `extractArtifacts` **扩展支持字符串 `titleField`**（单产出取该字段本身，+2 单测），工件卡显示「《草稿标题》」而不是「去 AI 味改写 #12」 |
| D-C3 | 设计稿 §7.1：2 个工具走真实模型端到端，未指定是哪 2 个 | 选**风险最高的两条路径**：`library_search_notes`（唯一需要先做抽取重构的读工具）+ `content_rewrite`（唯一 write 工具，直接覆盖用户草稿） |

**决策点（C 块开工前已拍板，留档）：**

- D-C0-a：「阻断」可见性 —— **不引入 publish 级技能**，继续用夹具 `agent-ui-seed-toolcard.ts` 验收（引入 publish 属跨块产品决策，留 P2）
- D-C0-b：`content_rewrite` 护栏 —— **沿用「write 直接执行、产出进工件面板待验收」**；`agent.md` 补「改写前先说明将修改哪篇草稿」（工作方式第 5 条）
- D-C0-c：图片两个工具 —— **确认推后**（D24：开发库没有 `modelType=image` 的模型）
- D-C0-d：library 抽取范围 —— **只把查询逻辑抽成 service**；HTTP 参数解析与 422 校验留在路由

**仍然适用的约束**：单测不得触达外部 API（`hot_refresh` 会打真实小红书接口）；`hot_refresh` 想真正出数需先在「关键词组」页配词（`seedKeywords` 的兜底是上期榜单 TOP10，两者皆空时必为 0）。

---

## §二·补 P1-D：会话删除（前端）

- **日期**：2026-10-10；状态：**已实现，待用户浏览器点验**（设计见 `docs/superpowers/specs/2026-10-10-agent-conversation-delete-design.md`，计划见 `docs/superpowers/plans/2026-10-10-agent-conversation-delete.md`）
- **改动**：服务端零改动（接口 8 已存在）；前端 4 处 —— `api.ts` 的 `deleteAgentConversation`、`globals.css` 的 `.agent-conv-delete` 悬停显隐、`conversation-list.tsx` 的行内删除 + Popconfirm、`page.tsx` 的 `handleDelete`（删当前选中会话时清空工作台）
- **已知取舍**：① 运行中的会话不做前端禁用，以服务端 409 + 拦截器 toast 为准（左栏「执行中」标记来自快照、可能滞后）；② 删除入口默认隐藏，悬停会话行**或键盘 Tab 到该按钮**时出现（用 opacity + pointer-events 而非 visibility —— 后者不可聚焦，已用 headless Chrome 实测过两条路径）；触屏用户仍走不到（与全站列表项不可键盘访问的历史局限同源）
- **回归**：`vitest` 30 文件 / 359 用例、`tsc` 无输出、`next build` 通过、`agent-api-smoke.ts` 9/9（接口层无回归）
- **验收**：浏览器点验 3 步 + 1 反向（清单见计划 Task 2 Step 5）——悬停出图标并删一个非当前会话 / 删当前会话回空态 / 删执行中的会话被 409 拦下

---

## 三、B 块（已完成，仅供参考）

B 块（前端三栏界面 + SSE 实时过程 + 两项验收修复）已合并到 `main` 并推送，细节见 `HANDOFF-agent-p1b.md`。C 的新工具直接在 B 的三栏界面里被调用，而**界面无需为新工具做任何改动**：工件靠 `ArtifactSpec` 声明（`kind`/`idField`/`hrefPrefix`）、卡片靠 `summarize` —— 两者都在 `SkillDefinition` 里。

---

## 四、验收总清单（设计稿 §7.2 逐条对账）

| # | 验收项 | 现状 |
|---|---|---|
| 1 | `/agent` 出现在侧边栏且可访问 | ✅ **B 已完成** |
| 2 | 发消息后**无需刷新**即可看到工具卡与助手文字逐步出现 | ✅ **B 已完成**（用户浏览器实测通过） |
| 3 | 工具卡的 4 种状态都渲染正确 | ✅ **B 已完成**（「阻断」由夹具确定性验收） |
| 4 | 工件卡片出现且点击能跳到对应模块 | ✅ **B 已完成**；C 的 `content_rewrite` 产出 draft 工件，事件落库与跳转 href 已在 C 脚本中验证 |
| 5 | 断线重连：刷新后历史完整且不重复渲染 | ✅ **B 已完成**（`latest_event_id` 起点 + 身份幂等归并） |
| 6 | 会话空闲时轮询降速 | ✅ 服务端由 A 完成；前端重连间隔同用 `nextPollInterval` |
| 7 | 取消 pending → 200、取消 running → 409 | ✅ **A 完成**（脚本第 7 项 + B 的前端入口） |
| 8 | 7 个新工具可被模型调用、`agent_tool_calls` 有对应行 | ✅ **C 已完成**，证据链：① C 脚本真模型跑通两条最高风险路径 —— `library_search_notes` 检索命中脚本种子笔记、行 succeeded、摘要非空；`content_rewrite` 草稿正文 60 → 158 字、`agent_tool_calls` 有 succeeded 行且 `draft_id` 正确、run 里落了 `kind=draft` 工件事件、事件时序证明「改写前已说明」；② 一次 P0 真模型运行里模型还**自发**调用了 `kb_get` / `analytics_reports` / `library_search_notes` 3 个新工具（非脚本点名）；③ 其余 5 个工具由离线单测覆盖 schema / 摘要 / 参数映射与空结果 reason |
| 9 | `vitest` / `tsc` / `next build` 全绿 | ✅ `vitest` **30 文件 / 359 用例**全绿；`tsc --noEmit` 无输出；`next build` 成功（产物含 `/agent`，build 后已 `rm -rf .next` 并重启 dev）；三个端到端脚本全过 |

---

## 五、环境与陷阱

**必读 `HANDOFF-agent-p1a.md` §五**（本机陷阱）。最常踩的四条：

1. **停 worker 必须按进程树清**（`TaskStop` 与杀父进程都杀不掉子 `node`；残留进程会用旧代码领任务，制造「改了代码行为没变」的假象）：
   ```powershell
   Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
     Where-Object { $_.CommandLine -like '*worker/index.mts*' } |
     ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
   ```
   （接手时先跑一次确认有没有上一会话的残留 worker；当前本机在跑的 worker 见 §七）
2. **跑 `next build` 或 `prisma generate` 前先停 dev server**（build 会覆盖 dev 的 `.next` → 未编译过的路由稳定 500，恢复要 `rm -rf .next` 再起）
3. **命令行传中文会损坏字节、多行 `tsx -e` 只跑首行**（提交信息用 `git commit -F <UTF-8 文件>`；需要中文请求体时写文件再 `curl --data-binary @file`）
4. **push 一律由用户自己执行**（本地提交/合并可以由你做）。B 块是收尾 fast-forward 合并回 `main` 再删分支；C 块在 `feat/agent-p1c-tools` 上完成，收尾按同一模式合并/推送（**尚未做，等用户**）

---

## 六、A/B/C 三块的流程经验（建议沿用）

C 块沿用同一流程：15 个功能提交 = 10 个任务 + 5 个补丁，每个任务两段审查；**全分支终审（Task 10a）仍抓到 3 组文本入参缺长度上限**（`instruction` / `title` / `body`），说明「整体终审」这一步不可省。

1. **每个任务走「实现 → 规格审查 → 质量审查」两段审查**（`superpowers:subagent-driven-development`）。B 块共修掉 10 余个真实缺陷，其中 2 个会丢用户输入（中文输入法回车误发、切会话串台丢草稿）
2. **审查者必须被要求「不要相信实现者的报告」并独立复核**（跑 HTTP/DB 探针、写 jsdom 挂载探针、读源码验证假设）。B 块最有价值的发现全部来自探针型审查
3. **质量审查要要求量化**：把「该不该 memo / 该不该抽函数」量化为数字（Profiler、探针计时），判断比争论可靠
4. **块收尾单独派一次「整体终审」**（看整个分支、不看单任务 diff）—— B 块的终审抓到了 4 个 per-task 审查结构上抓不到的跨文件问题；C 块终审同款（见上）
5. **给实现者的计划要含完整代码与预期输出**，并明确「认为有硬伤就停下报告，不要自行改进」；计划里的计数（用例数/文件数）是快照，执行时以「全绿」为准，但发现偏差要顺手订正计划
6. **审查发现的问题用「补丁提交 + 复审」收口**（并入下一个任务或独立提交），比当场返工干净；每块收尾跑全量：`vitest` + `tsc` + `next build` + 三个端到端脚本

---

## 七、运行时状态（2026-10-10 交接时，本机）

| 进程 | 状态 | 细节 |
|---|---|---|
| worker | **在跑（新代码，后台）** | 进程链：`npx tsx src/worker/index.mts` → `tsx/dist/cli.mjs` → 真正跑 worker 的 node（3 层）；C 块验收前按进程树清过并重启，加载的是含全部 13 个工具的新代码 |
| dev server | **在跑（:3000）** | `npm run dev`（`next dev` 监听 3000）；`/agent` 实测返回 200、`/api/agent/conversations` 无 token 返回 401（交接时复验过） |
| `.next` | 已清理后重启 | 终验 `next build` 后 `rm -rf .next` 再起 dev —— 否则 dev 下未编译过的路由稳定 500 |

**操作规矩**：

1. **停 worker 必须按进程树清**（`TaskStop` 与杀父进程都杀不掉子 `node`；残留 worker 会继续领任务、污染验收结果）：
   ```powershell
   Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
     Where-Object { $_.CommandLine -like '*worker/index.mts*' } |
     ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
   ```
2. **跑 `next build` 前先停 dev server**；build 完 `rm -rf .next` 再 `npm run dev`
3. push 由用户本人执行；`feat/agent-p1c-tools` 尚未推送，合并回 `main` 的时机由用户定

---

## 八、遗留项登记（R1–R10 与独立改进项）

计划文末「遗留项登记」的 R1–R10 原件（含证据、文件行号与改法建议）在 `docs/superpowers/plans/2026-10-10-agent-workspace-p1-c-tools.md`。一句话版：

| # | 一句话 | 状态 |
|---|---|---|
| R1 | `getOwnedNote`（归属 + 404）仍有 4 处副本 + Task 2 新加的 2 个薄包装；归口方案是**路由侧** shared helper（先例 `api/xhs/crawl/shared.ts`），不要进服务层（会引入 http-error） | 已登记（不修） |
| R2 | `GET /api/notes/abc` → 500（`parseInt` 出 NaN 直落 Prisma 校验错误；改造前后一致，属既有缺陷）；修法：7 条路由改用 `parsePathId`（返回 400） | 已登记（不修） |
| R3 | 路由侧 `searchNotes` 仍全量序列化（N 篇命中 ≈ `1+2N` 次查询）；`comments` 路由宣称 `page_size ≤ 200` 而 `paginated()` 硬顶 100 | Agent 工具路径**已修**（limit 下推）；路由侧已登记 |
| R4 | `serializeNote` / `serializeTag` 导出面比使用者宽 | 有意保留（协议层 API） |
| R5 | 过渡期「假成功」通道（目录已登记但执行分支未实现 → LLM 兜底假结果） | **已修**：过渡期护栏随 Task 7 删除，Task 8 起由 `default:` 分支的运行时守卫接手 |
| R6 | loop 侧数组一律截到 10 条、与工具 schema 上限脱节：`comment_limit ≤ 200`、`content_tags.count ≤ 20`、`analytics_reports.limit ≤ 20`、`library_search_notes.limit ≤ 20` | 已登记（不修；`comment_total`/`truncated` 不误导） |
| R7 | id 类参数守卫 **6 处**到复制粘贴临界点（含漏网的 `schedule_recommend.platform_account_id`，浮点会被 Prisma 截断）；`draft_id: true` 仍会静默解析成 1；注释错配（`script_generate` 写成 write 级）已在 C8 补丁修正 | 守卫已补齐 5/6；抽取已登记 |
| R8 | `content_rewrite` 空内容护栏在真实链路不可达（ai-service 遇空白直接抛错）；要真正生效应改到 `rewriteNote` 内部。**改法要点**：勿删空内容路径的 `draft_id`（summarize 依赖 `length: 0` 契约，删了摘要会变「未改动草稿 #0」） | 已登记（不修） |
| R9 | 模型可见的工具结果**体积无上限**：`afterToolCall` 的 `summarizeToolResult(details, 10)` 整段替换 content，架空 `TOOL_TEXT_LIMIT = 20_000`；且只截顶层数组、嵌套数组原样进上下文（`analytics_reports.sample_notes` 是首个可达路径；当前 dev 库 `explosion_reports` 为空故未暴露）。后果是上下文压力/成本，不是错误答案（`pruneByCharBudget` 兜底） | 已登记（不修） |
| R10 | 草稿页不消费 `?id=`（无 `useSearchParams`/`location.search`）—— 工件卡跳转只落在列表、不选中草稿；C 块新增第二处使用（`content_rewrite`） | 已登记（不修，前端 P2） |

**独立改进项（与 C 块无关，仍未做）**：

- **`docs/` 下没有「总的项目代码文档」**（CLAUDE.md 开发原则 4 要求维护一份）—— P0 起就缺，建议作为独立任务补，不要塞进下一块
- **B 交接 §七 的独立项**：页面级竞态守卫的 jsdom 冒烟测试（`jsdom` 已装、vitest 已支持 `.tsx`；是否引入属产品决策 D25）、让 `clearAuthTokens` 通知 `use-auth`（SSE 401 后路由守卫不跳登录）、接口 3 无字段过滤、`step_count`/token 进度与 `task_id` 深链等
- **`package.json` 的 `db:import` 悬空引用**：指向不存在的 `src/scripts/import_old_db.ts`（与 A/B/C 均无关）
