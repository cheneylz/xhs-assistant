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
  it("正常检索：total/count/items 投影，正文截断到 120 字", async () => {
    mocks.searchNotes.mockResolvedValue({
      outcome: "ok",
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
    expect(mocks.searchNotes).toHaveBeenCalledWith(7, { keyword: "露营", tagId: undefined });
    expect(result.total).toBe(1);
    expect(result.count).toBe(1);
    const items = result.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: 12, title: "露营装备清单", author_name: "小明", platform: "xhs" });
    expect(String(items[0].content_excerpt).length).toBe(120);
    // raw_json 这类重字段不进入模型可见的投影
    expect(items[0].raw_json).toBeUndefined();
  });

  it("空结果把 reason 放进 details（关键词检索 vs 内容库为空）", async () => {
    mocks.searchNotes.mockResolvedValue({ outcome: "ok", items: [] });
    const byKeyword = await executeSkill("library_search_notes", { keyword: "露营" }, makeContext());
    expect(byKeyword.total).toBe(0);
    expect(byKeyword.reason).toBe("没有匹配「露营」的笔记");
    const noKeyword = await executeSkill("library_search_notes", {}, makeContext());
    expect(noKeyword.reason).toBe("内容库还没有笔记");
  });

  it("limit 被钳制在 1..20（模型可能给离谱值）", async () => {
    mocks.searchNotes.mockResolvedValue({ outcome: "ok", items: [] });
    await executeSkill("library_search_notes", { limit: 999 }, makeContext());
    // items 为空时不影响；用带数据的场景断言 slice 行为
    mocks.searchNotes.mockResolvedValue({
      outcome: "ok",
      items: Array.from({ length: 30 }, (_, index) => ({ id: index + 1, title: `T${index}` })),
    });
    const result = await executeSkill("library_search_notes", { limit: 999 }, makeContext());
    expect(result.total).toBe(30);
    expect((result.items as unknown[]).length).toBe(20);
  });

  it("tag_id 指向不存在的标签时抛可读错误", async () => {
    mocks.searchNotes.mockResolvedValue({ outcome: "tag_not_found" });
    await expect(executeSkill("library_search_notes", { tag_id: 99 }, makeContext())).rejects.toThrow(
      "标签 99 不存在或不属于当前用户",
    );
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
