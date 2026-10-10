# 交接说明：Agent 工作台 P1 剩余工作（只剩 C 块）

- 交接日期：2026-10-10（**B 块收尾当日刷新：A、B 均已完成并推送，本文件现在只服务 C 块**）
- 分支：`main`（`8377099`，**已推送，与 origin 同步**）
- 状态：**A 块（D23 + 接口层）、B 块（前端三栏界面）均已完成；只剩 C 块（7 个新工具）**

**本文件的性质**：给下一个会话的**总交接** —— 界定 C 块的范围、依赖、决策点与验收方式，**不含详细实施计划**。选定方向后，按 `superpowers:writing-plans` 写那一块的计划，再用 `superpowers:subagent-driven-development` 实施（B 块就是这么做的：12 任务 + 10 个补丁，每个任务两段审查，实现几乎无返工）。

---

## 一、接手时先读这几份（按顺序）

| # | 文件 | 为什么 |
|---|---|---|
| 1 | **本文档** | C 块的范围与决策点 |
| 2 | `docs/superpowers/HANDOFF-agent-p1b.md` | B 块收尾交接：前端结构、竞态守卫约定、已知局限；**§八 正是 C 块要拍板的决策点** |
| 3 | `docs/superpowers/HANDOFF-agent-p1a.md` | **唯一权威的接口契约**（实测值）+ §五 本机陷阱 |
| 4 | `docs/superpowers/specs/2026-10-09-agent-workspace-p1-design.md` | P1 设计稿：C 块看 §六、§7.1、D24 |
| — | `docs/superpowers/plans/2026-10-10-agent-workspace-p1-b-ui.md` | B 块计划：**写 C 计划时当模板**（任务粒度、完整代码、预期输出、验收对账与自查的写法） |

### 当前状态（实测，B 块收尾后）

- 基线：`npx vitest run` = **27 文件 / 304 用例全绿**；`npx tsc --noEmit` 无输出；`npx next build` 通过（含 `/agent`）
- 两个端到端脚本都可跑：`src/scripts/agent-smoke.ts`（P0）、`src/scripts/agent-api-smoke.ts`（A 块 9 项）——**改了 catalog / loop / persist / worker 必跑 P0 那个**
- 技能目录当前 **6 个**：`hot_refresh` / `topic_generate` / `content_note_pack` / `review_submit` / `script_generate` / `schedule_recommend`
- 测试基建的两处新增（B 块引入，C 块可直接用）：`vitest.config.ts` 有 `esbuild: { jsx: "automatic" }`（首个 `.tsx` 组件测试需要）；依赖里有 `react-markdown` + `remark-gfm`（**只用于助手气泡的 markdown 渲染，工具摘要仍是纯文本一行**，不要往 summarize 里塞 markdown）
- 验收夹具：`src/scripts/agent-ui-seed-toolcard.ts`（`add blocked|failed` / `remove`）—— 「阻断」状态在 P1 生产不可达，靠它做确定性验收

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
| `library_search_notes` | 内容库检索 | read | ⚠️ **需新建 service** | 查询逻辑现内联在 `src/app/api/notes/route.ts` |
| `library_note_detail` | 笔记详情+评论 | read | ⚠️ **同上** | 抽完让路由与工具共用一份实现 |

**必做的配套**（漏一个就会返工）：

1. 每个技能都要在 `SkillDefinition.summarize` 补一份摘要 —— **必填字段，漏写过不了 `tsc`**；`summarizeCount` 已导出且有单测钉死语义
2. 每个 skillKey 加进 `tool-schemas.ts` 的 `TOOL_SCHEMAS`（`assertSchemasComplete()` 会在启动时断言一一对应）
3. 新 skillKey 必须用**下划线**（P0 D18），`assertToolNamesProviderSafe()` 会拦截违规名
4. `src/prompts/agent.md` 补一条：`content_rewrite` 会改草稿，要求模型改写前说明将修改哪篇（设计稿 §八 风险 5）
5. **加完后要同步改两处既有断言**（预期内，不是回归）：`skill-catalog.test.ts` 的「包含全部 6 个预置技能」、`agent-loop.test.ts` 的「列出全部 6 个技能的 skillKey」
6. **工具返回值要可诊断**（B 块验收的教训）：像 `hot_refresh` 一样，失败/空结果把 `reason` 放进 details **并在 summarize 里带出来** —— 工具卡默认只显示 summarize 一行，藏在 details 里的原因用户要展开才看得到（`hot_refresh` 曾因执行器吞掉 reason 而只显示「收录 0 条热点」，见 B 交接 §五）

**验收**：单测覆盖 schema / 摘要 / riskLevel（risk 要**读函数体核**、不能凭名字推断 —— P0 曾因此标错 3 个）+ 其中 2 个走真实模型端到端（设计稿 §7.1 C 块）。对应验收清单第 8 条。**基本全是自动化**，不需要人工点浏览器。

**决策点（先问用户，别自行决定）**：

- **「阻断」可见性**：要让它生产可及就得引入一个 `publish` 级技能（跨块产品决策）；不引入则继续靠夹具验收
- **`content_rewrite` 的护栏**：确认沿用「write 直接执行、产出进工件面板待验收」，并落 `agent.md` 的要求
- **图片两个工具仍推后**（设计稿 D24：开发库没有 `modelType=image` 的模型）
- **两个 library 工具的抽取范围**：只把查询抽成 service，还是顺带把路由的参数解析也归口（设计稿 §6.4）

**其他风险**：

- 单测不得触达外部 API（`hot_refresh` 会打真实小红书接口）
- `hot_refresh` 想真正出数需先在「关键词组」页配词（`seedKeywords` 的兜底是上期榜单 TOP10，两者皆空时必为 0）

---

## 三、B 块（已完成，仅供参考）

B 块（前端三栏界面 + SSE 实时过程 + 两项验收修复）已合并到 `main` 并推送，细节见 `HANDOFF-agent-p1b.md`。C 块与 B 块**无依赖**；C 的新工具会直接在 B 的三栏界面里被调用，而**界面无需为新工具改动**：工件靠 `ArtifactSpec` 声明（`kind`/`idField`/`hrefPrefix`）、卡片靠 `summarize` —— 两者都在 `SkillDefinition` 里。

---

## 四、验收总清单（设计稿 §7.2 逐条对账）

| # | 验收项 | 现状 |
|---|---|---|
| 1 | `/agent` 出现在侧边栏且可访问 | ✅ **B 已完成** |
| 2 | 发消息后**无需刷新**即可看到工具卡与助手文字逐步出现 | ✅ **B 已完成**（用户浏览器实测通过） |
| 3 | 工具卡的 4 种状态都渲染正确 | ✅ **B 已完成**（「阻断」由夹具确定性验收） |
| 4 | 工件卡片出现且点击能跳到对应模块 | ✅ **B 已完成** |
| 5 | 断线重连：刷新后历史完整且不重复渲染 | ✅ **B 已完成**（`latest_event_id` 起点 + 身份幂等归并） |
| 6 | 会话空闲时轮询降速 | ✅ 服务端由 A 完成；前端重连间隔同用 `nextPollInterval` |
| 7 | 取消 pending → 200、取消 running → 409 | ✅ **A 完成**（脚本第 7 项 + B 的前端入口） |
| 8 | 7 个新工具可被模型调用、`agent_tool_calls` 有对应行 | ⬜ **等 C（唯一剩余）** |
| 9 | `vitest` / `tsc` / `next build` 全绿 | ✅ 当前 27 文件 / 304 用例；`tsc` 无输出；build 通过；两个端到端脚本通过 |

---

## 五、环境与陷阱

**必读 `HANDOFF-agent-p1a.md` §五**（本机陷阱）。最常踩的三条：

1. **停 worker 必须按进程树清**（`TaskStop` 与杀父进程都杀不掉子 `node`；残留进程会用旧代码领任务，制造「改了代码行为没变」的假象）：
   ```powershell
   Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
     Where-Object { $_.CommandLine -like '*worker/index.mts*' } |
     ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
   ```
   （接手时先跑一次确认没有上一会话的残留 worker）
2. **跑 `next build` 或 `prisma generate` 前先停 dev server**（build 会覆盖 dev 的 `.next` → 未编译过的路由稳定 500，恢复要 `rm -rf .next` 再起）
3. **命令行传中文会损坏字节、多行 `tsx -e` 只跑首行**（提交信息用 `git commit -F <UTF-8 文件>`；需要中文请求体时写文件再 `curl --data-binary @file`）
4. 提交信息与推送：**push 一律由用户自己执行**（本地提交/合并可以由你做）；一个块用一个 feature 分支，收尾 fast-forward 合并回 `main` 再删分支（B 块即此模式）

---

## 六、A/B 两块的流程经验（建议沿用）

1. **每个任务走「实现 → 规格审查 → 质量审查」两段审查**（`superpowers:subagent-driven-development`）。B 块共修掉 10 余个真实缺陷，其中 2 个会丢用户输入（中文输入法回车误发、切会话串台丢草稿）
2. **审查者必须被要求「不要相信实现者的报告」并独立复核**（跑 HTTP/DB 探针、写 jsdom 挂载探针、读源码验证假设）。B 块最有价值的发现全部来自探针型审查
3. **质量审查要要求量化**：把「该不该 memo / 该不该抽函数」量化为数字（Profiler、探针计时），判断比争论可靠
4. **块收尾单独派一次「整体终审」**（看整个分支、不看单任务 diff）—— B 块的终审抓到了 4 个 per-task 审查结构上抓不到的跨文件问题
5. **给实现者的计划要含完整代码与预期输出**，并明确「认为有硬伤就停下报告，不要自行改进」；计划里的计数（用例数/文件数）是快照，执行时以「全绿」为准，但发现偏差要顺手订正计划
6. **审查发现的问题用「补丁提交 + 复审」收口**（并入下一个任务或独立提交），比当场返工干净；每块收尾跑全量：`vitest` + `tsc` + `next build` + 两个端到端脚本

---

## 七、仍然缺的东西 / 独立改进项

- **`docs/` 下没有「总的项目代码文档」**（CLAUDE.md 开发原则 4 要求维护一份）—— P0 起就缺，建议作为独立任务补，不要塞进 C 块
- B 交接 §七 列了一串独立改进项（页面级竞态守卫的 jsdom 冒烟测试、让 `clearAuthTokens` 通知 `use-auth`、`package.json` 里 `db:import` 指向不存在的脚本、接口 3 加字段过滤等）—— 都登记在案、都不阻塞 C
