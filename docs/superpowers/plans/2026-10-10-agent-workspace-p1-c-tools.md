# Agent 工作台 P1-C 实现计划（7 个新工具）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Agent 可调用工具从 6 个扩到 13 个（`content_rewrite` / `content_titles` / `content_tags` / `analytics_reports` / `kb_get` / `library_search_notes` / `library_note_detail`），对应设计稿 §7.2 验收清单第 8 条（7 个新工具可被模型调用、`agent_tool_calls` 有对应行）。

**Architecture:** 技能的定义（含 `summarize` 摘要与 `artifact` 产出声明）登记在 `SKILL_CATALOG`，执行逻辑进 `executeSkill` 的 switch（均在 `src/lib/server/agent/skill-catalog.ts`）；入参校验边界在 `tool-schemas.ts` 的 TypeBox schema。两个 library 工具需要先把 `api/notes` 路由里内联的查询逻辑抽成 `note-service.ts`（设计稿 §6.4），路由与工具共用一份实现。**不新增接口、不改前端** —— 工具卡靠 `summarize`、工件面板靠 `artifact` 声明，两者都在服务端驱动（D21/D5）。

**Tech Stack:** TypeScript 5.9（strict）/ vitest 3（`environment: "node"`，只收 `src/**/*.test.ts`）/ TypeBox（Pi 工具入参校验）/ Prisma 6 / Next.js 15.5

**设计依据:**
- `docs/superpowers/specs/2026-10-09-agent-workspace-p1-design.md` §六（工具清单与 riskLevel 实证）、§6.3/§6.4/§6.5、§7.1（C 块测试策略）、§八 风险 5（改写护栏）
- `docs/superpowers/HANDOFF-agent-p1-remaining.md` §二（C 块范围 + 必做配套 6 条 + 决策点）
- `docs/superpowers/HANDOFF-agent-p1a.md` §三（接口契约）、§五（本机陷阱）

**前置:** 开工前跑基线，必须是 27 文件 / 304 用例全绿、`tsc --noEmit` 干净：

```bash
npx vitest run          # 期望 Test Files 27 passed / Tests 304 passed
npx tsc --noEmit        # 期望无输出
```

> **关于各 Task 里的用例数**：下面的期望值是编写计划时的快照。每完成一个任务都会新增用例，**执行时以「全绿」为准**；数字对不上先确认新测试是否被收集，不要当成回归。

### 开工前已确认的决策（2026-10-10，用户拍板）

| # | 决策点 | 结论 |
|---|---|---|
| D-C0-a | 「阻断」状态生产可及性 | **不引入 publish 级技能**，继续用夹具 `agent-ui-seed-toolcard.ts` 验收；引入 publish 属跨块产品决策，留 P2 |
| D-C0-b | `content_rewrite` 护栏 | **沿用「write 直接执行、产出进工件面板待验收」**；`agent.md` 补「改写前说明将修改哪篇草稿」 |
| D-C0-c | 图片两个工具 | **确认推后**（D24：开发库没有 `modelType=image` 的模型） |
| D-C0-d | library 抽取范围 | **只把查询逻辑抽成 service**；HTTP 参数解析与 422 校验留在路由 |

### 执行进度

| 任务 | 状态 | 提交 |
|---|---|---|
| Task 1 note-service（纯投影 + 查询归口） | ✅ 已验收（规格 + 质量两段审查通过；计划计数笔误已订正为 8 用例） | `b80b3f7` |
| Task 2 七条笔记路由改走 service | ✅ 已验收（规格审查含 98 断言行为等价探针；质量审查 Ready=Yes，遗留项见文末 R1–R4） | `8d10b4b` |
| Task 3 目录 + schema 扩到 13 个（含既有断言更新） | ✅ 已验收（两段审查通过；质量审查 3 项修复见下方补丁） | `7cf14b8` |
| Task 3 补丁（摘要防畸形 + 过渡期护栏 + 注释补强） | ✅ 已验收（复审 Approved；探针实证护栏下 LLM 调用 0 次、既有 6 工具与自定义技能不受影响） | `55f961d` |
| Task 4 executeSkill：两个 library 工具 | ✅ 已验收（规格审查含红相复现与边界探针；质量审查 2 项修复见下方补丁） | `492c07c` |
| Task 4 补丁（tag-only 空结果 reason + limit 下推 + id 边界） | ✅ 已验收（复审 Approved：路由 JSON 逐字节等价、limit=2 时序列化查询 4 次） | `3d3987d` |
| Task 5 executeSkill：content_titles + content_tags | ✅ 已验收（规格审查逐字节一致；质量审查 Ready=Yes，2 条测试补强并入 Task 6） | `0492774` |
| Task 6 executeSkill：content_rewrite | ✅ 已验收（规格审查含写序探针；质量审查 Ready=Yes，2 条测试补强并入 Task 7） | `cbf164b` |
| Task 7 executeSkill：analytics_reports + kb_get | ✅ 已验收（规格含护栏删除完整性验证；质量审查 With fixes，修复见下方补丁） | `b0b9e5c` |
| Task 7 补丁（浮点 id 守卫 + reason 页面指引订正） | ✅ 已验收（红相复现证明 12.7 会穿到查询；354 用例全绿） | `2d759ad` |
| Task 8 agent.md 护栏 + 守卫测试 | ✅ 已验收（两段审查通过；质量审查 With fixes，修复见下方补丁） | `39c6edc` |
| Task 8 补丁（提示词口径 + 护栏断言 + 文案订正） | ✅ 已验收（护栏断言钉住「哪篇」；`script_generate` 注释错配订正为 read 级） | `d884dbd` |
| Task 9 C 块端到端脚本（真模型 2 个工具） | ✅ 已验收（两轮真模型通过：草稿 60 → 158 字、工件事件已落、时序证明「改写前已说明」） | `73c07ff` |
| Task 9 补丁（事件时序钉死「改写前已说明」） | ✅ 已验收（审查发现原断言分不清说明的先后；改为按 toolCallId 关联 `tool_execution_start`、只认更早的 assistant `message_end`） | `fdafeea` |
| Task 10a schema 文本入参补长度上限（终审 F2） | ✅ 已验收（instruction=800 / title=300 / body=6000，与路由侧 zod 对齐、守卫测试钉边界；359 用例全绿） | `9a731e0` |
| Task 10b 本文档刷新 + 交接文档收口 | ✅ 已完成（执行进度表回填 + 交接文档改写为「P1 全部完成」收口版） | 【收口提交，哈希由回填补齐】 |

---

## 一、必读硬约束（违反必返工）

| # | 约束 | 出处 |
|---|---|---|
| 1 | 每个技能必须在 `SkillDefinition.summarize` 补一份摘要（**必填字段，漏写过不了 `tsc`**）；`summarizeCount` 已导出可复用 | HANDOFF-remaining §二.1 |
| 2 | 每个 skillKey 必须加进 `tool-schemas.ts` 的 `TOOL_SCHEMAS`（`assertSchemasComplete()` 在启动时断言一一对应，漏配 worker 起不来） | §二.2 |
| 3 | 新 skillKey 必须用**下划线**（P0 D18），`assertToolNamesProviderSafe()` 会在组装工具前拦截 | §二.3 |
| 4 | **服务层不得 import `http-error`**（它依赖 `next/server`，会污染 worker 的依赖图）。服务层只表达「查不到」（返回 `null` / `outcome` 联合），状态码由路由层决定 | agent-service.ts 文件头 |
| 5 | **工具返回值必须可诊断**：失败/空结果把 `reason` 放进 details **并在 summarize 里带出来**（工具卡默认只显示 summarize 一行） | §二.6 |
| 6 | **单测不得触达外部 API / 数据库**：`hot_refresh` 会打真实小红书接口，任何单测都不要碰它；本块新增的单测全部离线（mock 服务层与 prisma） | §二 其他风险 |
| 7 | 工具输出的**键名不要用 `totals` / `truncated`** —— 会被 `context.ts` 的 `summarizeToolResult` 覆盖（模型看到的是被改过的值） | `context.ts:113` |
| 8 | **改了 catalog / loop / persist / worker 必须重跑 P0 脚本** `agent-smoke.ts`；改了接口层重跑 `agent-api-smoke.ts` | HANDOFF-p1a §四 |
| 9 | **停 worker 必须按进程树清**；跑 `next build` 前先停 dev server（build 覆盖 `.next` → 未编译路由稳定 500，修法 `rm -rf .next` 再起 dev）；命令行传中文会损坏字节、多行 `tsx -e` 只跑首行 | HANDOFF-p1a §五 |
| 10 | 提交信息体例：`refactor(notes): …` / `feat(agent-tools): …` / `test(agent-tools): …` / `feat(agent-prompt): …` / `docs(agent): …`；每个 Task 一次提交 | A/B 计划体例 |

---

## 二、与设计稿的偏差（本计划为准）

| # | 原方案 | 实际情况 | 本计划采用 |
|---|---|---|---|
| D-C1 | 设计稿 §6.4：抽查询逻辑成 service，路由改为调用该 service | 逐字节核对发现：`serializeNote` 等序列化函数在 **5 条路由**里各有一份逐字节相同的副本（`notes` / `[noteId]` / `batch-save` / `batch-tag` / `export`），另有第 **7 份 `assetDisplayUrl` 副本**在 `[noteId]/assets/route.ts`（Task 1 质量审查补录）；`batch-create-drafts` 只有 `getOwnedNote`。抽 service 后若留着副本，它们会与 service 静默漂移 | 除 3 条工具相关路由外，**batch-save / batch-tag / export / assets 的副本一并去重**（哈希证据：5 份 `serializeNote` 的 md5 全等于 `440de036c90ee5a1e82b690056268d07`）。`batch-create-drafts` 的 `getOwnedNote` 是另一形态且不涉序列化，不动 |
| D-C2 | 设计稿未提 `content_rewrite` 的工件标题 | `extractArtifacts` 的 `titleField` 只认数组（多产出按索引对应），单产出拿不到标题，工件卡会显示「去 AI 味改写 #12」 | 扩展 `extractArtifacts` 支持**字符串** `titleField`（约 5 行 + 单测），工件卡显示「《草稿标题》」 |
| D-C3 | 设计稿 §7.1：2 个工具走真实模型端到端 | 未指定是哪 2 个 | 选**风险最高的两条路径**：`library_search_notes`（唯一需要先做抽取重构的读工具）+ `content_rewrite`（唯一 write 工具，直接覆盖用户草稿）。其余 5 个离线覆盖（schema / 摘要 / executeSkill 的参数映射与空结果 reason） |

---

## 三、文件结构

**新增**

| 文件 | 职责 |
|---|---|
| `src/lib/server/services/note-service.ts` | 内容库查询服务：列表筛选（平台/关键词/标签/有无素材/有无评论）、笔记详情（含标签）、评论列表 + 4 个纯投影函数。路由与 library 工具共用一份实现 |
| `src/lib/server/services/note-service.test.ts` | 纯投影函数单测（不连库） |
| `src/lib/server/agent/skill-execute.test.ts` | 7 个新工具 `executeSkill` 的离线单测（mock 服务层与 prisma，真实走 switch） |
| `src/prompts/agent-prompt.test.ts` | `agent.md` 的改稿护栏与 `{{toolCatalog}}` 占位符守卫 |
| `src/scripts/agent-c-tools-smoke.ts` | C 块端到端验收脚本（真模型跑 2 个工具，需 worker） |

**修改**

| 文件 | 改动 |
|---|---|
| `src/lib/server/agent/skill-catalog.ts` | +7 个目录条目（含 instructions / summarize / artifact）+ 7 个 executeSkill case + 2 个 import |
| `src/lib/server/agent/tool-schemas.ts` | +7 个 TypeBox schema |
| `src/lib/server/agent/persist.ts` | `extractArtifacts` 支持字符串 `titleField` |
| `src/app/api/notes/route.ts` | 查询改走 `searchNotes`（-100 行） |
| `src/app/api/notes/[noteId]/route.ts` | 详情改走 `getNoteDetail`、删除改走 `findOwnedNote` |
| `src/app/api/notes/[noteId]/comments/route.ts` | 改走 `listNoteComments` |
| `src/app/api/notes/batch-save/route.ts`、`batch-tag/route.ts`、`export/route.ts` | 删本地序列化副本，改 import（**不改业务逻辑**） |
| `src/lib/server/agent/skill-catalog.test.ts` | 6→13 计数、riskLevel 表、artifact 表、摘要用例 +7 |
| `src/lib/server/agent/tool-schemas.test.ts` | +4 个 schema 校验用例 |
| `src/lib/server/agent/tool-registry.test.ts` | 6→13、replay safe 2→8 |
| `src/lib/server/agent/agent-loop.test.ts` | 目录文本测试改为遍历 `SKILL_CATALOG` 全量 |
| `src/lib/server/agent/persist.test.ts` | +1 个字符串 `titleField` 用例 |
| `src/lib/server/agent/context.ts` | 注释「当前 6 个技能」→「当前 13 个技能」 |
| `src/prompts/agent.md` | +1 条改稿护栏（工作方式第 5 条） |
| `docs/superpowers/HANDOFF-agent-p1-remaining.md` | 收尾时刷新（Task 10） |

---

## Task 1: note-service（纯投影函数 + 查询归口）

**Files:**
- Create: `src/lib/server/services/note-service.ts`
- Test: `src/lib/server/services/note-service.test.ts`

- [ ] **Step 1: 写失败测试（纯投影函数）**

创建 `src/lib/server/services/note-service.test.ts`：

```ts
/**
 * 内容库服务单元测试（纯函数部分）
 * 覆盖：笔记/评论投影的边界（封面兜底、视频、raw_json 形状、本地素材 URL）。不连数据库。
 */
import type { Note, NoteAsset, NoteComment } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { assetDisplayUrl, projectComment, projectNote } from "./note-service";

/** 造一条 Note 行（只列投影函数会读的字段） */
function makeNote(overrides: Partial<Note> = {}): Note {
  return {
    id: 12,
    userId: 1,
    platformAccountId: 3,
    platform: "xhs",
    noteId: "abc123",
    title: "露营装备清单",
    content: "正文内容",
    authorName: "小明",
    rawJson: null,
    createdAt: new Date("2026-10-10T08:00:00Z"),
    ...overrides,
  };
}

/** 造一条 NoteAsset 行 */
function makeAsset(overrides: Partial<NoteAsset> = {}): NoteAsset {
  return {
    id: 1,
    noteId: 12,
    assetType: "image",
    url: "https://example.com/a.jpg",
    localPath: "",
    sortOrder: 0,
    ...overrides,
  };
}

/** 造一条 NoteComment 行 */
function makeComment(overrides: Partial<NoteComment> = {}): NoteComment {
  return {
    id: 5,
    noteId: 12,
    commentId: "c-1",
    userName: "小红",
    userId: "u-9",
    content: "收藏了",
    likeCount: 3,
    parentCommentId: null,
    createdAtRemote: "2026-10-09T12:00:00",
    rawJson: null,
    ...overrides,
  };
}

describe("assetDisplayUrl（素材展示 URL）", () => {
  it("有 localPath 走本地静态服务，否则用远程 url", () => {
    expect(assetDisplayUrl({ localPath: "notes/1.jpg", url: "https://example.com/a.jpg" })).toBe(
      "/api/files/media/notes/1.jpg",
    );
    expect(assetDisplayUrl({ localPath: "", url: "https://example.com/a.jpg" })).toBe("https://example.com/a.jpg");
  });
});

describe("projectNote（笔记投影）", () => {
  it("字段映射与时间格式化：snake_case 协议字段与 Note 行一一对应", () => {
    const result = projectNote(makeNote(), []);
    expect(result).toMatchObject({
      id: 12,
      platform: "xhs",
      platform_account_id: 3,
      note_id: "abc123",
      title: "露营装备清单",
      content: "正文内容",
      author_name: "小明",
      raw_json: null,
      asset_urls: [],
      cover_url: "",
      video_url: "",
      video_addr: "",
    });
    // 时间字段是「朴素上海墙钟」字符串，直接取 UTC 字段格式化
    expect(result.created_at).toBe("2026-10-10T08:00:00");
  });

  it("封面优先取首张 image 素材，没有素材时回退 raw_json.cover_url", () => {
    const withAsset = projectNote(makeNote(), [makeAsset({ localPath: "notes/1.jpg" })]);
    expect(withAsset.cover_url).toBe("/api/files/media/notes/1.jpg");

    const withRaw = projectNote(makeNote({ rawJson: { cover_url: "https://example.com/raw.jpg" } }), []);
    expect(withRaw.cover_url).toBe("https://example.com/raw.jpg");

    const withNothing = projectNote(makeNote(), []);
    expect(withNothing.cover_url).toBe("");
  });

  it("视频素材同时填 video_url 与 video_addr（对应原版两个字段同值）", () => {
    const result = projectNote(makeNote(), [makeAsset({ assetType: "video", url: "https://example.com/v.mp4" })]);
    expect(result.video_url).toBe("https://example.com/v.mp4");
    expect(result.video_addr).toBe("https://example.com/v.mp4");
  });

  it("asset_urls 只收有 url 或 localPath 的素材，顺序即入参顺序", () => {
    const result = projectNote(makeNote(), [
      makeAsset({ id: 1, url: "https://example.com/1.jpg", localPath: "" }),
      makeAsset({ id: 2, url: "", localPath: "notes/2.jpg" }),
      makeAsset({ id: 3, url: "", localPath: "" }),
    ]);
    expect(result.asset_urls).toEqual(["https://example.com/1.jpg", "/api/files/media/notes/2.jpg"]);
  });

  it("raw_json 不是对象（数组/字符串）时不抛错，封面按空串兜底", () => {
    const result = projectNote(makeNote({ rawJson: ["不是对象"] }), []);
    expect(result.cover_url).toBe("");
  });
});

describe("projectComment（评论投影）", () => {
  it("字段映射与可空字段", () => {
    expect(projectComment(makeComment())).toMatchObject({
      id: 5,
      note_id: 12,
      comment_id: "c-1",
      user_name: "小红",
      user_id: "u-9",
      content: "收藏了",
      like_count: 3,
      parent_comment_id: null,
      created_at_remote: "2026-10-09T12:00:00",
      raw_json: null,
    });
  });

  it("回复评论带 parent_comment_id，缺失的 user_id 保持 null", () => {
    const result = projectComment(makeComment({ parentCommentId: "c-0", userId: null }));
    expect(result.parent_comment_id).toBe("c-0");
    expect(result.user_id).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/lib/server/services/note-service.test.ts`
Expected: FAIL —— `Failed to resolve import "./note-service"`（文件还不存在）

- [ ] **Step 3: 实现 note-service.ts**

创建 `src/lib/server/services/note-service.ts`：

```ts
/**
 * 内容库（笔记）查询服务
 *
 * 从 api/notes 的六条路由里抽出（P1 设计稿 §6.4）：路由与 Agent 的 library_* 工具
 * 共用同一份查询与序列化实现，而不是两处各写一遍筛选逻辑（与 P0 抽取 skill-catalog 同一模式）。
 *
 * 【本文件不含 http-error / next 依赖】—— 服务层只表达「查不到」（返回 null / outcome 联合），
 * 状态码由路由层决定（与 agent-service.ts 文件头的同一约定）。
 */
import type { Note, NoteAsset, NoteComment } from "@prisma/client";
import { prisma } from "../core/db";
import { formatDateTime } from "../core/time";

/** 序列化标签（对应原版 _serialize_tag） */
export function serializeTag(tag: { id: number; name: string; color: string }) {
  return { id: tag.id, name: tag.name, color: tag.color };
}

/** 素材展示 URL：本地素材走 /api/files/media 静态服务（对应原版 _asset_display_url） */
export function assetDisplayUrl(asset: { localPath: string; url: string }): string {
  return asset.localPath ? `/api/files/media/${asset.localPath}` : asset.url;
}

/**
 * 笔记行 + 素材行 → 协议对象（对应原版 _serialize_note）。
 * 纯函数：不碰数据库，单测直接构造行对象即可覆盖全部边界（封面兜底 / 视频 / raw_json 形状）。
 */
export function projectNote(note: Note, assets: NoteAsset[]): Record<string, unknown> {
  const imageAssets = assets.filter((asset) => asset.assetType === "image");
  const videoAssets = assets.filter((asset) => asset.assetType === "video");
  const assetUrls = assets.filter((asset) => asset.url || asset.localPath).map(assetDisplayUrl);
  const raw = note.rawJson && typeof note.rawJson === "object" && !Array.isArray(note.rawJson)
    ? (note.rawJson as Record<string, unknown>)
    : {};
  const rawCover = typeof raw.cover_url === "string" ? raw.cover_url : "";
  return {
    id: note.id,
    platform: note.platform,
    platform_account_id: note.platformAccountId,
    note_id: note.noteId,
    title: note.title,
    content: note.content,
    author_name: note.authorName,
    raw_json: note.rawJson,
    asset_urls: assetUrls,
    cover_url: imageAssets.length ? assetDisplayUrl(imageAssets[0]) : rawCover,
    video_url: videoAssets.length ? assetDisplayUrl(videoAssets[0]) : "",
    video_addr: videoAssets.length ? assetDisplayUrl(videoAssets[0]) : "",
    created_at: formatDateTime(note.createdAt),
  };
}

/** 评论行 → 协议对象（对应原版 _serialize_comment） */
export function projectComment(comment: NoteComment): Record<string, unknown> {
  return {
    id: comment.id,
    note_id: comment.noteId,
    comment_id: comment.commentId,
    user_name: comment.userName,
    user_id: comment.userId,
    content: comment.content,
    like_count: comment.likeCount,
    parent_comment_id: comment.parentCommentId,
    created_at_remote: comment.createdAtRemote,
    raw_json: comment.rawJson,
  };
}

/** 查询笔记的标签（对应原版 _get_note_tags，按 tag.id 升序） */
export async function getNoteTags(noteId: number) {
  const links = await prisma.noteTags.findMany({
    where: { noteId },
    include: { tag: true },
    orderBy: { tagId: "asc" },
  });
  return links.map((link) => serializeTag(link.tag));
}

/** 查询笔记素材（对应原版 _get_note_assets，按 sort_order、id 升序） */
function getNoteAssets(noteId: number) {
  return prisma.noteAsset.findMany({
    where: { noteId },
    orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
  });
}

/** 序列化笔记（含素材/封面/视频，对应原版 _serialize_note） */
export async function serializeNote(note: Note): Promise<Record<string, unknown>> {
  return projectNote(note, await getNoteAssets(note.id));
}

/** 序列化笔记（含标签，对应原版 _serialize_note_with_tags） */
export async function serializeNoteWithTags(note: Note): Promise<Record<string, unknown>> {
  return { ...(await serializeNote(note)), tags: await getNoteTags(note.id) };
}

/** 查当前用户拥有的笔记行；查不到（不存在或不属于该用户）返回 null，由调用方决定状态码 */
export async function findOwnedNote(userId: number, noteId: number): Promise<Note | null> {
  const note = await prisma.note.findUnique({ where: { id: noteId } });
  return note && note.userId === userId ? note : null;
}

/** 列表筛选条件（路由从 URLSearchParams、Agent 工具从模型参数分别映射而来） */
export interface NoteSearchFilter {
  platform?: string;
  keyword?: string;
  tagId?: number;
  hasAssets?: boolean;
  hasComments?: boolean;
  /** 只序列化前 N 条（Agent 工具这类「只要前几条」的调用方用）；不传 = 全量（路由侧现状） */
  limit?: number;
}

/** 列表查询结果：tag_not_found 交给调用方映射状态码（服务层不 import http-error） */
export type NoteSearchResult =
  | { outcome: "ok"; total: number; items: Array<Record<string, unknown>> }
  | { outcome: "tag_not_found" };

/**
 * 按条件检索笔记（对应原版 get_notes 的过滤链）。
 * 分页由调用方做：路由用 paginated()，工具传 limit —— 默认返回全部命中项。
 * total 是**截断前**的命中总数，供调用方展示「命中 N 条、返回 M 条」。
 */
export async function searchNotes(userId: number, filter: NoteSearchFilter): Promise<NoteSearchResult> {
  const keyword = filter.keyword?.trim() ?? "";
  const notes = await prisma.note.findMany({
    where: {
      userId,
      ...(filter.platform ? { platform: filter.platform } : {}),
      ...(keyword
        ? {
            OR: [
              { title: { contains: keyword } },
              { content: { contains: keyword } },
              { authorName: { contains: keyword } },
              { noteId: { contains: keyword } },
            ],
          }
        : {}),
    },
    orderBy: { createdAt: "desc" },
  });

  // tag_id 过滤：标签须归属当前用户，否则 tag_not_found（对应原版 404 语义）
  let filtered = notes;
  if (filter.tagId !== undefined) {
    const tag = await prisma.tag.findUnique({ where: { id: filter.tagId } });
    if (!tag || tag.userId !== userId) return { outcome: "tag_not_found" };
    const links = await prisma.noteTags.findMany({ where: { tagId: filter.tagId }, select: { noteId: true } });
    const noteIds = new Set(links.map((link) => link.noteId));
    filtered = filtered.filter((note) => noteIds.has(note.id));
  }
  // has_assets / has_comments 过滤（对应原版 in_ / not_in 子查询）
  if (filter.hasAssets !== undefined) {
    const noteIds = new Set((await prisma.noteAsset.findMany({ select: { noteId: true } })).map((asset) => asset.noteId));
    filtered = filtered.filter((note) => (filter.hasAssets ? noteIds.has(note.id) : !noteIds.has(note.id)));
  }
  if (filter.hasComments !== undefined) {
    const noteIds = new Set(
      (await prisma.noteComment.findMany({ select: { noteId: true } })).map((comment) => comment.noteId),
    );
    filtered = filtered.filter((note) => (filter.hasComments ? noteIds.has(note.id) : !noteIds.has(note.id)));
  }

  // 先切片再序列化：serializeNoteWithTags 每篇 2 次查询，库大时全量序列化是主要成本（审查 R3）
  const total = filtered.length;
  const selected = filter.limit === undefined ? filtered : filtered.slice(0, Math.max(0, filter.limit));
  const items: Array<Record<string, unknown>> = [];
  for (const note of selected) items.push(await serializeNoteWithTags(note));
  return { outcome: "ok", total, items };
}

/** 笔记详情（含标签）；不存在或不属于当前用户返回 null */
export async function getNoteDetail(userId: number, noteId: number): Promise<Record<string, unknown> | null> {
  const note = await findOwnedNote(userId, noteId);
  if (!note) return null;
  return serializeNoteWithTags(note);
}

/** 评论查询结果：not_found 交给调用方映射状态码 */
export type NoteCommentsResult =
  | { outcome: "ok"; items: Array<Record<string, unknown>> }
  | { outcome: "not_found" };

/** 笔记的评论列表（按 id 升序）；笔记不存在/不属于该用户返回 not_found。分页由调用方做 */
export async function listNoteComments(userId: number, noteId: number): Promise<NoteCommentsResult> {
  const note = await findOwnedNote(userId, noteId);
  if (!note) return { outcome: "not_found" };
  const comments = await prisma.noteComment.findMany({ where: { noteId: note.id }, orderBy: { id: "asc" } });
  return { outcome: "ok", items: comments.map(projectComment) };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/lib/server/services/note-service.test.ts`
Expected: PASS（8 个用例）

- [ ] **Step 5: 提交**

```bash
git add src/lib/server/services/note-service.ts src/lib/server/services/note-service.test.ts
git commit -m "refactor(notes): 抽出 note-service（内容库查询归口，含纯投影函数与单测）"
```

---

## Task 2: 七条笔记路由改走 service

**Files:**
- Modify: `src/app/api/notes/route.ts`（整文件替换）
- Modify: `src/app/api/notes/[noteId]/route.ts`（整文件替换）
- Modify: `src/app/api/notes/[noteId]/comments/route.ts`（整文件替换）
- Modify: `src/app/api/notes/batch-save/route.ts`、`batch-tag/route.ts`、`export/route.ts`、`[noteId]/assets/route.ts`（删副本，改 import）
- Modify: `src/lib/server/services/note-service.test.ts`（Task 1 质量审查的补强项）
- Modify: `src/lib/server/services/note-service.ts`（仅注释小修）

> **行为等价性**：本任务**只搬运，不改语义**。Step 1 先记录副本的哈希作为证据，Step 2–5 再逐文件替换。

- [ ] **Step 1: 记录「副本与 service 逐字节相同」的证据**

Run:
```bash
for f in "src/app/api/notes/route.ts" "src/app/api/notes/[noteId]/route.ts" "src/app/api/notes/batch-save/route.ts" "src/app/api/notes/batch-tag/route.ts" "src/app/api/notes/export/route.ts"; do awk '/^\/\*\* 序列化笔记/,/^}/' "$f" | md5sum; done
```
Expected: 5 行哈希**全部相同**（`440de036c90ee5a1e82b690056268d07`）。若不同则停下报告——说明已被改动，不能机械替换。

- [ ] **Step 2: 替换 `src/app/api/notes/route.ts`**

整文件内容：

```ts
import { getCurrentUser } from "@/lib/server/core/auth";
import { ApiError, notFound } from "@/lib/server/core/http-error";
import { paginated } from "@/lib/server/core/paginate";
import { handle } from "@/lib/server/core/route";
import { searchNotes } from "@/lib/server/services/note-service";
import { NextResponse } from "next/server";

/** 解析并校验分页参数（page>=1、page_size 1..max，对应原版 Query 校验） */
function parsePageParams(searchParams: URLSearchParams, defaultPageSize = 20, maxPageSize = 100) {
  const page = Number.parseInt(searchParams.get("page") ?? "1", 10);
  const pageSize = Number.parseInt(searchParams.get("page_size") ?? String(defaultPageSize), 10);
  if (Number.isNaN(page) || page < 1) throw new ApiError(422, "page must be >= 1");
  if (Number.isNaN(pageSize) || pageSize < 1 || pageSize > maxPageSize) {
    throw new ApiError(422, `page_size must be between 1 and ${maxPageSize}`);
  }
  return { page, pageSize };
}

/** 解析可选布尔查询参数（对应原版 Optional[bool] 校验） */
function parseOptionalBool(searchParams: URLSearchParams, key: string): boolean | undefined {
  const raw = searchParams.get(key);
  if (raw === null) return undefined;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  throw new ApiError(422, `${key} must be a boolean`);
}

/** 解析可选整数查询参数（对应原版 Query[int] 校验） */
function parseOptionalInt(searchParams: URLSearchParams, key: string): number | undefined {
  const raw = searchParams.get(key);
  if (raw === null) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) throw new ApiError(422, `${key} must be an integer`);
  return parsed;
}

/** GET /api/notes 笔记列表（分页 + 多条件过滤，对应原版 get_notes） */
export const GET = handle(async (req, { searchParams }) => {
  const user = await getCurrentUser(req);
  const { page, pageSize } = parsePageParams(searchParams);
  // 参数解析留在路由层（服务层不 import http-error，设计稿 §6.4 的边界）
  const platform = searchParams.get("platform") ?? undefined;
  const q = searchParams.get("q") ?? undefined;
  const hasAssets = parseOptionalBool(searchParams, "has_assets");
  const hasComments = parseOptionalBool(searchParams, "has_comments");
  const tagId = parseOptionalInt(searchParams, "tag_id");

  const result = await searchNotes(user.id, { platform, keyword: q, tagId, hasAssets, hasComments });
  // 标签不存在或不属于当前用户 → 404（对应原版；服务层只返回 outcome）
  if (result.outcome === "tag_not_found") throw notFound("Tag not found");
  return NextResponse.json(paginated(result.items, page, pageSize));
});
```

- [ ] **Step 3: 替换 `src/app/api/notes/[noteId]/route.ts`**

整文件内容：

```ts
import { getCurrentUser } from "@/lib/server/core/auth";
import { prisma } from "@/lib/server/core/db";
import { notFound } from "@/lib/server/core/http-error";
import { handle } from "@/lib/server/core/route";
import { findOwnedNote, getNoteDetail } from "@/lib/server/services/note-service";
import { NextResponse } from "next/server";

/** GET /api/notes/{noteId} 笔记详情（含标签，对应原版 get_note） */
export const GET = handle(async (req, { params }) => {
  const user = await getCurrentUser(req);
  const noteId = Number.parseInt(params.noteId, 10);
  const detail = await getNoteDetail(user.id, noteId);
  if (!detail) throw notFound("Note not found");
  return NextResponse.json(detail);
});

/** DELETE /api/notes/{noteId} 删除笔记（级联清理标签/素材/评论，对应原版 delete_note） */
export const DELETE = handle(async (req, { params }) => {
  const user = await getCurrentUser(req);
  const noteId = Number.parseInt(params.noteId, 10);
  const note = await findOwnedNote(user.id, noteId);
  if (!note) throw notFound("Note not found");
  await prisma.noteTags.deleteMany({ where: { noteId: note.id } });
  await prisma.noteAsset.deleteMany({ where: { noteId: note.id } });
  await prisma.noteComment.deleteMany({ where: { noteId: note.id } });
  // 解除相关草稿的 source_note_id 引用（对应原版 update 置空）
  await prisma.aiDraft.updateMany({ where: { sourceNoteId: note.id }, data: { sourceNoteId: null } });
  await prisma.note.delete({ where: { id: note.id } });
  return NextResponse.json({ id: noteId, status: "deleted" });
});
```

- [ ] **Step 4: 替换 `src/app/api/notes/[noteId]/comments/route.ts`**

整文件内容：

```ts
import { getCurrentUser } from "@/lib/server/core/auth";
import { ApiError, notFound } from "@/lib/server/core/http-error";
import { paginated } from "@/lib/server/core/paginate";
import { handle } from "@/lib/server/core/route";
import { listNoteComments } from "@/lib/server/services/note-service";
import { NextResponse } from "next/server";

/** 解析并校验分页参数（page>=1、page_size 1..200，对应原版 Query 校验） */
function parsePageParams(searchParams: URLSearchParams, defaultPageSize = 50, maxPageSize = 200) {
  const page = Number.parseInt(searchParams.get("page") ?? "1", 10);
  const pageSize = Number.parseInt(searchParams.get("page_size") ?? String(defaultPageSize), 10);
  if (Number.isNaN(page) || page < 1) throw new ApiError(422, "page must be >= 1");
  if (Number.isNaN(pageSize) || pageSize < 1 || pageSize > maxPageSize) {
    throw new ApiError(422, `page_size must be between 1 and ${maxPageSize}`);
  }
  return { page, pageSize };
}

/** GET /api/notes/{noteId}/comments 评论列表（分页，page_size 上限 200，对应原版 get_note_comments） */
export const GET = handle(async (req, { params, searchParams }) => {
  const user = await getCurrentUser(req);
  const noteId = Number.parseInt(params.noteId, 10);
  const { page, pageSize } = parsePageParams(searchParams);
  const result = await listNoteComments(user.id, noteId);
  if (result.outcome === "not_found") throw notFound("Note not found");
  return NextResponse.json(paginated(result.items, page, pageSize));
});
```

- [ ] **Step 5: 四条路由去重（删副本、改 import）**

1. **删除**前三个文件（`batch-save` / `batch-tag` / `export`）里的本地副本（从 `/** 序列化标签` 到 `serializeNoteWithTags` 函数结束）：即 `serializeTag` / `getNoteTags` / `getNoteAssets` / `assetDisplayUrl` / `serializeNote` / `serializeNoteWithTags` 六个函数。
2. **删除** `src/app/api/notes/[noteId]/assets/route.ts:17-20` 的本地 `assetDisplayUrl`（Task 1 质量审查查出的第 7 份副本；该文件的 `serializeAsset` 与 `getOwnedNote` 形态与其它文件不同，本任务不归口，只去重这一个函数）。
3. **删除**前三个文件的 `getOwnedNote`（逐字节相同的抛错版本），改为保留一个薄包装（把服务层的 `null` 映射成 404，状态码语义仍留在路由层）：

```ts
/** 获取当前用户拥有的笔记（服务层不抛状态码，这里把 null 映射成 404） */
async function getOwnedNote(userId: number, noteId: number): Promise<Note> {
  const note = await findOwnedNote(userId, noteId);
  if (!note) throw notFound("Note not found");
  return note;
}
```

4. **补充 import**（按各文件实际用到的符号取舍）：

```ts
import { assetDisplayUrl, findOwnedNote, getNoteTags, serializeNoteWithTags } from "@/lib/server/services/note-service";
```

   - `batch-save`：`import { findOwnedNote, serializeNoteWithTags } from "@/lib/server/services/note-service";`
   - `batch-tag`：同上
   - `export`：再加 `getNoteTags`（`buildNotesCsv` 里 `.map((tag) => tag.name)` 要用）
   - `[noteId]/assets`：只 import `assetDisplayUrl`，其余 import 不动
5. **清掉因删除而不再使用的 import**：三个文件的 `formatDateTime`（`export` 仍需要它做文件名与 `exported_at`，**保留**）；`prisma`（都仍需要）；`type { Note }`（都仍需要）。

- [ ] **Step 6: Task 1 质量审查的补强项（改测试与注释，不改逻辑）**

（1）`src/lib/server/services/note-service.test.ts` —— 「raw_json 不是对象（数组/字符串）」用例内追加两条断言（把用例名里承诺的「字符串」与非字符串 cover 分支真正测到）：

```ts
    // 字符串按非对象处理；cover_url 不是字符串也不当封面
    expect(projectNote(makeNote({ rawJson: "不是对象" }), []).cover_url).toBe("");
    expect(projectNote(makeNote({ rawJson: { cover_url: 123 } }), []).cover_url).toBe("");
```

（2）同文件追加一条用例，把「空白 image 素材不回退 raw 封面」这个从路由原样继承的 quirk 钉住（Task 2 正在动这些路由，防止「顺手修好」造成静默行为变更）：

```ts
  it("空白 image 素材（url 与 localPath 皆空）时封面为空串且不回退 raw_json（与现状等价，勿改）", () => {
    const result = projectNote(
      makeNote({ rawJson: { cover_url: "https://example.com/raw.jpg" } }),
      [makeAsset({ url: "", localPath: "" })],
    );
    expect(result.cover_url).toBe("");
  });
```

（3）`src/lib/server/services/note-service.ts` 两处注释小修：
- 文件头「与 agent-service.ts 文件头的同一约定」→「与 agent-service.ts:336-340 的同一约定」
- `searchNotes` 的 JSDoc 补一句前置条件：`/** ... filter.tagId 须为调用方已校验的整数（校验留在路由层，见 D-C0-d） */`

- [ ] **Step 7: 全量测试 + 类型检查（行为等价性）**

Run:
```bash
npx vitest run          # 期望 28 文件 / 313 用例全绿（304 + Task 1 的 8 + 本任务新增 1）
npx tsc --noEmit        # 期望无输出
```
Expected: 全绿。若 tsc 报未使用的 import，按 Step 5.5 清理。

- [ ] **Step 8: 抽查路由行为（可选但推荐）**

dev server 起着的状态下（若已停则先 `npm run dev`），用**任意已登录用户的 token**验两条路径仍通（无 token 会 401，看不出问题）：

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3000/api/notes            # 期望 401（认证先于业务）
curl -s -o /dev/null -w "%{http_code}\n" "http://127.0.0.1:3000/api/notes/1"        # 期望 401
```
Expected: 两条都是 401。（真正的业务回归由 Task 10 的 `agent-api-smoke.ts` 与浏览器覆盖；本步只确认路由没炸在 import 阶段。）

- [ ] **Step 9: 提交**

```bash
git add src/app/api/notes src/lib/server/services
git commit -F <UTF-8 文件>   # 信息：refactor(notes): 七条笔记路由改走 note-service（查询归口 + 序列化副本去重）
```

---

## Task 3: 目录 + schema 扩到 13 个（含既有断言更新）

**Files:**
- Modify: `src/lib/server/agent/skill-catalog.ts`（+7 个目录条目）
- Modify: `src/lib/server/agent/tool-schemas.ts`（+7 个 schema）
- Modify: `src/lib/server/agent/persist.ts`（`extractArtifacts` 支持字符串 `titleField`）
- Modify: `src/lib/server/agent/persist.test.ts`、`skill-catalog.test.ts`、`tool-schemas.test.ts`、`tool-registry.test.ts`、`agent-loop.test.ts`
- Modify: `src/lib/server/agent/context.ts`（注释里的「6 个技能」→「13 个技能」）

> **本任务只落「目录与校验边界」，不落 executeSkill 的执行分支**（Task 4–7 落）。因此本任务提交后、Task 7 完成前，**不要用运行中的 worker 验收**（新工具会走 custom-skill 兜底分支抛「未知技能」）。测试全绿不受影响。

- [ ] **Step 1: 更新既有断言（先让它红）**

`src/lib/server/agent/skill-catalog.test.ts`：
1. 第 9 行的用例改为：

```ts
  it("包含全部 13 个预置技能", () => {
    const keys = SKILL_CATALOG.map((item) => item.skillKey).sort();
    expect(keys).toEqual([
      "analytics_reports",
      "content_note_pack",
      "content_rewrite",
      "content_tags",
      "content_titles",
      "hot_refresh",
      "kb_get",
      "library_note_detail",
      "library_search_notes",
      "review_submit",
      "schedule_recommend",
      "script_generate",
      "topic_generate",
    ]);
  });
```

2. 第 46 行的用例标题改为 `"13 个技能全部为 read 或 write，不含 publish（首期不开放发布）"`（断言体不变）。
3. 第 52 行的 riskLevel 用例**追加** 7 行断言（在既有 6 行之后）：

```ts
    // C 块 7 个新工具（risk 读函数体核过，不凭名字推断）
    expect(byKey.get("content_rewrite")?.riskLevel).toBe("write"); // aiDraft.update({ body }) 真的改草稿
    expect(byKey.get("content_titles")?.riskLevel).toBe("read"); // generateTitles 纯返回 string[]
    expect(byKey.get("content_tags")?.riskLevel).toBe("read"); // generateTags 纯返回 string[]
    expect(byKey.get("analytics_reports")?.riskLevel).toBe("read"); // listExplosionReports 只 findMany
    expect(byKey.get("kb_get")?.riskLevel).toBe("read"); // buildKbContext 只读知识库
    expect(byKey.get("library_search_notes")?.riskLevel).toBe("read"); // note-service 只 findMany
    expect(byKey.get("library_note_detail")?.riskLevel).toBe("read"); // 同上
```

4. 第 62 行的 artifact 用例的 `expectedIdFields` 追加一行：

```ts
      "content_rewrite": "draft_id",
```

5. 第 76 行的「无产出的技能不声明 artifact」用例**追加**一个新用例：

```ts
  it("C 块 6 个只读工具不声明 artifact（产出只在对话里，不落库、不跳转）", () => {
    for (const skillKey of [
      "content_titles",
      "content_tags",
      "analytics_reports",
      "kb_get",
      "library_search_notes",
      "library_note_detail",
    ]) {
      expect(findSkillDefinition(skillKey)?.artifact, `${skillKey} 不应声明 artifact`).toBeUndefined();
    }
  });
```

6. 第 86 行的 summarize samples 映射追加 7 项：

```ts
      content_rewrite: { draft_id: 12, title: "露营装备清单", length: 356 },
      content_titles: { titles: ["标题A"] },
      content_tags: { tags: ["露营"] },
      analytics_reports: { reports: [{}] },
      kb_get: { context: "账号定位", length: 4 },
      library_search_notes: { total: 2, items: [] },
      library_note_detail: { note_id: 5, note_title: "露营装备清单", comment_total: 3 },
```

7. 文件末尾**追加**摘要行为用例：

```ts
  it("content_rewrite 的摘要：草稿 ID + 标题 + 改写后字数", () => {
    const tool = findSkillDefinition("content_rewrite");
    if (!tool) throw new Error("content_rewrite 不在目录里");
    expect(tool.summarize({ draft_id: 12, title: "露营装备清单", length: 356 })).toBe(
      "已改写草稿 #12：《露营装备清单》（356 字）",
    );
    // 标题缺失时退化为「#id（字数）」，不能让摘要出现空括号
    expect(tool.summarize({ draft_id: 12, length: 356 })).toBe("已改写草稿 #12（356 字）");
  });

  it("content_titles / content_tags 的摘要：正常给条数与首项，空结果带出原因", () => {
    const titles = findSkillDefinition("content_titles");
    const tags = findSkillDefinition("content_tags");
    if (!titles || !tags) throw new Error("content_titles / content_tags 不在目录里");
    expect(titles.summarize({ titles: ["露营装备清单", "标题B"] })).toBe("生成 2 个标题：《露营装备清单》");
    expect(titles.summarize({ titles: [], reason: "模型未返回可用标题" })).toBe("生成 0 个标题（模型未返回可用标题）");
    // 标签预览最多 3 个，用空格分隔
    expect(tags.summarize({ tags: ["露营", "户外", "装备", "第四个"] })).toBe("生成 4 个标签：#露营 #户外 #装备");
    expect(tags.summarize({ tags: [], reason: "模型未返回可用标签" })).toBe("生成 0 个标签（模型未返回可用标签）");
  });

  it("analytics_reports / kb_get 的摘要：空结果带出原因（可诊断性要求）", () => {
    const reports = findSkillDefinition("analytics_reports");
    const kb = findSkillDefinition("kb_get");
    if (!reports || !kb) throw new Error("analytics_reports / kb_get 不在目录里");
    expect(reports.summarize({ count: 3, reports: [{}, {}, {}] })).toBe("读取 3 份爆款拆解报告");
    // 契约：reason 解释「为什么是 0」，有产出时不带出来
    expect(reports.summarize({ count: 0, reports: [], reason: "还没有拆解报告，可先在「策划工作台 → 爆款拆解」生成" })).toBe(
      "读取 0 份爆款拆解报告（还没有拆解报告，可先在「策划工作台 → 爆款拆解」生成）",
    );
    expect(kb.summarize({ context: "x".repeat(100), length: 100 })).toBe("读取知识库上下文（100 字）");
    expect(
      kb.summarize({ context: "", length: 0, reason: "知识库尚未配置，可先在「设置 → 账号知识库」填写账号定位与口吻" }),
    ).toBe("读取知识库上下文（0 字，知识库尚未配置，可先在「设置 → 账号知识库」填写账号定位与口吻）");
  });

  it("library_search_notes / library_note_detail 的摘要：带原因与评论数", () => {
    const search = findSkillDefinition("library_search_notes");
    const detail = findSkillDefinition("library_note_detail");
    if (!search || !detail) throw new Error("library_* 不在目录里");
    expect(search.summarize({ total: 3, count: 3, items: [] })).toBe("检索到 3 篇笔记");
    expect(search.summarize({ total: 0, count: 0, items: [], reason: "没有匹配「露营」的笔记" })).toBe(
      "检索到 0 篇笔记（没有匹配「露营」的笔记）",
    );
    expect(detail.summarize({ note_id: 5, note_title: "露营装备清单", comment_total: 8 })).toBe(
      "笔记 #5《露营装备清单》，评论 8 条",
    );
    expect(detail.summarize({ note_id: 5, note_title: "露营装备清单", comment_total: 0 })).toBe(
      "笔记 #5《露营装备清单》，暂无评论",
    );
  });
```

`src/lib/server/agent/tool-registry.test.ts`：
1. 第 35 行 `expect(tools).toHaveLength(6);` → `expect(tools).toHaveLength(13);`
2. 第 60 行 `expect(tools.filter((tool) => tool.replay === "safe")).toHaveLength(2);` →
```ts
    // read 级 8 个：script_generate / schedule_recommend / content_titles / content_tags /
    // analytics_reports / kb_get / library_search_notes / library_note_detail
    expect(tools.filter((tool) => tool.replay === "safe")).toHaveLength(8);
```

`src/lib/server/agent/agent-loop.test.ts`：第 200–207 行的整段 `describe("buildToolCatalogText（工具目录文本）")` 替换为：

```ts
describe("buildToolCatalogText（工具目录文本）", () => {
  it("列出全部 13 个技能的 skillKey 与描述", () => {
    const text = buildToolCatalogText();
    expect(SKILL_CATALOG).toHaveLength(13);
    for (const definition of SKILL_CATALOG) {
      expect(text, `目录文本缺少 ${definition.skillKey}`).toContain(definition.skillKey);
      expect(text, `目录文本缺少 ${definition.name}`).toContain(definition.name);
    }
  });
});
```
并在文件顶部 import 处补上 `import { SKILL_CATALOG } from "./skill-catalog";`。

`src/lib/server/agent/context.ts`：第 113 行注释 `（当前 6 个技能无此字段）` → `（当前 13 个技能无此字段）`。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/lib/server/agent/skill-catalog.test.ts src/lib/server/agent/tool-registry.test.ts src/lib/server/agent/agent-loop.test.ts`
Expected: FAIL —— 13 个技能的数组对不上（实际只有 6 个）、`toHaveLength(13)` 收到 6、`toHaveLength(8)` 收到 2。

- [ ] **Step 3: 补 7 个目录条目**

在 `src/lib/server/agent/skill-catalog.ts` 的 `SKILL_CATALOG` 数组末尾（`schedule_recommend` 条目之后、`];` 之前）插入以下 7 个条目：

```ts
  {
    skillKey: "content_rewrite",
    name: "去 AI 味改写",
    description: "改写指定草稿的正文，降低 AI 腔、增强小红书语感（直接覆盖原文，无撤销）",
    paramsSchema: {
      type: "object",
      properties: {
        draft_id: { type: "number" },
        instruction: { type: "string" },
        intensity: { type: "string", enum: ["light", "medium", "deep"] },
      },
      required: ["draft_id"],
    },
    instructions: `---
name: 去 AI 味改写
description: 对指定草稿正文做去 AI 味改写并直接覆盖原文
---

# 去 AI 味改写

调用文本模型对草稿正文做去 AI 味改写（降低书面腔、模板感与空洞排比），**结果直接覆盖草稿原文，没有撤销**。调用前必须先说明将要修改哪篇草稿。

## 参数

- draft_id：草稿 ID（必填）
- instruction：额外改写要求（可选）
- intensity：改写强度 light / medium / deep（可选，默认 medium）

## 输出

返回草稿 ID（draft_id）、标题（title）与改写后字数（length）。`,
    // 实证：api/ai/rewrite-note/route.ts:44 执行 aiDraft.update({ body: rewrittenBody }) —— 真的改用户草稿
    riskLevel: "write",
    artifact: {
      kind: "draft",
      idField: "draft_id",
      // 字符串 titleField：单产出取该字段本身（extractArtifacts 已支持，见 persist.ts）
      titleField: "title",
      hrefPrefix: "/platforms/xhs/drafts?id=",
    },
    summarize: (details) => {
      const draftId = summarizeCount(details.draft_id);
      const title = typeof details.title === "string" && details.title ? `：《${details.title}》` : "";
      const length = summarizeCount(details.length);
      // 0 字 = 模型返回空内容、原文未改动（executeSkill 里已拦截，绝不覆盖正文）—— 必须带出 reason
      if (length === 0) {
        const reason = typeof details.reason === "string" && details.reason ? `（${details.reason}）` : "";
        return `未改动草稿 #${draftId}${title}${reason}`;
      }
      return `已改写草稿 #${draftId}${title}（${length} 字）`;
    },
  },
  {
    skillKey: "content_titles",
    name: "标题生成",
    description: "为给定文案生成多个小红书标题备选（只返回数组，不落库）",
    paramsSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        body: { type: "string" },
        count: { type: "number", default: 5 },
      },
      required: ["title"],
    },
    instructions: `---
name: 标题生成
description: 为给定文案生成多个小红书风格标题备选
---

# 标题生成

为给定标题与正文生成多个备选标题（口语化、有钩子）。**只返回数组，不落库** —— 结果可直接作为参数喂给 content_note_pack 等下游工具。

## 参数

- title：原标题（必填）
- body：正文内容（可选，越完整生成的标题越贴合）
- count：标题数量（可选，默认 5，最多 10）

## 输出

返回标题数组（titles）与数量（count）。`,
    // 实证：generateTitles 纯返回 string[]，无任何 prisma 产品数据写入
    riskLevel: "read",
    summarize: (details) => {
      // 摘要永不空行：非数组一律按「无产出」处理（summarizeCount 会把数字字符串转成数字，不能用来判数组）
      const titles = Array.isArray(details.titles) ? details.titles : [];
      if (titles.length > 0) {
        const first = String(titles[0] ?? "");
        return `生成 ${titles.length} 个标题${first ? `：《${first}》` : ""}`;
      }
      const reason = typeof details.reason === "string" && details.reason ? `（${details.reason}）` : "";
      return `生成 0 个标题${reason}`;
    },
  },
  {
    skillKey: "content_tags",
    name: "标签生成",
    description: "为给定文案生成话题标签（只返回数组，不落库）",
    paramsSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        body: { type: "string" },
        count: { type: "number", default: 8 },
      },
      required: ["title"],
    },
    instructions: `---
name: 标签生成
description: 为给定文案生成小红书话题标签
---

# 标签生成

为给定标题与正文生成话题标签。**只返回数组，不落库**。

## 参数

- title：标题（必填）
- body：正文内容（可选）
- count：标签数量（可选，默认 8，最多 20）

## 输出

返回标签数组（tags，不含 # 前缀）与数量（count）。`,
    // 实证：generateTags 纯返回 string[]，无任何 prisma 产品数据写入
    riskLevel: "read",
    summarize: (details) => {
      // 同 content_titles：非数组按无产出处理（直接 .slice 会在非数组上抛错 → 摘要变空行）
      const tags = Array.isArray(details.tags) ? details.tags : [];
      if (tags.length > 0) {
        const preview = tags.slice(0, 3).map((tag) => `#${String(tag)}`).join(" ");
        return `生成 ${tags.length} 个标签：${preview}`;
      }
      const reason = typeof details.reason === "string" && details.reason ? `（${details.reason}）` : "";
      return `生成 0 个标签${reason}`;
    },
  },
  {
    skillKey: "analytics_reports",
    name: "分析报告读取",
    description: "读取最近的爆款拆解报告（结构规律与样本笔记）",
    paramsSchema: { type: "object", properties: { limit: { type: "number", default: 5 } } },
    instructions: `---
name: 分析报告读取
description: 读取最近的爆款拆解报告，了解同赛道已验证的内容结构
---

# 分析报告读取

读取最近的爆款拆解报告（标题/封面/正文/互动结构规律 + 样本笔记），作为生成内容的参考。

## 参数

- limit：读取最近几份（可选，默认 5，最多 20）

## 输出

返回报告数组（reports，含结构规律与样本）与数量（count）。`,
    // 实证：listExplosionReports 仅 findMany，无写入
    riskLevel: "read",
    summarize: (details) => {
      const count = summarizeCount(details.reports);
      if (count > 0) return `读取 ${count} 份爆款拆解报告`;
      const reason = typeof details.reason === "string" && details.reason ? `（${details.reason}）` : "";
      return `读取 0 份爆款拆解报告${reason}`;
    },
  },
  {
    skillKey: "kb_get",
    name: "知识库读取",
    description: "读取账号知识库上下文（定位/口吻/可信主张/内容边界/经验）",
    paramsSchema: { type: "object", properties: {} },
    instructions: `---
name: 知识库读取
description: 读取账号知识库（定位、口吻风格、可信主张、内容边界、经验与风格样本）
---

# 知识库读取

读取账号知识库上下文，了解账号定位、口吻风格、可信主张、内容边界与已验证经验。

## 参数

无参数。

## 输出

返回知识库上下文本（context）与字数（length）。`,
    // 实证：buildKbContext 只读；仅在知识库无行时创建一条空知识库（幂等、replay 安全，无用户可见数据变更）
    riskLevel: "read",
    summarize: (details) => {
      const length = summarizeCount(details.length);
      // 契约同 hot_refresh：reason 只在 0 字时带出（有产出不带）
      if (length > 0) return `读取知识库上下文（${length} 字）`;
      const reason = typeof details.reason === "string" && details.reason ? `，${details.reason}` : "";
      return `读取知识库上下文（0 字${reason}）`;
    },
  },
  {
    skillKey: "library_search_notes",
    name: "内容库检索",
    description: "按关键词/标签检索内容库里的笔记（标题、作者、时间与正文摘要）",
    paramsSchema: {
      type: "object",
      properties: {
        keyword: { type: "string" },
        tag_id: { type: "number" },
        limit: { type: "number", default: 10 },
      },
    },
    instructions: `---
name: 内容库检索
description: 按关键词或标签检索内容库里的笔记
---

# 内容库检索

按关键词（匹配标题/正文/作者/笔记 ID）或标签检索内容库，返回命中的笔记摘要。

## 参数

- keyword：关键词（可选；不传则取最近的笔记）
- tag_id：按标签 ID 过滤（可选）
- limit：返回条数（可选，默认 10，最多 20）

## 输出

返回命中总数（total）、返回条数（count）与笔记摘要数组（items：id/title/author_name/platform/created_at/content_excerpt）。`,
    // 实证：note-service 的 searchNotes 只 findMany，无写入
    riskLevel: "read",
    summarize: (details) => {
      const total = summarizeCount(details.total);
      if (total > 0) {
        // 命中数大于实际返回条数时标出截断（模型只见得到返回的那批）
        const count = summarizeCount(details.count);
        const truncated = count > 0 && total > count ? `（返回 ${count} 条）` : "";
        return `检索到 ${total} 篇笔记${truncated}`;
      }
      const reason = typeof details.reason === "string" && details.reason ? `（${details.reason}）` : "";
      return `检索到 0 篇笔记${reason}`;
    },
  },
  {
    skillKey: "library_note_detail",
    name: "笔记详情+评论",
    description: "读取一篇笔记的完整正文/标签与评论列表",
    paramsSchema: {
      type: "object",
      properties: {
        note_id: { type: "number" },
        comment_limit: { type: "number", default: 20 },
      },
      required: ["note_id"],
    },
    instructions: `---
name: 笔记详情+评论
description: 读取一篇内容库笔记的完整正文、标签与评论
---

# 笔记详情+评论

读取指定笔记的完整正文（超长截断到 2000 字）、标签与评论列表（超长单条截断到 200 字）。

## 参数

- note_id：笔记 ID（必填，内容库主键，不是小红书 note_id）
- comment_limit：最多返回多少条评论（可选，默认 20，最多 200）

## 输出

返回笔记信息（note_id/note_title/author_name/platform/created_at/tags/content/content_truncated）、评论总数（comment_total）与评论数组（comments：user_name/content/like_count）。`,
    // 实证：note-service 的 getNoteDetail / listNoteComments 只读，无写入
    riskLevel: "read",
    summarize: (details) => {
      const noteId = summarizeCount(details.note_id);
      const title = typeof details.note_title === "string" && details.note_title ? `《${details.note_title}》` : "";
      const total = summarizeCount(details.comment_total);
      return total > 0 ? `笔记 #${noteId}${title}，评论 ${total} 条` : `笔记 #${noteId}${title}，暂无评论`;
    },
  },
```

- [ ] **Step 4: 补 7 个 TypeBox schema**

在 `src/lib/server/agent/tool-schemas.ts` 的 `TOOL_SCHEMAS` 里（`schedule_recommend` 之后）追加：

```ts
  "content_rewrite": Type.Object({
    draft_id: Type.Integer({ minimum: 1, description: "待改写的草稿 ID，必填" }),
    instruction: Type.Optional(Type.String({ description: "额外改写要求，如「更口语化、加 emoji」" })),
    intensity: Type.Optional(
      Type.Union([Type.Literal("light"), Type.Literal("medium"), Type.Literal("deep")], {
        description: "改写强度，默认 medium",
      }),
    ),
  }),

  "content_titles": Type.Object({
    title: Type.String({ minLength: 1, description: "原标题，必填" }),
    body: Type.Optional(Type.String({ description: "正文内容，越完整生成的标题越贴合" })),
    count: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 10, default: 5, description: "标题数量，默认 5，最多 10" }),
    ),
  }),

  "content_tags": Type.Object({
    title: Type.String({ minLength: 1, description: "标题，必填" }),
    body: Type.Optional(Type.String({ description: "正文内容" })),
    count: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 20, default: 8, description: "标签数量，默认 8，最多 20" }),
    ),
  }),

  "analytics_reports": Type.Object({
    limit: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 20, default: 5, description: "读取最近几份拆解报告，默认 5，最多 20" }),
    ),
  }),

  "kb_get": Type.Object({}, { description: "知识库读取无需参数" }),

  "library_search_notes": Type.Object({
    keyword: Type.Optional(Type.String({ description: "关键词，匹配标题/正文/作者/笔记 ID" })),
    tag_id: Type.Optional(Type.Integer({ minimum: 1, maximum: 2147483647, description: "按标签 ID 过滤" })),
    limit: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 20, default: 10, description: "返回条数，默认 10，最多 20" }),
    ),
  }),

  "library_note_detail": Type.Object({
    note_id: Type.Integer({
      minimum: 1,
      maximum: 2147483647,
      description: "笔记 ID（内容库主键，不是小红书 note_id），必填",
    }),
    comment_limit: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 200, default: 20, description: "最多返回多少条评论，默认 20" }),
    ),
  }),
```

- [ ] **Step 5: 扩展 `extractArtifacts` 支持字符串 titleField（D-C2）**

`src/lib/server/agent/persist.ts` 的 `extractArtifacts` 里，把这一行：

```ts
  const titles =
    spec.titleField && Array.isArray(output[spec.titleField]) ? (output[spec.titleField] as string[]) : [];
```

替换为：

```ts
  // 标题字段两种形状：数组（多产出，按索引对应）与字符串（单产出，如改写后的草稿标题）
  const rawTitles = spec.titleField ? output[spec.titleField] : undefined;
  const titles: string[] = Array.isArray(rawTitles)
    ? (rawTitles as string[])
    : typeof rawTitles === "string" && rawTitles
      ? [rawTitles]
      : [];
```

- [ ] **Step 6: 补测试（schema 校验 + persist 字符串 titleField）**

`src/lib/server/agent/tool-schemas.test.ts` 的 `describe("TOOL_SCHEMAS（工具入参 schema）")` 内追加：

```ts
  it("content_rewrite 的 intensity 只接受三个枚举值，draft_id 必填", () => {
    const schema = getToolSchema("content_rewrite");
    expect(Value.Check(schema, { draft_id: 12 })).toBe(true);
    expect(Value.Check(schema, { draft_id: 12, intensity: "deep" })).toBe(true);
    expect(Value.Check(schema, { draft_id: 12, intensity: "extreme" })).toBe(false);
    expect(Value.Check(schema, {})).toBe(false);
    expect(Value.Check(schema, { draft_id: 0 })).toBe(false);
  });

  it("content_titles / content_tags 的 count 有上下限（与路由侧默认值一致）", () => {
    expect(Value.Check(getToolSchema("content_titles"), { title: "T", count: 10 })).toBe(true);
    expect(Value.Check(getToolSchema("content_titles"), { title: "T", count: 11 })).toBe(false);
    expect(Value.Check(getToolSchema("content_titles"), { count: 5 })).toBe(false); // title 必填
    expect(Value.Check(getToolSchema("content_tags"), { title: "T", count: 20 })).toBe(true);
    expect(Value.Check(getToolSchema("content_tags"), { title: "T", count: 21 })).toBe(false);
  });

  it("kb_get 接受空对象，library_note_detail 的 note_id 必填", () => {
    expect(Value.Check(getToolSchema("kb_get"), {})).toBe(true);
    expect(Value.Check(getToolSchema("library_note_detail"), {})).toBe(false);
    expect(Value.Check(getToolSchema("library_note_detail"), { note_id: 3 })).toBe(true);
  });

  it("library_search_notes 全部参数可选（无参检索 = 取最近笔记）", () => {
    const schema = getToolSchema("library_search_notes");
    expect(Value.Check(schema, {})).toBe(true);
    expect(Value.Check(schema, { keyword: "露营", limit: 20 })).toBe(true);
    expect(Value.Check(schema, { limit: 21 })).toBe(false);
    expect(Value.Check(schema, { limit: 0 })).toBe(false);
  });
```

`src/lib/server/agent/persist.test.ts` 的 `describe("extractArtifacts（工件抽取）")` 内追加：

```ts
  it("content_rewrite 的字符串 titleField 被用作工件标题（D-C2：单产出也能带标题）", () => {
    const artifacts = extractArtifacts("content_rewrite", { draft_id: 12, title: "露营装备清单", length: 356 });
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({
      kind: "draft",
      id: 12,
      title: "露营装备清单",
      href: "/platforms/xhs/drafts?id=12",
    });
  });

  it("字符串 titleField 为空串时回退「技能名 #id」（不产出空标题）", () => {
    const artifacts = extractArtifacts("content_rewrite", { draft_id: 12, title: "", length: 10 });
    expect(artifacts[0]?.title).toBe("去 AI 味改写 #12");
  });
```

- [ ] **Step 7: 跑测试确认通过**

Run:
```bash
npx vitest run          # 期望 28 文件 / 324 用例全绿（304 + Task 1 的 8 + Task 2 的 1 + 本任务新增的 11 条）
npx tsc --noEmit        # 期望无输出（summarize 必填字段漏写会在这里报错）
```
Expected: 全绿。

- [ ] **Step 8: 提交**

```bash
git add src/lib/server/agent
git commit -m "feat(agent-tools): 目录与 schema 扩到 13 个工具（含 artifact 字符串标题与既有断言更新）"
```

### Task 3 补丁（质量审查修复，补丁提交 + 复审）

审查实测出四类问题，本补丁一次收口（改 `skill-catalog.ts` / `skill-catalog.test.ts` / `tool-schemas.test.ts` / `persist.ts` 注释）：

**P1（I1，必改）摘要永不空行**：`content_tags.summarize` 对非数组 `tags` 会 `.slice is not a function` 抛错 → `buildToolCallSummary` 吞错返回空串 → 卡片无摘要行（D21 缺陷，空文案无兜底）。已在上文 Task 3 Step 3 的 summarize 代码块中改为 `Array.isArray` 守卫（`content_titles` 同样处理，并把「数字字符串被 summarizeCount 转成数字」的陷阱写进注释）。

**P2（I2，必改）content_rewrite 空产出**：summarize 增加 `length === 0 → 未改动草稿 #id《标题》（reason）` 分支（已在上文代码块）；executeSkill 的防空保护在 **Task 6** 落（见该任务 Step 3）。

**P3（I3）过渡期护栏**：`ensureUserSkills` 会把 13 条目录种进 `skill_registry`，导致「目录已登记但执行分支未实现」的工具在过渡期**不会抛「未知技能」，而是走 default 分支的 LLM 兜底、产出看起来成功的假结果**（审查用 mock registry 实测）。加一段临时护栏，让过渡期响亮失败而不是安静撒谎；**Task 7 落完最后一个分支后连同本护栏一并删除**：

在 `skill-catalog.ts` 的 `executeSkill` 上方加常量：

```ts
/** C 块过渡期护栏：目录已登记但执行分支未实现的 skillKey（Task 7 落完最后一个分支后整块删除） */
const INTERIM_UNIMPLEMENTED_SKILLS = new Set([
  "content_rewrite",
  "content_titles",
  "content_tags",
  "analytics_reports",
  "kb_get",
  "library_search_notes",
  "library_note_detail",
]);
```

并在 `default:` 分支的第一行插入：

```ts
      // 过渡期护栏：注册表种子（ensureUserSkills）会让这些 key 落进 LLM 兜底、产出假结果 —— 宁可响亮失败
      if (INTERIM_UNIMPLEMENTED_SKILLS.has(skillKey)) {
        throw new Error(`技能 ${skillKey} 的执行分支尚未实现（C 块过渡期，请勿使用运行中的 worker 验收）`);
      }
```

> 护栏**不写长期单测**（它只活到 Task 7）：补丁提交时用一次性探针验证（mock `skillRegistry.findFirst` 返回一行，断言 `executeSkill("kb_get", {}, ctx)` 抛「执行分支尚未实现」而不是返回结果），探针跑完删除、不提交。

**P4（M1/M4/M5/M6/M9）注释与断言补强**：

1. `skill-catalog.ts` 的 `ArtifactSpec.titleField` 注释改为：

```ts
  /** 标题字段名（数组 = 多产出按索引对应；字符串 = 单产出取该值）；缺省或取不到时回退「技能名 #id」 */
  titleField?: string;
```

2. `persist.ts` 的 `extractArtifacts`：把三层嵌套三元抽成显式判断，并对空白串兜底：

```ts
  // 标题字段两种形状：数组（多产出，按索引对应）与字符串（单产出，如改写后的草稿标题）
  const rawTitles = spec.titleField ? output[spec.titleField] : undefined;
  let titles: string[] = [];
  if (Array.isArray(rawTitles)) titles = rawTitles as string[];
  else if (typeof rawTitles === "string" && rawTitles.trim()) titles = [rawTitles];
```

3. `skill-catalog.test.ts` 追加四组断言：

```ts
  it("摘要对畸形 details 不抛错、不产出空文案（D21：工具卡不能没有摘要行）", () => {
    const titles = findSkillDefinition("content_titles");
    const tags = findSkillDefinition("content_tags");
    const detail = findSkillDefinition("library_note_detail");
    if (!titles || !tags || !detail) throw new Error("工具不在目录里");
    // summarizeCount 会把数字字符串当数字：不能用它判「是不是数组」
    expect(titles.summarize({ titles: "3" })).toBe("生成 0 个标题");
    expect(tags.summarize({ tags: 5 })).toBe("生成 0 个标签");
    expect(detail.summarize({ note_id: 5, note_title: 123, comment_total: "x" })).toBe("笔记 #5，暂无评论");
  });

  it("content_rewrite 空产出（原文未改动）的摘要带出 reason", () => {
    const tool = findSkillDefinition("content_rewrite");
    if (!tool) throw new Error("content_rewrite 不在目录里");
    expect(
      tool.summarize({ draft_id: 12, title: "露营装备清单", length: 0, reason: "模型返回空内容，原文未改动" }),
    ).toBe("未改动草稿 #12：《露营装备清单》（模型返回空内容，原文未改动）");
  });

  it("library_search_notes 结果被截断时摘要标出实际返回条数", () => {
    const search = findSkillDefinition("library_search_notes");
    if (!search) throw new Error("library_search_notes 不在目录里");
    expect(search.summarize({ total: 30, count: 20, items: [] })).toBe("检索到 30 篇笔记（返回 20 条）");
  });

  it("kb_get 只在 0 字时带出 reason（有产出不带，与 hot_refresh 同契约）", () => {
    const kb = findSkillDefinition("kb_get");
    if (!kb) throw new Error("kb_get 不在目录里");
    expect(kb.summarize({ context: "x", length: 1, reason: "不该出现" })).toBe("读取知识库上下文（1 字）");
  });
```

4. `tool-schemas.test.ts` 追加一条 default / description 守卫：

```ts
  it("count / limit 的 default 与路由侧默认值一致，且全部属性都有 description（模型靠它选参数）", () => {
    type JsonSchemaNode = { properties?: Record<string, { default?: unknown; description?: string }> };
    const defaults: Array<[string, string, unknown]> = [
      ["content_titles", "count", 5],
      ["content_tags", "count", 8],
      ["analytics_reports", "limit", 5],
      ["library_search_notes", "limit", 10],
      ["library_note_detail", "comment_limit", 20],
    ];
    for (const [skillKey, field, expected] of defaults) {
      const schema = getToolSchema(skillKey) as unknown as JsonSchemaNode;
      expect(schema.properties?.[field]?.default, `${skillKey}.${field}.default`).toBe(expected);
    }
    for (const item of SKILL_CATALOG) {
      const schema = getToolSchema(item.skillKey) as unknown as JsonSchemaNode;
      for (const [field, node] of Object.entries(schema.properties ?? {})) {
        expect(node.description, `${item.skillKey}.${field} 缺 description`).toBeTruthy();
      }
    }
  });
```

验证：`npx vitest run`（期望 28 文件 / **329** 用例全绿）+ `npx tsc --noEmit` 无输出 + 一次性探针确认过渡期护栏生效（跑完删探针）。

补丁提交信息：`fix(agent-tools): 摘要防畸形输入 + 过渡期护栏 + artifact titleField 注释补强`（同样用 `git commit -F`）。

---

## Task 4: executeSkill —— 两个 library 工具

**Files:**
- Modify: `src/lib/server/agent/skill-catalog.ts`（+2 个 case + 1 个 import）
- Test: `src/lib/server/agent/skill-execute.test.ts`（新建）

- [ ] **Step 1: 写失败测试（新建 skill-execute.test.ts，先只放 library 两节）**

创建 `src/lib/server/agent/skill-execute.test.ts`：

```ts
/**
 * 新工具执行器离线单测（C 块 7 个工具）
 *
 * 只 mock「外部世界」（数据库与服务层），真实走 executeSkill 的 switch：
 * 参数校验、返回值形状、空结果 reason 都按真实实现断言。
 * 不触达数据库与外部 API（hot_refresh 会打真实小红书接口，本文件不碰它）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  searchNotes: vi.fn(),
  getNoteDetail: vi.fn(),
  listNoteComments: vi.fn(),
  listExplosionReports: vi.fn(),
  buildKbContext: vi.fn(),
  draftFindFirst: vi.fn(),
  draftUpdate: vi.fn(),
}));

// 服务层用**部分替换**（保留其他导出，避免 skill-catalog 的传递依赖取到 undefined）：
// 与 tool-registry.test.ts mock skill-catalog 的写法同一模式
vi.mock("../services/note-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/note-service")>()),
  searchNotes: mocks.searchNotes,
  getNoteDetail: mocks.getNoteDetail,
  listNoteComments: mocks.listNoteComments,
}));
vi.mock("../services/exploration-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/exploration-service")>()),
  listExplosionReports: mocks.listExplosionReports,
}));
vi.mock("../services/knowledge-base-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/knowledge-base-service")>()),
  buildKbContext: mocks.buildKbContext,
}));
// core/db 整体替换：真实模块在 import 时就 new PrismaClient()（db.ts:11），测试里不需要
vi.mock("../core/db", () => ({
  prisma: {
    aiDraft: { findFirst: mocks.draftFindFirst, update: mocks.draftUpdate },
    // makeUsageLogger 的回调可能被真实调用：给个不会炸的桩
    apiUsageLog: { create: vi.fn(async () => ({})) },
  },
}));

import { executeSkill, type SkillContext } from "./skill-catalog";

/** 造一个只有必要字段的上下文（textClient 由各用例按需注入） */
function makeContext(overrides: Partial<SkillContext> = {}): SkillContext {
  return {
    userId: 7,
    textClient: {} as never,
    modelConfig: null,
    apiKey: "",
    ...overrides,
  };
}

/** 造一个「已配置模型」的上下文 + 假 textClient */
function makeModelContext(textClient: Record<string, unknown>): SkillContext {
  return makeContext({
    textClient: textClient as never,
    modelConfig: { id: 1, modelName: "fake-model" } as never,
    apiKey: "sk-test",
  });
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
});

describe("library_search_notes", () => {
  it("正常检索：total/count/items 投影，正文截断到 120 字，limit 下推给服务层", async () => {
    mocks.searchNotes.mockResolvedValue({
      outcome: "ok",
      total: 1,
      items: [
        {
          id: 12,
          title: "露营装备清单",
          author_name: "小明",
          platform: "xhs",
          created_at: "2026-10-10T08:00:00",
          content: "长".repeat(300),
          raw_json: { huge: "不应出现" },
        },
      ],
    });
    const result = await executeSkill("library_search_notes", { keyword: "露营" }, makeContext());
    // limit 下推到服务层（默认 10）：服务端只序列化前 10 条
    expect(mocks.searchNotes).toHaveBeenCalledWith(7, { keyword: "露营", tagId: undefined, limit: 10 });
    expect(result.total).toBe(1);
    expect(result.count).toBe(1);
    const items = result.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: 12, title: "露营装备清单", author_name: "小明", platform: "xhs" });
    expect(String(items[0].content_excerpt).length).toBe(120);
    // raw_json 这类重字段不进入模型可见的投影
    expect(items[0].raw_json).toBeUndefined();
  });

  it("空结果把 reason 放进 details，三种「0 条」的原因必须分开", async () => {
    mocks.searchNotes.mockResolvedValue({ outcome: "ok", total: 0, items: [] });
    expect((await executeSkill("library_search_notes", { keyword: "露营" }, makeContext())).reason).toBe(
      "没有匹配「露营」的笔记",
    );
    expect((await executeSkill("library_search_notes", {}, makeContext())).reason).toBe("内容库还没有笔记");
    // 只按标签检索时，不能误报「内容库还没有笔记」（质量审查 Issue 1）
    expect((await executeSkill("library_search_notes", { tag_id: 3 }, makeContext())).reason).toBe(
      "标签 3 下还没有笔记",
    );
  });

  it("limit 被钳制在 1..20 后下推给服务层", async () => {
    mocks.searchNotes.mockResolvedValue({
      outcome: "ok",
      total: 30,
      items: Array.from({ length: 20 }, (_, index) => ({ id: index + 1, title: `T${index}` })),
    });
    const result = await executeSkill("library_search_notes", { limit: 999 }, makeContext());
    expect(mocks.searchNotes).toHaveBeenCalledWith(7, { keyword: undefined, tagId: undefined, limit: 20 });
    expect(result.total).toBe(30);
    expect((result.items as unknown[]).length).toBe(20);
  });

  it("tag_id 指向不存在的标签时抛可读错误，非正整数的 tag_id 在触达服务前就被拦下", async () => {
    mocks.searchNotes.mockResolvedValue({ outcome: "tag_not_found" });
    await expect(executeSkill("library_search_notes", { tag_id: 99 }, makeContext())).rejects.toThrow(
      "标签 99 不存在或不属于当前用户",
    );
    await expect(executeSkill("library_search_notes", { tag_id: 1.5 }, makeContext())).rejects.toThrow(
      "tag_id 必须是正整数",
    );
    expect(mocks.searchNotes).toHaveBeenCalledTimes(1);
  });
});

describe("library_note_detail", () => {
  it("正常读取：正文截断到 2000 字、评论截断到 comment_limit、comment_total 是真实条数", async () => {
    mocks.getNoteDetail.mockResolvedValue({
      id: 12,
      title: "露营装备清单",
      author_name: "小明",
      platform: "xhs",
      created_at: "2026-10-10T08:00:00",
      tags: [{ id: 1, name: "露营", color: "#111111" }],
      content: "长".repeat(2500),
    });
    mocks.listNoteComments.mockResolvedValue({
      outcome: "ok",
      items: Array.from({ length: 5 }, (_, index) => ({
        user_name: `用户${index}`,
        content: "评".repeat(300),
        like_count: index,
      })),
    });
    const result = await executeSkill("library_note_detail", { note_id: 12, comment_limit: 2 }, makeContext());
    expect(mocks.getNoteDetail).toHaveBeenCalledWith(7, 12);
    expect(result.note_id).toBe(12);
    expect(result.note_title).toBe("露营装备清单");
    expect(String(result.content).length).toBe(2000);
    expect(result.content_truncated).toBe(true);
    expect(result.comment_total).toBe(5);
    const comments = result.comments as Array<Record<string, unknown>>;
    expect(comments).toHaveLength(2);
    expect(String(comments[0].content).length).toBe(200);
  });

  it("缺少 note_id 或笔记不存在都抛可读错误", async () => {
    await expect(executeSkill("library_note_detail", {}, makeContext())).rejects.toThrow("缺少笔记（note_id）参数");
    mocks.getNoteDetail.mockResolvedValue(null);
    await expect(executeSkill("library_note_detail", { note_id: 99 }, makeContext())).rejects.toThrow(
      "笔记 99 不存在",
    );
  });

  it("没有评论时 comment_total 为 0、comments 为空数组", async () => {
    mocks.getNoteDetail.mockResolvedValue({ id: 12, title: "T", content: "短", tags: [] });
    mocks.listNoteComments.mockResolvedValue({ outcome: "ok", items: [] });
    const result = await executeSkill("library_note_detail", { note_id: 12 }, makeContext());
    expect(result.comment_total).toBe(0);
    expect(result.comments).toEqual([]);
    expect(result.content_truncated).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/lib/server/agent/skill-execute.test.ts`
Expected: FAIL —— 全部用例失败在「未知技能: library_search_notes」（走到 default 分支）。

- [ ] **Step 3: 实现两个 case**

`src/lib/server/agent/skill-catalog.ts` 顶部 import 区追加：

```ts
import { getNoteDetail, listNoteComments, searchNotes } from "../services/note-service";
```

在 `executeSkill` 的 switch 里（`schedule_recommend` 的 case 之后、`default` 之前）插入：

```ts
    case "library_search_notes": {
      const keyword = typeof params.keyword === "string" ? params.keyword.trim() : "";
      const limit = Math.max(1, Math.min(Number(params.limit) || 10, 20));
      // null 视同未传（Number(null) 是 0，会把「没传」误当成「查 id=0」）
      const rawTagId = params.tag_id === undefined || params.tag_id === null ? undefined : Number(params.tag_id);
      if (rawTagId !== undefined && (!Number.isInteger(rawTagId) || rawTagId < 1)) {
        throw new Error("tag_id 必须是正整数");
      }
      // limit 下推到服务层：先切片再序列化，避免为 10 条结果序列化整个内容库
      const result = await searchNotes(userId, { keyword: keyword || undefined, tagId: rawTagId, limit });
      if (result.outcome === "tag_not_found") throw new Error(`标签 ${rawTagId} 不存在或不属于当前用户`);
      // 只回模型需要的字段：完整序列化里的 raw_json 体积大且对模型无用
      const items = result.items.map((item) => ({
        id: item.id,
        title: item.title,
        author_name: item.author_name,
        platform: item.platform,
        created_at: item.created_at,
        content_excerpt: String(item.content ?? "").slice(0, 120),
      }));
      if (items.length === 0) {
        // 空结果的 reason 必须带出来（工具卡默认只显示摘要一行，见 handoff §二.6）；
        // 三种「0 条」的原因必须分开，否则会给出错误结论（质量审查 Issue 1）
        const reason = keyword
          ? `没有匹配「${keyword}」的笔记`
          : rawTagId !== undefined
            ? `标签 ${rawTagId} 下还没有笔记`
            : "内容库还没有笔记";
        return { total: 0, count: 0, items, reason };
      }
      return { total: result.total, count: items.length, items };
    }
    case "library_note_detail": {
      const noteId = Number(params.note_id);
      if (!noteId) throw new Error("缺少笔记（note_id）参数");
      // 同 draft_id：Prisma 会把有限浮点静默截断（3.7 → 3），不能读错笔记
      if (!Number.isInteger(noteId) || noteId < 1) throw new Error("note_id 必须是正整数");
      const commentLimit = Math.max(1, Math.min(Number(params.comment_limit) || 20, 200));
      const detail = await getNoteDetail(userId, noteId);
      if (!detail) throw new Error(`笔记 ${noteId} 不存在`);
      const comments = await listNoteComments(userId, noteId);
      if (comments.outcome === "not_found") throw new Error(`笔记 ${noteId} 不存在`);
      const content = String(detail.content ?? "");
      return {
        note_id: detail.id,
        note_title: detail.title,
        author_name: detail.author_name,
        platform: detail.platform,
        created_at: detail.created_at,
        tags: detail.tags,
        content: content.slice(0, 2000),
        content_truncated: content.length > 2000,
        comment_total: comments.items.length,
        comments: comments.items.slice(0, commentLimit).map((comment) => ({
          user_name: comment.user_name,
          content: String(comment.content ?? "").slice(0, 200),
          like_count: comment.like_count,
        })),
      };
    }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/lib/server/agent/skill-execute.test.ts`
Expected: PASS（7 个用例）

- [ ] **Step 5: 提交**

```bash
git add src/lib/server/agent/skill-catalog.ts src/lib/server/agent/skill-execute.test.ts
git commit -m "feat(agent-tools): library_search_notes / library_note_detail 执行分支（含离线单测）"
```

---

### Task 4 补丁（质量审查修复）

> 本节的改动**已就地更新进上文 Task 1 的服务代码块、Task 3 的 schema 代码块与 Task 4 的 case/test 代码块** —— 照那些代码块实施即可。本节只登记审查发现与处置理由。

| # | 审查发现 | 处置 |
|---|---|---|
| I1 | 只带 `tag_id` 的空结果会误报「内容库还没有笔记」（`keyword ? ... : "内容库还没有笔记"` 只看 keyword）—— 正是硬约束 #5 要防的「0 结果原因不可分」 | **已修**：reason 三分为「没有匹配「X」的笔记 / 标签 N 下还没有笔记 / 内容库还没有笔记」，并在测试里逐条断言 |
| I2 | 先全量序列化再 slice：一次检索 = `1 + 2N` 次查询（N 与 limit 无关），交互式循环里延迟可见（两位审查者先后提出） | **已修（Agent 路径）**：`NoteSearchFilter` 加可选 `limit`（先切片再序列化）+ 结果加 `total`；工具把 `limit` 下推、`total` 读自服务层。**路由路径不传 limit，行为与改造前逐字等价**（R3 保留路由侧 P2） |
| I4 | `tag_id: null` → `Number(null) = 0` → 报「标签 0 不存在」（`""`/`[]` 同理）；只校验 `Number.isFinite` 而服务层要求已校验的整数 | **已修**：`null/undefined` 视同未传；非正整数抛「tag_id 必须是正整数」（测试补 `1.5` 用例） |
| I5 | `tag_id` / `note_id` schema 无上限：超大 id（如 1e10）会让 Prisma 的 int4 溢出错误原文透给模型 | **已修**：两个 schema 加 `maximum: 2147483647`（与 int4 上限一致） |
| I6 | 过渡期护栏集合里 `library_search_notes` / `library_note_detail` 已实现，仍在集合里属死数据、会误导「还剩哪些没实现」 | **已修**：从集合中移除这两项（Task 7 仍整块删除） |
| I3 | `comment_limit ≤ 200` 与 loop 侧 `SUMMARY_LIST_LIMIT = 10` 脱节 | **记录不修**（R6）：先例 `topic_generate` 同款；`comment_total`/`truncated` 都在，不误导 |

补丁提交信息：`fix(agent-tools): 检索空结果按原因分流 + limit 下推 + id 边界校验`。

---

## Task 5: executeSkill —— content_titles + content_tags

**Files:**
- Modify: `src/lib/server/agent/skill-catalog.ts`（+2 个 case）
- Test: `src/lib/server/agent/skill-execute.test.ts`（追加两节）

- [ ] **Step 1: 写失败测试（追加到 skill-execute.test.ts 末尾）**

```ts
describe("content_titles", () => {
  it("正常生成：返回 titles 与 count，且参数按契约转发（title/body/count）", async () => {
    const generateTitles = vi.fn(async () => ["标题A", "标题B", "标题C"]);
    const result = await executeSkill(
      "content_titles",
      { title: "露营装备清单", body: "正文", count: 3 },
      makeModelContext({ generateTitles }),
    );
    expect(result.titles).toEqual(["标题A", "标题B", "标题C"]);
    expect(result.count).toBe(3);
    expect(result.reason).toBeUndefined();
    // case 的核心职责就是 params → textClient 的参数映射：光断返回值抓不到映射写错（Task 5 审查 Minor 1）
    expect(generateTitles).toHaveBeenCalledWith(
      expect.objectContaining({ title: "露营装备清单", body: "正文", count: 3 }),
    );
  });

  it("未配置模型 / 缺 title（含纯空白）都抛可读错误（不触达 textClient）", async () => {
    await expect(executeSkill("content_titles", { title: "T" }, makeContext())).rejects.toThrow(
      "未配置文本模型，无法生成标题",
    );
    await expect(executeSkill("content_titles", {}, makeModelContext({}))).rejects.toThrow("缺少标题（title）参数");
    // trim 是 title 校验里唯一有真实分支价值的一行，单独钉住（Task 5 审查 Minor 4）
    await expect(executeSkill("content_titles", { title: "   " }, makeModelContext({}))).rejects.toThrow(
      "缺少标题（title）参数",
    );
  });

  it("count 参数被钳制在 1..10 后才传给 textClient", async () => {
    const generateTitles = vi.fn(async () => ["A"]);
    await executeSkill("content_titles", { title: "T", count: 999 }, makeModelContext({ generateTitles }));
    expect(generateTitles).toHaveBeenCalledWith(expect.objectContaining({ count: 10 }));
  });

  it("模型返回空数组时把 reason 放进 details（摘要会带出来）", async () => {
    const result = await executeSkill(
      "content_titles",
      { title: "T" },
      makeModelContext({ generateTitles: vi.fn(async () => []) }),
    );
    expect(result.titles).toEqual([]);
    expect(result.count).toBe(0);
    expect(result.reason).toBe("模型未返回可用标题");
  });
});

describe("content_tags", () => {
  it("正常生成：返回 tags 与 count", async () => {
    const result = await executeSkill(
      "content_tags",
      { title: "露营装备清单", count: 2 },
      makeModelContext({ generateTags: vi.fn(async () => ["露营", "户外"]) }),
    );
    expect(result.tags).toEqual(["露营", "户外"]);
    expect(result.count).toBe(2);
  });

  it("未配置模型 / 缺 title（含纯空白）都抛可读错误", async () => {
    await expect(executeSkill("content_tags", { title: "T" }, makeContext())).rejects.toThrow(
      "未配置文本模型，无法生成标签",
    );
    await expect(executeSkill("content_tags", {}, makeModelContext({}))).rejects.toThrow("缺少标题（title）参数");
    await expect(executeSkill("content_tags", { title: "   " }, makeModelContext({}))).rejects.toThrow(
      "缺少标题（title）参数",
    );
  });

  it("count 参数被钳制在 1..20 后才传给 textClient，空结果带 reason", async () => {
    const generateTags = vi.fn(async () => []);
    const result = await executeSkill("content_tags", { title: "T", count: 999 }, makeModelContext({ generateTags }));
    expect(generateTags).toHaveBeenCalledWith(expect.objectContaining({ count: 20 }));
    expect(result.reason).toBe("模型未返回可用标签");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/lib/server/agent/skill-execute.test.ts`
Expected: FAIL —— 新增 7 条用例全部失败在过渡期护栏的错误上（「技能 content_titles / content_tags 的执行分支尚未实现」）。

- [ ] **Step 3: 实现两个 case**

在 `library_note_detail` case 之后插入：

```ts
    case "content_titles": {
      if (!modelConfig || !apiKey) throw new Error("未配置文本模型，无法生成标题");
      const title = String(params.title ?? "").trim();
      if (!title) throw new Error("缺少标题（title）参数");
      const count = Math.max(1, Math.min(Number(params.count) || 5, 10));
      const titles = await textClient.generateTitles({
        modelConfig,
        apiKey,
        onUsage: makeUsageLogger(userId, modelConfig.modelName),
        title,
        body: typeof params.body === "string" ? params.body : "",
        count,
      });
      // 空结果带 reason（工具卡摘要会显示「生成 0 个标题（模型未返回可用标题）」）
      if (titles.length === 0) return { titles, count: 0, reason: "模型未返回可用标题" };
      return { titles, count: titles.length };
    }
    case "content_tags": {
      if (!modelConfig || !apiKey) throw new Error("未配置文本模型，无法生成标签");
      const title = String(params.title ?? "").trim();
      if (!title) throw new Error("缺少标题（title）参数");
      const count = Math.max(1, Math.min(Number(params.count) || 8, 20));
      const tags = await textClient.generateTags({
        modelConfig,
        apiKey,
        onUsage: makeUsageLogger(userId, modelConfig.modelName),
        title,
        body: typeof params.body === "string" ? params.body : "",
        count,
      });
      if (tags.length === 0) return { tags, count: 0, reason: "模型未返回可用标签" };
      return { tags, count: tags.length };
    }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/lib/server/agent/skill-execute.test.ts`
Expected: PASS（14 个用例）

- [ ] **Step 5: 提交**

```bash
git add src/lib/server/agent/skill-catalog.ts src/lib/server/agent/skill-execute.test.ts
git commit -m "feat(agent-tools): content_titles / content_tags 执行分支（只返回数组不落库）"
```

---

## Task 6: executeSkill —— content_rewrite

**Files:**
- Modify: `src/lib/server/agent/skill-catalog.ts`（+1 个 case）
- Test: `src/lib/server/agent/skill-execute.test.ts`（追加一节）

> 本工具**会直接覆盖用户草稿正文、无撤销**（D-C0-b 已确认沿用）。执行分支必须在 `rewriteNote` 成功后才 `update`，且只改 `body`（不动 title / 归属）。

- [ ] **Step 1: 写失败测试（追加到 skill-execute.test.ts 末尾）**

```ts
describe("content_rewrite", () => {
  it("正常改写：只更新正文，返回 draft_id/title/length", async () => {
    mocks.draftFindFirst.mockResolvedValue({ id: 12, title: "露营装备清单", body: "旧正文" });
    mocks.draftUpdate.mockResolvedValue({ id: 12, title: "露营装备清单", body: "新正文" });
    const rewriteNote = vi.fn(async () => "新正文");
    const result = await executeSkill(
      "content_rewrite",
      { draft_id: 12, instruction: "更口语化", intensity: "deep" },
      makeModelContext({ rewriteNote }),
    );
    expect(mocks.draftFindFirst).toHaveBeenCalledWith({ where: { id: 12, userId: 7 } });
    expect(rewriteNote).toHaveBeenCalledWith(
      expect.objectContaining({ title: "露营装备清单", body: "旧正文", instruction: "更口语化", intensity: "deep" }),
    );
    // 只改 body —— 标题与归属不能被改写破坏
    expect(mocks.draftUpdate).toHaveBeenCalledWith({ where: { id: 12 }, data: { body: "新正文" } });
    expect(result).toEqual({ draft_id: 12, title: "露营装备清单", length: 3 });
  });

  it("intensity 非法或缺省时回退 medium（模型可能给任意字符串）", async () => {
    mocks.draftFindFirst.mockResolvedValue({ id: 12, title: "T", body: "B" });
    mocks.draftUpdate.mockResolvedValue({ id: 12, title: "T", body: "N" });
    const rewriteNote = vi.fn(async () => "N");
    await executeSkill("content_rewrite", { draft_id: 12, intensity: "extreme" }, makeModelContext({ rewriteNote }));
    expect(rewriteNote).toHaveBeenCalledWith(expect.objectContaining({ intensity: "medium" }));
    await executeSkill("content_rewrite", { draft_id: 12 }, makeModelContext({ rewriteNote }));
    expect(rewriteNote).toHaveBeenLastCalledWith(expect.objectContaining({ intensity: "medium" }));
  });

  it("未配置模型 / 缺 draft_id / 草稿不存在都抛可读错误，且不写库", async () => {
    await expect(executeSkill("content_rewrite", { draft_id: 12 }, makeContext())).rejects.toThrow(
      "未配置文本模型，无法改写草稿",
    );
    await expect(executeSkill("content_rewrite", {}, makeModelContext({}))).rejects.toThrow("缺少草稿（draft_id）参数");
    mocks.draftFindFirst.mockResolvedValue(null);
    await expect(executeSkill("content_rewrite", { draft_id: 99 }, makeModelContext({}))).rejects.toThrow(
      "草稿 99 不存在",
    );
    expect(mocks.draftUpdate).not.toHaveBeenCalled();
  });

  it("改写失败时不写库（先成功再覆盖，失败保留原文）", async () => {
    mocks.draftFindFirst.mockResolvedValue({ id: 12, title: "T", body: "旧" });
    const rewriteNote = vi.fn(async () => {
      throw new Error("模型超时");
    });
    await expect(
      executeSkill("content_rewrite", { draft_id: 12 }, makeModelContext({ rewriteNote })),
    ).rejects.toThrow("模型超时");
    expect(mocks.draftUpdate).not.toHaveBeenCalled();
  });

  it("改写返回空内容时不写库（空串绝不能覆盖用户正文）", async () => {
    mocks.draftFindFirst.mockResolvedValue({ id: 12, title: "T", body: "旧正文" });
    const rewriteNote = vi.fn(async () => "   ");
    const result = await executeSkill("content_rewrite", { draft_id: 12 }, makeModelContext({ rewriteNote }));
    expect(mocks.draftUpdate).not.toHaveBeenCalled();
    expect(result).toMatchObject({ draft_id: 12, length: 0, reason: "模型返回空内容，原文未改动" });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/lib/server/agent/skill-execute.test.ts`
Expected: FAIL —— 5 条新用例全部失败在过渡期护栏的错误上（「技能 content_rewrite 的执行分支尚未实现」）。

- [ ] **Step 3: 实现 case**

在 `content_tags` case 之后插入：

```ts
    case "content_rewrite": {
      if (!modelConfig || !apiKey) throw new Error("未配置文本模型，无法改写草稿");
      const draftId = Number(params.draft_id);
      if (!draftId) throw new Error("缺少草稿（draft_id）参数");
      // Prisma 会把有限浮点 id 静默截断（12.7 → 12，实测）—— 唯一破坏性工具绝不能改错草稿
      if (!Number.isInteger(draftId) || draftId < 1) throw new Error("draft_id 必须是正整数");
      const draft = await prisma.aiDraft.findFirst({ where: { id: draftId, userId } });
      if (!draft) throw new Error(`草稿 ${draftId} 不存在`);
      // 强度只认三档，非法值回退 medium（与路由侧 zod 枚举同口径）
      const intensity = params.intensity === "light" || params.intensity === "deep" ? params.intensity : "medium";
      const body = await textClient.rewriteNote({
        modelConfig,
        apiKey,
        onUsage: makeUsageLogger(userId, modelConfig.modelName),
        title: draft.title,
        body: draft.body,
        instruction: typeof params.instruction === "string" ? params.instruction : "",
        intensity,
      });
      // 顺序很重要：先拿到改写结果再覆盖，失败时草稿保持原样（无撤销，不能让失败把正文清空）
      // 空内容同理：模型可能返回空串/纯空白，绝不能用它覆盖用户正文（唯一破坏性工具）
      if (!body.trim()) {
        return { draft_id: draft.id, title: draft.title, length: 0, reason: "模型返回空内容，原文未改动" };
      }
      const updated = await prisma.aiDraft.update({ where: { id: draft.id }, data: { body } });
      return { draft_id: updated.id, title: updated.title, length: body.length };
    }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/lib/server/agent/skill-execute.test.ts`
Expected: PASS（19 个用例）

- [ ] **Step 5: 提交**

```bash
git add src/lib/server/agent/skill-catalog.ts src/lib/server/agent/skill-execute.test.ts
git commit -m "feat(agent-tools): content_rewrite 执行分支（先成功再覆盖，失败保留原文）"
```

---

## Task 7: executeSkill —— analytics_reports + kb_get

**Files:**
- Modify: `src/lib/server/agent/skill-catalog.ts`（+2 个 case + 1 个 import）
- Test: `src/lib/server/agent/skill-execute.test.ts`（追加两节）

- [ ] **Step 1: 写失败测试（追加到 skill-execute.test.ts 末尾）**

```ts
describe("analytics_reports", () => {
  it("正常读取：返回 reports 与 count，limit 钳制在 1..20", async () => {
    const reports = [{ id: 1, keyword: "露营" }, { id: 2, keyword: "收纳" }];
    mocks.listExplosionReports.mockResolvedValue(reports);
    const result = await executeSkill("analytics_reports", { limit: 999 }, makeContext());
    expect(mocks.listExplosionReports).toHaveBeenCalledWith(7, 20);
    expect(result.count).toBe(2);
    expect(result.reports).toEqual(reports);
    // 契约：有产出时不带 reason（与 hot_refresh 同款）
    expect(result.reason).toBeUndefined();
  });

  it("空结果表明原因（用户知道去哪里产出报告）", async () => {
    mocks.listExplosionReports.mockResolvedValue([]);
    const result = await executeSkill("analytics_reports", {}, makeContext());
    expect(mocks.listExplosionReports).toHaveBeenCalledWith(7, 5);
    expect(result.count).toBe(0);
    expect(result.reason).toBe("还没有拆解报告，可先在「策划工作台 → 爆款拆解」生成");
  });
});

describe("kb_get", () => {
  it("正常读取：返回 context 与 length", async () => {
    mocks.buildKbContext.mockResolvedValue("【账号定位】露营装备测评");
    const result = await executeSkill("kb_get", {}, makeContext());
    expect(mocks.buildKbContext).toHaveBeenCalledWith(7);
    expect(result.length).toBe("【账号定位】露营装备测评".length);
    expect(result.context).toBe("【账号定位】露营装备测评");
    expect(result.reason).toBeUndefined();
  });

  it("知识库为空时 length=0、context 为空串并带出 reason", async () => {
    mocks.buildKbContext.mockResolvedValue("");
    const result = await executeSkill("kb_get", {}, makeContext());
    expect(result.length).toBe(0);
    expect(result.context).toBe("");
    expect(result.reason).toBe("知识库尚未配置，可先在「设置 → 账号知识库」填写账号定位与口吻");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/lib/server/agent/skill-execute.test.ts`
Expected: FAIL —— 4 条新用例全部失败在过渡期护栏的错误上（「技能 analytics_reports / kb_get 的执行分支尚未实现」）。

- [ ] **Step 3: 实现两个 case**

`src/lib/server/agent/skill-catalog.ts` 顶部 import 区追加：

```ts
import { listExplosionReports } from "../services/exploration-service";
```

在 `content_rewrite` case 之后插入：

```ts
    case "analytics_reports": {
      const limit = Math.max(1, Math.min(Number(params.limit) || 5, 20));
      const reports = await listExplosionReports(userId, limit);
      if (reports.length === 0) {
        return { reports, count: 0, reason: "还没有拆解报告，可先在「策划工作台 → 爆款拆解」生成" };
      }
      return { reports, count: reports.length };
    }
    case "kb_get": {
      // buildKbContext 只在所有字段为空时返回空串（每个 section 都带非空白标签前缀），
      // 因此 !context 恰好等价于「未配置」（质量审查 Minor 3）
      const context = await buildKbContext(userId);
      if (!context) {
        return { context: "", length: 0, reason: "知识库尚未配置，可先在「设置 → 账号知识库」填写账号定位与口吻" };
      }
      return { context, length: context.length };
    }
```

- [ ] **Step 4: 删除过渡期护栏（Task 3 补丁的 P3）**

13 个执行分支已全部落齐，删除 `skill-catalog.ts` 里的 `INTERIM_UNIMPLEMENTED_SKILLS` 常量与 `default:` 分支开头的护栏判断（连同注释）。护栏只此一处，删干净后 grep `INTERIM_UNIMPLEMENTED_SKILLS` 应为 0 命中。

- [ ] **Step 5: 跑测试确认通过**

Run:
```bash
npx vitest run src/lib/server/agent/skill-execute.test.ts   # 期望 25 个用例（7 library + 7 titles/tags + 5 rewrite + 2 Task 6 审查补强 + 4 本任务）
npx vitest run                                              # 期望 29 文件 / 354 用例全绿
npx tsc --noEmit                                            # 期望无输出
```
Expected: 全绿。至此 `executeSkill` 已覆盖全部 13 个工具，可以重启 worker 做真实验收。

- [ ] **Step 6: 提交**

```bash
git add src/lib/server/agent/skill-catalog.ts src/lib/server/agent/skill-execute.test.ts
git commit -m "feat(agent-tools): analytics_reports / kb_get 执行分支（空结果带原因）"
```

---

### Task 7 补丁（质量审查修复）

> 本节改动**已就地更新进上文各代码块**（Task 4 的 library_note_detail、Task 6 的 content_rewrite、Task 7 的两个 case）；照那些代码块实施即可。审查发现与处置：

| # | 审查发现 | 处置 |
|---|---|---|
| I1 | **`draft_id: 12.7` 的测试断言基于错误前提**：实测 Prisma 会把有限浮点 id **静默截断**（`1.4`/`1.9 → 1`，`12.7 → 12`），只有 `NaN`/`Infinity` 抛校验错。原文案（「Prisma 返回 null → 草稿 12.7 不存在」）是错的 —— 生产上它会**改写草稿 12**，而测试因 mock 硬写成 null 才变绿（唯一破坏性工具上的假信心） | **已修**：content_rewrite 加 `Number.isInteger(draftId) && draftId >= 1` 守卫（与 `tag_id` 同款先例）+ 测试改为断言抛「draft_id 必须是正整数」 |
| I2 | `library_note_detail` 的 `note_id` 同类风险（`3.7 → 3` 读错笔记） | **已修**：同款整数守卫（`note_id 必须是正整数`） |
| M2 | 两处 reason 的页面指引与真实 UI 不符（「爆款拆解」是**策划工作台**页上的卡片；知识库字段在**设置 → 账号知识库**） | **已修**：`可先在「策划工作台 → 爆款拆解」生成` / `可先在「设置 → 账号知识库」填写账号定位与口吻`（三处同步：case + 两个测试文件） |
| M3 | `kb_get` 的 `if (!context)` 未说明「空白串为何不可达」 | **已修**：补注释（每个 section 都带非空白标签前缀，`!context` ⟺ 未配置） |
| M5 | 两个正例没断言「reason 只在 0 时带出」，kb 空例没断言 `context === ""` | **已修**：三处各补 1 条断言 |
| M6 | 护栏删除后「目录 key ↔ 执行分支」不变量失去运行时保护 | **Task 8 处理**：改为在 `default:` 加 2 行**运行时**守卫（`findSkillDefinition(skillKey)` 命中即抛「已登记在目录却缺少执行分支」），比只靠测试守卫更可靠且自维护 |

补丁提交信息：`fix(agent-tools): 浮点 id 守卫 + reason 页面指引订正 + 空结果断言补强`。

---

## Task 8: agent.md 护栏 + prompt 守卫测试

**Files:**
- Modify: `src/prompts/agent.md`
- Test: `src/prompts/agent-prompt.test.ts`（新建）
- Modify: `src/lib/server/agent/skill-execute.test.ts`（补一条「目录 ↔ 执行分支」不变量守卫 —— Task 7 审查发现：过渡期护栏删除后，这条不变量失去运行时保护）

- [ ] **Step 1: 写失败测试**

创建 `src/prompts/agent-prompt.test.ts`：

```ts
/**
 * Agent 系统提示词守卫
 *
 * 只钉两件与验收相关的事：
 *   1. content_rewrite 的改稿护栏（设计稿 §八 风险 5：改写前说明将修改哪篇草稿）
 *   2. {{toolCatalog}} 占位符仍在（由 agent-loop 的 buildToolCatalogText 注入工具目录）
 */
import { describe, expect, it } from "vitest";
import { renderPrompt } from "./loader";

describe("agent.md（Agent 系统提示词）", () => {
  it("包含 content_rewrite 的「改写前先说明改哪篇」护栏", () => {
    const prompt = renderPrompt("agent.md", "system");
    expect(prompt).toContain("content_rewrite");
    expect(prompt).toContain("无法撤销");
    expect(prompt).toContain("先说明");
  });

  it("保留 {{toolCatalog}} 占位符（渲染器对未提供变量原样保留）", () => {
    expect(renderPrompt("agent.md", "system")).toContain("{{toolCatalog}}");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/prompts/agent-prompt.test.ts`
Expected: FAIL —— 提示词里还没有 `content_rewrite` 护栏。

- [ ] **Step 3: 更新 agent.md**

`src/prompts/agent.md` 的「## 工作方式」列表末尾（第 4 条之后）追加：

```markdown
5. **改稿先说明**：`content_rewrite` 会直接覆盖草稿正文且无法撤销 —— 调用前必须先用一句话说明将要修改哪篇草稿（ID，若已知标题则一并说明），再执行。
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/prompts/agent-prompt.test.ts`
Expected: PASS（2 个用例）

- [ ] **Step 4.5: 补「目录 ↔ 执行分支」不变量守卫（Task 7 审查发现）**

过渡期护栏（Task 7 已删）原本守护的不变量是「目录里每个 skillKey 都有执行分支」—— 护栏删掉后没有任何运行时保护守着它，将来加第 14 个目录项而忘了写 case，就会再次静默走自定义技能的 LLM 兜底产出假结果。**采用运行时守卫（自维护，比只靠测试可靠）**：在 `skill-catalog.ts` 的 `executeSkill` 的 `default:` 分支**注册表查询之前**插入：

```ts
      // 目录里已登记的 skillKey 不该落到这里（说明缺执行分支）：注册表种子会让它静默走 LLM 兜底产出假结果
      if (findSkillDefinition(skillKey)) {
        throw new Error(`技能 ${skillKey} 已登记在目录却缺少执行分支（内部错误，请检查 skill-catalog）`);
      }
```

**并把同类隐患一次关掉**（Task 7 补丁时连带发现）：`review_submit`（**write** 级）与 `script_generate` 的 `draft_id` 也只做 `Number()` 假值校验 —— `draft_id: 12.7` 会被 Prisma 截断成 12，给**错误的草稿**建审校工单。在 `skill-catalog.ts` 两个 case 的 `if (!draftId) throw ...` 之后各加一行：

```ts
      // Prisma 会把有限浮点 id 静默截断（12.7 → 12）—— write 级工具不能选错草稿
      if (!Number.isInteger(draftId) || draftId < 1) throw new Error("draft_id 必须是正整数");
```

并在 `skill-execute.test.ts` 末尾追加：

```ts
describe("既有工具的 id 守卫（Task 7 审查连带发现）", () => {
  it("review_submit / script_generate 的浮点 draft_id 被先行拦截", async () => {
    await expect(executeSkill("review_submit", { draft_id: 12.7 }, makeModelContext({}))).rejects.toThrow(
      "draft_id 必须是正整数",
    );
    await expect(executeSkill("script_generate", { draft_id: 12.7 }, makeModelContext({}))).rejects.toThrow(
      "draft_id 必须是正整数",
    );
  });
});
```

并在 `src/lib/server/agent/skill-execute.test.ts` 末尾追加守卫测试（正向断言这条新消息 + 反向确认不落进兜底文案）：

```ts
describe("目录 ↔ 执行分支不变量", () => {
  it("目录里每个 skillKey 都有自己的执行分支（不落进自定义技能的 LLM 兜底）", async () => {
    // 未配置模型的上下文：任何实现了 case 的技能要么用自己的错误文案失败、要么正常返回；
    // 只有「没有 case、掉进 default 兜底」的 key 才会命中下面两句文案之一
    const catalogKeys = SKILL_CATALOG.map((definition) => definition.skillKey);
    expect(catalogKeys).toHaveLength(13);
    for (const skillKey of catalogKeys) {
      let message = "";
      try {
        await executeSkill(skillKey, {}, makeContext());
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message, `${skillKey} 缺执行分支（落到 default 的目录守卫）`).not.toContain("已登记在目录却缺少执行分支");
      expect(message, `${skillKey} 分落进自定义技能兜底`).not.toBe("未配置文本模型，无法执行自定义技能");
      expect(message, `${skillKey} 疑似未在目录中注册`).not.toContain("未知技能");
    }
  });
});
```

并在文件顶部 import 处补上 `SKILL_CATALOG`（与 `executeSkill` 同一行的 import 里加）：

```ts
import { SKILL_CATALOG, executeSkill, type SkillContext } from "./skill-catalog";
```

Run: `npx vitest run src/lib/server/agent/skill-execute.test.ts`（期望 27 用例：26 + 1 条 id 守卫）与全量 `npx vitest run`（**实测订正：30 文件 / 358 用例** —— 原估 29/356 为陈旧计数：Task 4 新增的测试文件已计入文件数，Task 8 实加 4 条用例）。

- [ ] **Step 5: 提交**

```bash
git add src/prompts/agent.md src/prompts/agent-prompt.test.ts
git commit -m "feat(agent-prompt): 补 content_rewrite 改稿护栏（改写前先说明改哪篇）"
```

---

## Task 9: C 块端到端脚本（真模型 2 个工具）

**Files:**
- Create: `src/scripts/agent-c-tools-smoke.ts`

> **前置**：worker 必须用**最新代码**跑（旧进程会加载旧 catalog）。按进程树清完再启：
> ```powershell
> Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
>   Where-Object { $_.CommandLine -like '*worker/index.mts*' } |
>   ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
> ```
> 然后 `npx tsx src/worker/index.mts`。

- [ ] **Step 1: 写脚本**

创建 `src/scripts/agent-c-tools-smoke.ts`：

```ts
/**
 * Agent P1-C 新工具端到端验收脚本（真模型，需 worker）
 *
 * 用法（两个终端）：
 *   终端 A：npx tsx src/worker/index.mts          （必须用最新代码重启）
 *   终端 B：npx tsx src/scripts/agent-c-tools-smoke.ts
 *
 * 与另外两个脚本的分工：
 *   - agent-smoke.ts（P0）：验「循环能不能跑」；agent-api-smoke.ts（P1-A）：验接口契约；
 *   - 本脚本：验 C 块 7 个新工具里**风险最高的 2 个**能被真实模型调用、行落库、产出真的变了
 *     （设计稿 §7.1：其余 5 个由离线单测覆盖 schema / 摘要 / 参数映射）。
 *     选中的两条路径：library_search_notes（唯一先做抽取重构的读工具）、
 *     content_rewrite（唯一 write 工具，直接覆盖用户草稿）。
 *
 * 验收项（任一不通过即 exit 1）：
 *   1. 内容库检索：模型调用 library_search_notes → 行 succeeded、摘要非空、items 命中种子笔记
 *   2. 去 AI 味改写：模型调用 content_rewrite → 行 succeeded、draft_id 正确、草稿正文真的被改写、
 *      run 里落了 kind=draft 的工件事件、改写前的助手文本说明了要改哪篇草稿
 *
 * 脚本自己造数据、自己清理（finally 兜底）。
 */
import { prisma } from "../lib/server/core/db";
import { shanghaiNow } from "../lib/server/core/time";
import { appendMessage, createConversation, createRunForMessage } from "../lib/server/services/agent-service";

/** 断言：不通过就抛错 —— 验收脚本必须能失败 */
function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`验收未通过：${message}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 轮询等待 Run 进入终态（与 P0 脚本同口径） */
async function waitForRun(runId: number, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await prisma.agentRun.findUnique({ where: { id: runId } });
    if (run && ["succeeded", "failed", "cancelled"].includes(run.status)) return run.status;
    await sleep(2000);
  }
  return "timeout";
}

interface OneRun {
  conversationId: number;
  runId: number;
  taskId: number;
  status: string;
}

/** 发一条消息并等 Run 跑完 */
async function runOnce(options: { userId: number; title: string; prompt: string; timeoutMs: number }): Promise<OneRun> {
  const conversation = await createConversation(options.userId, options.title);
  const message = await appendMessage({ conversationId: conversation.id, role: "user", content: options.prompt });
  const run = await createRunForMessage({
    conversationId: conversation.id,
    userId: options.userId,
    messageId: message.id,
  });
  console.log(`  会话 ${conversation.id} / Run ${run.id}：${options.prompt}`);
  const status = await waitForRun(run.id, options.timeoutMs);
  return { conversationId: conversation.id, runId: run.id, taskId: run.taskId, status };
}

/** 清掉一次 Run 相关的全部行（含会话与消息） */
async function cleanupRun(item: OneRun): Promise<void> {
  await prisma.agentEvent.deleteMany({ where: { runId: item.runId } });
  await prisma.agentToolCall.deleteMany({ where: { runId: item.runId } });
  await prisma.agentRun.delete({ where: { id: item.runId } }).catch(() => undefined);
  await prisma.task.delete({ where: { id: item.taskId } }).catch(() => undefined);
  await prisma.agentMessage.deleteMany({ where: { conversationId: item.conversationId } });
  await prisma.agentConversation.delete({ where: { id: item.conversationId } }).catch(() => undefined);
}

async function main(): Promise<void> {
  const modelConfig = await prisma.modelConfig.findFirst({
    where: { modelType: "text", isDefault: true, encryptedApiKey: { not: "" } },
    orderBy: { id: "asc" },
  });
  if (!modelConfig) throw new Error("数据库里没有默认文本模型，先在界面上配一个");
  const user = await prisma.user.findUnique({ where: { id: modelConfig.userId } });
  if (!user) throw new Error(`默认文本模型 ${modelConfig.id} 挂在已不存在的用户上`);
  console.log(`目标用户 ${user.id}（${user.username}），模型 ${modelConfig.modelName}`);

  const finished: OneRun[] = [];
  const seededNoteIds: number[] = [];
  let seededDraftId: number | null = null;

  try {
    // 种子：关键词带时间戳，避免与库里的真实笔记撞车
    const keyword = `P1C冒烟${Date.now()}`;
    for (const suffix of ["甲", "乙"]) {
      const note = await prisma.note.create({
        data: {
          userId: user.id,
          platformAccountId: 0,
          platform: "xhs",
          noteId: `${keyword}_${suffix}`,
          title: `${keyword}${suffix} 露营装备怎么选`,
          content: "这是 C 块验收脚本写入的种子笔记，用于验证内容库检索与详情读取链路。",
          authorName: "C块验收种子",
          createdAt: shanghaiNow(),
        },
      });
      seededNoteIds.push(note.id);
    }
    const draftBody =
      "综上所述，随着生活水平的不断提高，露营已成为一种备受青睐的户外休闲方式。首先，我们需要准备帐篷；其次，我们需要准备睡袋。";
    const draft = await prisma.aiDraft.create({
      data: { userId: user.id, platform: "xhs", title: `${keyword} 改写用草稿`, body: draftBody, createdAt: shanghaiNow() },
    });
    seededDraftId = draft.id;
    console.log(`种子：笔记 ${seededNoteIds.join("、")}，草稿 ${draft.id}`);

    // ========== 1) library_search_notes ==========
    const first = await runOnce({
      userId: user.id,
      title: "C 块验收：内容库检索",
      prompt: `请用 library_search_notes 工具检索关键词「${keyword}」，告诉我一共找到几篇笔记。`,
      timeoutMs: 5 * 60 * 1000,
    });
    finished.push(first);
    assert(first.status === "succeeded", `检索 Run 应为 succeeded，实际 ${first.status}`);
    const rows1 = await prisma.agentToolCall.findMany({ where: { runId: first.runId }, orderBy: { stepIndex: "asc" } });
    console.log(`  工具调用：${rows1.map((row) => `${row.stepIndex}:${row.toolName}:${row.status}`).join(", ") || "（无）"}`);
    const searchRow = rows1.find((row) => row.toolName === "library_search_notes");
    assert(searchRow !== undefined, `模型没有调用 library_search_notes（实际：${rows1.map((row) => row.toolName).join(",") || "无"}）`);
    assert(searchRow.status === "succeeded", `library_search_notes 应为 succeeded，实际 ${searchRow.status}`);
    assert((searchRow.summary ?? "").length > 0, "library_search_notes 的摘要为空（工具卡会显示空白）");
    const searchResult = (searchRow.result ?? {}) as { items?: Array<{ id?: number }> };
    const itemIds = (searchResult.items ?? []).map((item) => Number(item.id));
    assert(
      seededNoteIds.every((id) => itemIds.includes(id)),
      `检索结果应包含两篇种子笔记 ${seededNoteIds.join("、")}，实际 ${itemIds.join("、") || "（空）"}`,
    );
    console.log(`【1/2】内容库检索 通过：摘要「${searchRow.summary}」，items 命中 ${seededNoteIds.length} 篇种子笔记`);

    // ========== 2) content_rewrite ==========
    const second = await runOnce({
      userId: user.id,
      title: "C 块验收：去 AI 味改写",
      prompt: `请对草稿 #${draft.id} 做「去 AI 味」改写（强度 medium），改写前先说明你要修改哪篇草稿。`,
      timeoutMs: 5 * 60 * 1000,
    });
    finished.push(second);
    assert(second.status === "succeeded", `改写 Run 应为 succeeded，实际 ${second.status}`);
    const rows2 = await prisma.agentToolCall.findMany({ where: { runId: second.runId }, orderBy: { stepIndex: "asc" } });
    console.log(`  工具调用：${rows2.map((row) => `${row.stepIndex}:${row.toolName}:${row.status}`).join(", ") || "（无）"}`);
    const rewriteRow = rows2.find((row) => row.toolName === "content_rewrite");
    assert(rewriteRow !== undefined, `模型没有调用 content_rewrite（实际：${rows2.map((row) => row.toolName).join(",") || "无"}）`);
    assert(rewriteRow.status === "succeeded", `content_rewrite 应为 succeeded，实际 ${rewriteRow.status}`);
    assert(
      Number((rewriteRow.params as { draft_id?: number })?.draft_id) === draft.id,
      `content_rewrite 的 draft_id 应为 ${draft.id}，实际 ${JSON.stringify(rewriteRow.params)}`,
    );
    assert((rewriteRow.summary ?? "").includes("已改写草稿"), `摘要应形如「已改写草稿 …」，实际「${rewriteRow.summary}」`);

    const rewritten = await prisma.aiDraft.findUnique({ where: { id: draft.id } });
    assert(rewritten !== null, `草稿 ${draft.id} 不见了`);
    assert(rewritten.body !== draftBody, "草稿正文没有被改写（与改写前完全相同）");
    assert(rewritten.body.trim().length > 0, "改写后的草稿正文为空");
    assert(
      rewritten.title === draft.title && rewritten.userId === user.id,
      "改写不应改动草稿标题或归属",
    );

    // 工件事件：改写产出必须进工件面板（kind=draft、id=草稿 id）
    const artifactEvents = await prisma.agentEvent.findMany({ where: { runId: second.runId, type: "artifact" } });
    const draftArtifact = artifactEvents.find((event) => {
      const payload = event.payload as { kind?: string; id?: number };
      return payload.kind === "draft" && Number(payload.id) === draft.id;
    });
    assert(draftArtifact !== undefined, `没有 kind=draft、id=${draft.id} 的工件事件（右栏不会出现工件卡）`);

    // 护栏：agent.md 要求改写**前**说明将修改哪篇（设计稿 §八 风险 5）。
    // 「前」必须用事件时序钉死 —— 只扫全部助手文本的话，模型在收尾总结里才提到 #id 也会通过（Task 9 审查发现）
    const startEvents = await prisma.agentEvent.findMany({
      where: { runId: second.runId, type: "tool_execution_start" },
      orderBy: { id: "asc" },
    });
    // 用 toolCallId 关联（与 agent_tool_calls 行同一把键），不依赖 start 载荷里是否带 toolName
    const rewriteStart = startEvents.find((event) => {
      const payload = event.payload as { toolCallId?: string };
      return String(payload.toolCallId ?? "") === rewriteRow.toolCallId;
    });
    assert(rewriteStart !== undefined, "没有 content_rewrite 的 tool_execution_start 事件（无法验证「改写前已说明」的时序）");
    const messageEnds = await prisma.agentEvent.findMany({
      where: { runId: second.runId, type: "message_end" },
      orderBy: { id: "asc" },
    });
    const announced = messageEnds.some((event) => {
      const payload = event.payload as { role?: string; text?: string };
      const text = typeof payload.text === "string" ? payload.text : "";
      return (
        event.id < rewriteStart.id &&
        payload.role === "assistant" &&
        (text.includes(`#${draft.id}`) || text.includes(draft.title))
      );
    });
    assert(announced, `改写**前**的助手文本没有说明将修改哪篇草稿（未出现 #${draft.id} 或标题「${draft.title}」）`);
    console.log(
      `【2/2】去 AI 味改写 通过：草稿 ${draft.id} 正文 ${draftBody.length} → ${rewritten.body.length} 字，工件事件已落，改写前已说明`,
    );

    console.log("\nP1-C 新工具端到端验收全部通过");
  } finally {
    for (const item of finished) {
      await cleanupRun(item).catch((error) => {
        console.warn(`[清理] Run ${item.runId} 清理失败：${(error as Error).message}`);
      });
    }
    if (seededDraftId !== null) {
      await prisma.aiDraft.delete({ where: { id: seededDraftId } }).catch(() => undefined);
    }
    if (seededNoteIds.length > 0) {
      await prisma.note.deleteMany({ where: { id: { in: seededNoteIds } } }).catch(() => undefined);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("验收失败:", error);
    process.exit(1);
  });
```

> **执行偏差登记（C9 实测，代码块其余部分与实现一致）**：脚本实际把 `assert` 的返回类型由代码块里的 `: void` 改成了 `asserts condition`（纯类型标注，运行时行为不变）—— 理由：`: void` 会让下游 **16 处**可选值收窄失效、`npx tsc --noEmit` 报 11×TS18048 + 5×TS18047；兄弟脚本 `agent-api-smoke.ts` 用的就是 `asserts condition`。改动理由已写进提交 `73c07ff` 的提交信息。

- [ ] **Step 2: 停旧 worker → 启新 worker**

Run（PowerShell，见本任务开头的命令）：清掉全部 worker 进程后，`npx tsx src/worker/index.mts` 起新的（留在后台）。
Expected: 新 worker 启动日志里没有断言报错（catalog 与 schema 一一对应、工具名合法）。

- [ ] **Step 3: 跑脚本**

Run: `npx tsx src/scripts/agent-c-tools-smoke.ts`
Expected:
```
【1/2】内容库检索 通过：…
【2/2】去 AI 味改写 通过：…
P1-C 新工具端到端验收全部通过
```
约 1–3 分钟（两轮真实模型运行）。

**若失败**：常见三类——
- `模型没有调用 xxx`：换个更直白的提问（脚本里的 prompt 已点名工具名），或确认 worker 是**新代码**（旧进程会打「未知技能」）。
- `改写前的助手文本没有说明将修改哪篇`：agent.md 护栏没生效（检查 Task 8 是否已合并、worker 是否重启）。
- **content_rewrite 的模型请求被 provider 400 拒绝**（质量审查 M8 的预警）：`intensity` 用了 `anyOf`+`const`，而 Pi 在非 strict 模式把 `tool.parameters` 原样发给 provider；若撞上不兼容的实现，会把该字段降级为普通 `Type.String({ description: "改写强度 light/medium/deep，默认 medium" })`（executeSkill 本来就把非法值回退 medium，行为不受影响），然后重跑本脚本。

- [ ] **Step 4: 提交**

```bash
git add src/scripts/agent-c-tools-smoke.ts
git commit -m "test(agent-tools): C 块端到端验收脚本（真模型跑 library_search_notes 与 content_rewrite）"
```

---

## Task 10: 全量回归 + 交接文档刷新

**Files:**
- Modify: `docs/superpowers/HANDOFF-agent-p1-remaining.md`（刷新为「P1 全部完成」）
- Modify: 本计划（回填「执行进度」表）

- [ ] **Step 1: 静态与单测全量**

Run:
```bash
npx vitest run     # 期望全绿（**30 文件 / 359 用例**；原估 356 为陈旧计数，Task 10a 的长度上限守卫又加 1 条）
npx tsc --noEmit   # 期望无输出
```
Expected: 全绿、无输出。

- [ ] **Step 2: 两个既有端到端脚本（P0 + P1-A）**

worker 已是新代码（Task 9 重启过）；dev server 若没起，先 `npm run dev`。

Run:
```bash
npx tsx src/scripts/agent-smoke.ts        # P0：改了 catalog/loop → 必跑；期望「P0 验收全部通过」
npx tsx src/scripts/agent-api-smoke.ts    # P1-A：接口层未改也应回归；期望 9/9 全过
npx tsx src/scripts/agent-c-tools-smoke.ts # C：可再跑一次确认稳定
```
Expected: 三个脚本全部通过。

- [ ] **Step 3: `next build`（先停 dev server）**

Run（顺序不能反）：
```bash
# 1) 停 dev server（终端里 Ctrl+C，或按端口杀进程）
# 2) npx next build        # 期望 Compiled successfully，路由表含 /agent
# 3) rm -rf .next          # 必须清掉，否则 dev 下没编译过的路由稳定 500
# 4) 重新 npm run dev      # 恢复开发环境
```
Expected: build 成功。

- [ ] **Step 4: 回填「执行进度」表**

把本计划文首「执行进度」表的 10 行状态改为 ✅ 已验收并填入提交哈希（用 `git log --oneline` 核对）。

- [ ] **Step 5: 刷新交接文档**

`docs/superpowers/HANDOFF-agent-p1-remaining.md` 更新为 P1 完成的收口文档：
- 文首状态改为「P1（A/B/C 三块）全部完成并推送」
- §二 C 块一节的 7 个工具标记完成，附关键偏差（D-C1 六路由去重、D-C2 字符串 titleField、D-C3 e2e 选型）
- §四 验收总清单第 8 条改为 ✅（自动化 + 真模型 e2e 覆盖），第 9 条更新为最新数字
- §七 遗留项更新：`docs/` 总代码文档仍缺（独立任务）、B 交接 §七 的独立改进项仍在
- **把本计划文末「遗留项登记」的 R1–R10 一并写进交接**；措辞不要用「无残留」——序列化副本确已归零（5 类 × 5 份 + assets 的 1 份），但归属判定的 4 份副本与 2 个薄包装仍在（R1）

- [ ] **Step 6: 提交**

```bash
git add docs/superpowers
git commit -F commit-msg.txt   # 中文提交信息写进 UTF-8 文件后用 -F 传（命令行传中文会损坏字节）
# commit-msg.txt 内容（首行 + 空行 + 正文）：
# docs(agent): P1-C 收口（7 个工具完成，验收清单第 8 条闭合）
#
# - 工具数 6 → 13；library_* 先抽 note-service（六条路由共用一份查询与序列化）
# - 真模型 e2e 覆盖 library_search_notes 与 content_rewrite 两条最高风险路径
# - 交接文档刷新为「P1 全部完成」
```

- [ ] **Step 7: 收尾（不推送）**

提醒用户：push 由用户本人执行（既定分工）。分支策略：本块直接在 `main` 上提交（与 A 块一致）；若要按 B 块模式用 feature 分支，则从开工前先 `git checkout -b feat/agent-p1c-tools`，收尾 fast-forward 合并回 `main` 再删分支。

---

## 遗留项登记（两段审查发现，记录但**不在 C 块修**）

| # | 发现 | 处置与理由 |
|---|---|---|
| R1 | `getOwnedNote`（归属校验 + 404）仍有 4 处逐字节副本：`[noteId]/assets/route.ts:31-36`、`[noteId]/assets/[assetId]/route.ts:8-13`、`[noteId]/assets/reorder/route.ts:14-19`、`batch-create-drafts/route.ts:29-34`；Task 2 新加的 2 个薄包装也是同一语义 | **记录不修**：项目策略「不要顺手迁移既有路由」（`core/route.ts:42-43`）。将来归口的方案是**路由侧** shared helper（先例 `api/xhs/crawl/shared.ts`），**不要**放进服务层（会引入 http-error） |
| R2 | `GET /api/notes/abc` → 500（`parseInt` 出 NaN 直落 Prisma 校验错误，非 ApiError）。改造前后一致，属**既有缺陷** | **记录不修**：纯搬运任务不该改语义。修法：这 7 条路由改用 `parsePathId`（`core/route.ts:45-49`，返回 400）+ 1 条用例 |
| R3 | `searchNotes` 全量返回 + 调用方分页：N 篇命中 ≈ `1 + 2N` 次查询（每篇各查素材与标签），分页发生在全部序列化之后；`hasAssets/hasComments` 全表扫；`comments` 路由宣称 `page_size ≤ 200` 但 `paginated()` 硬顶 100 | **部分已修**：Task 4 补丁给 `NoteSearchFilter` 加可选 `limit`（先切片再序列化）与 `total`，**Agent 工具路径**的查询数从 `1+2N` 降到 `1+2×limit`。**路由侧仍全量**（行为保持等价，未动）——库大时路由侧仍是 P2 待办 |
| R6 | 工具 schema 的数组上限与 loop 侧 `SUMMARY_LIST_LIMIT = 10`（`context.ts`）脱节：模型可见的数组一律截到 10 条，模型永远看不到第 11 条（`details` 与工具卡展开仍是全量）。**不止 `comment_limit ≤ 200`** —— 同类的还有 `content_tags.count ≤ 20`、`analytics_reports.limit ≤ 20`、`library_search_notes.limit ≤ 20` | **记录不修**：`topic_generate` 的 `count ≤ 20` 已有同类先例；`comment_total` 与 `truncated` 标记都在，不误导。若将来要「翻页」，需在工具层加 offset |
| R7 | id 类参数的守卫已到复制粘贴临界点：**6 处**（`draft_id`×3 / `note_id` / `tag_id` / `schedule_recommend.platform_account_id`），其中 4 处逐字相同、`tag_id` 因可选参数形成第二种形状。补录漏网的 `schedule_recommend.platform_account_id`：目前仍只有 `Number()` + falsy 校验，浮点会被 Prisma 截断（本块未补）。`draft_id: true` 仍会静默解析成 1（今天只有 Pi 侧 `Type.Integer` 挡着）。注释错配（`script_generate` 被写成「write 级」，实为 read）**已在 C8 补丁（`d884dbd`）修正** | **守卫已补齐 5/6**（C7/C8 补丁），**抽取到「下一个带 id 的新工具」或「任一处守卫需要修改」时做**：抽 `requirePositiveIntId(value, label, name)`（label 是中文名词，消息里要用），内部保留「0/NaN → 缺少参数 / 浮点 → 必须是正整数」两段式；别只传 name（会逼出第二套消息模板） |
| R8 | `content_rewrite` 的空内容护栏在真实链路不可达（`ai-service.ts` 的 `contentFromPayload` 遇空白内容直接抛错），是契约测试而非故障复现；若要真正生效，正确位置是 `rewriteNote` 内部（一处覆盖 route 与工具两条调用路径）。另：空内容路径仍返回 `draft_id` → 会照发一条 draft 工件、审计行是 succeeded（可接受：工件指向真实草稿、内容未变） | **记录不修**（护栏便宜且 summarize 依赖 `length: 0` 契约；避免改共享的 ai-service）。**改法与「空的语义」写进交接**，防止后人「顺手」删掉 `draft_id` 把摘要变成「未改动草稿 #0」 |
| R4 | `serializeNote` / `serializeTag` 导出面比当前使用者宽（只被服务内部调用） | 有意保留：它们是协议层 API（Task 1 规格明示导出），不修 |
| R5 | **过渡期「假成功」通道**（Task 3 质量审查实测）：`ensureUserSkills` 把 13 条目录种进 `skill_registry` 后，「目录已登记但执行分支未实现」的技能会走 `executeSkill` 的 `default:` 分支命中注册表、以 instructions 为 system prompt 调 LLM，**静默返回看起来成功的假结果**（原计划文字「会抛未知技能」是错的） | Task 3 补丁加**过渡期护栏**（响亮抛错），Task 7 落完最后一个分支后删除。若在此窗口擅自启动 worker 跑 agent，请以上述护栏行为为准 |
| R9 | **模型可见的工具结果体积无上限**（C 块终审连带发现）：`agent-loop.mts` 的 `afterToolCall` 会用 `summarizeToolResult(details, 10)` **整段替换**工具自带的 content，使 `tool-registry.mts` 的 `TOOL_TEXT_LIMIT = 20_000` 被架空；且 `summarizeToolResult` 只截顶层数组，嵌套数组原样进上下文。`analytics_reports`（报告的 `sample_notes` 等内层结构）是首个可达路径。当前 dev 库 `explosion_reports` 为空故未暴露；后果是上下文压力/成本，不是错误答案（`pruneByCharBudget` 兜底） | **记录不修**：C 块不动 loop 的摘要契约（`summarizeToolResult` 的 10 条截断 + `totals`/`truncated` 是既有契约） |
| R10 | 草稿页 `src/app/(protected)/platforms/xhs/drafts/page.tsx` **不消费 `?id=`**（全文无 `useSearchParams` / `location.search`）—— 工件卡跳转只落在列表、不选中草稿。既有模式（`content_note_pack` 同款），但 C 块新增了第二处使用（`content_rewrite`），值得登记 | **记录不修**（前端改动不在 C 块范围；作为前端 P2 待办登记备查） |

## 附：本计划的自查结论（写计划时已核）

| 检查 | 结论 |
|---|---|
| 设计稿 §7.2 第 8 条（7 个新工具可被模型调用、`agent_tool_calls` 有对应行） | Task 3（13 个工具进目录与 schema）+ Task 4–7（全部 7 个有执行分支）+ Task 9（真模型 e2e） |
| 设计稿 §6.2 的 riskLevel（逐个体证） | Task 3 的 riskLevel 断言表逐条写明依据（读函数体，不凭名字） |
| 设计稿 §6.3（titles/tags 只返回数组不落库） | Task 5 的 case 只返回 `{ titles/tags, count }`，无 artifact 声明 |
| 设计稿 §6.5（每个工具都有 summarize） | Task 3 的 7 个条目全部带 summarize，并有精确文案断言 |
| 设计稿 §八 风险 5（agent.md 护栏） | Task 8 |
| handoff §二 配套 1–6 条 | 1→Task 3；2→Task 3；3→Task 3（下划线命名）；4→Task 8；5→Task 3；6→Task 3/4/5/6/7（空结果 reason） |
| 无占位符（每个代码步骤都是完整代码） | 已逐 Task 核过 |
| 类型一致性（`NoteSearchResult` / `NoteCommentsResult` / `notes.total` 等键名跨任务一致） | 已逐 Task 核过（Task 1 定义的键名在 Task 4 与技能摘要中同名使用） |
