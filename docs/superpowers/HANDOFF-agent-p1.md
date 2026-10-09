# 交接说明：自主 Agent 工作台 P1

- 交接日期：2026-10-09
- 分支：`main`（P0 已合并）
- 状态：**P1 设计已完成，实现未开始**

---

## 一、一句话现状

P0（后端 Agent 循环）已全部完成并验收通过。P1 的**设计稿已写好**（`docs/superpowers/specs/2026-10-09-agent-workspace-p1-design.md`），**实现计划与编码尚未开始** —— 按交接要求，下一个会话从「读设计稿 → 写实施计划 → 实现」开始。

**P1 的目标**：让工作台在浏览器里可用（`/agent` 入口 + 三栏界面 + SSE 实时过程），并把 Agent 可调用工具从 6 个扩到 13 个。

---

## 二、交付物

| 文件 | 内容 |
|---|---|
| `docs/superpowers/specs/2026-10-09-agent-workspace-p1-design.md` | **P1 设计稿（本次核心交付物）**，370 行，含 7 条新决策 D19–D25 |
| `docs/superpowers/specs/2026-10-09-agent-workspace-design.md` | P0 设计文档（D1–D18），P1 稿是它的细化与部分订正 |
| `src/scripts/agent-smoke.ts` | P0 端到端验收脚本，**P1 改了 P0 代码后必须重跑它** |

---

## 三、必读：设计稿里的五条硬约束

这些是本次设计过程中实测出来的、**不做就会返工**的点。清单在 P1 设计稿 §八，此处只列结论：

1. **中间过程的助手文本目前不落库**（`persist.ts:12,25` 裁掉了三类 message 事件；`agent-loop.mts:485` 只落最终答复）。P1 要改 `serializeEventForDb` 让 `message_end` 保留文本 —— **这是对 P0 已验收代码的修改，必须单独把关并重跑 P0 验收**。设计稿把它排在所有工作之前（§十）。
2. **SSE 服务端在项目里没有先例可抄** —— 全项目 0 处 `ReadableStream`；P0 设计文档 §9.1 提到的 `crawlXhsDataStream` **只有客户端半边**，它 POST 的 `/api/xhs/crawl/data` 路由根本不存在。服务端流式契约要从零定义（设计稿 §4.1 已给出）。
3. **`handle()` 不支持流式返回**（`core/route.ts:16` 类型是 `Promise<NextResponse>`）。需加宽为 `Promise<Response> | Response` —— `NextResponse extends Response`，对现有 148 个路由无影响（设计稿 §3.4）。
4. **前端不能 import `skill-catalog.ts`** —— 它 import 了 prisma 与多个 service，会连带把 DB 层打进客户端包。工具卡摘要**必须在服务端算好**（设计稿 D21/§4.3）。
5. **新 skillKey 必须用下划线**（P0 的 D18）并通过 `assertToolNamesProviderSafe()` 启动断言。

---

## 四、环境状态与操作方式

| 项 | 状态 |
|---|---|
| 分支 | `main`，**领先 `origin/main` 34 个提交，未推送** |
| 测试 | 20 文件 / **203 用例**全绿（`npx vitest run`）|
| 类型 | `npx tsc --noEmit` 干净 |
| 构建 | `npx next build` 通过 |
| dev server | **已停止**（为跑 build 停的），需用 `npm run dev` 重启 |
| worker | **已停止**，需用 `npx tsx src/worker/index.mts` 启动 |
| 数据库 | 宿主 PostgreSQL 18（`localhost:5432`）。`model_configs` 仅有 **1 条 text 模型**（`deepseek-flash` @ `https://api.deepseek.com`）—— **没有 `modelType=image` 的模型**，这是图片工具推后的真实原因 |
| 未跟踪文件 | `public/show/`（与本次工作无关，交接前就存在）|

**跑端到端验收的方式**（P0 已验证可用）：

```
终端 A：npx tsx src/worker/index.mts
终端 B：npx tsx src/scripts/agent-smoke.ts
```

---

## 五、⚠️ 本机操作陷阱（P1 一定会再遇到）

**Windows 上 `TaskStop` 杀不掉后台 worker 的子 `node` 进程。** 残留进程会继续按 cron 领任务、跑**旧代码**，导致「改了代码、重启后行为没变」的假象 —— 排查时会误判成代码缺陷（P0 验收时实际踩到，白排查一轮）。

停 worker 必须按进程树清理：

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*worker/index.mts*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

有多个 worker 在跑时用 `CreationDate` 区分新旧；判断「Run 是老进程还是新进程跑的」看各后台任务输出里 `[worker] agent 领取到 N 个待执行 Run` 出现在哪个进程。

---

## 六、建议的接手顺序

1. 跑一次基线确认：`npx vitest run` + `npx tsc --noEmit`（应为 20 文件 / 203 用例全绿）
2. 读 P1 设计稿，**重点读 §八（前置条件与风险）与 §十（建议实施顺序）**
3. 按设计稿 §十 的顺序推进：**D23 修改（message_end 保留文本）→ A 块接口层 → C 块 7 个工具 → B 块前端**
   - A 块先做因为 B 依赖它联调；C 块与 A/B 无依赖可并行
4. 写实施计划（本会话未写，按交接要求留给下一会话）
5. 全部完成后走 `superpowers:finishing-a-development-branch` 收尾

---

## 七、P0 的既有经验（可直接复用，不必重新发现）

以下结论在 P0 已实测确认，读代码时不必再验证一遍：

| 结论 | 出处 |
|---|---|
| `.mts` 后缀是运行时的硬性要求（Pi 包 ESM-only），且 tsconfig 必须 `include **/*.mts`，否则 `.mts` 会**静默逃过 tsc 检查** | P0 设计文档 D17 |
| 工具名只能含 `[a-zA-Z0-9_-]`，点号/冒号/空格/中文都会被 provider **400 拒绝**，且表现为「模型请求失败」极难定位 | P0 设计文档 D18 |
| 模型能力应从 `/models` 探测而非硬编码（实测 `deepseek-flash` 窗口 1_048_576，而代码原硬编码 128_000）| P0 设计文档 §8.1.1 |
| Pi 的三个钩子分工：`subscribe` 只能观察、`beforeToolCall` 可阻断、`afterToolCall` 可改写工具结果 —— **被阻断的调用不走 `afterToolCall`** | `agent-loop.mts` 文件头 |
| 失败判定必须 fail-closed：Pi 把失败编码在 `stopReason` 里、**从不抛异常**，用 try/catch 判成功会把超时/限流/5xx 全记成 succeeded | P0 设计文档 §12.1 |
| 单元测试不得触达外部 API（`hot_refresh` 会打真实小红书接口）| P0 交接文档 §5.4 |
| 全库时间用**朴素上海墙钟**（`shanghaiNow()`），原始 SQL 里一律 `now() AT TIME ZONE 'Asia/Shanghai'` | P0 交接文档 §5.2 |

**计划文件**：`docs/superpowers/plans/2026-10-09-agent-workspace-p0.md`（P0 的，P1 的尚未编写）
