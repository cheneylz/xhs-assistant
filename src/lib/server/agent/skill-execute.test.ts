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
    // case 的核心职责就是 params → textClient 的参数映射：光断返回值抓不到映射写错
    expect(generateTitles).toHaveBeenCalledWith(
      expect.objectContaining({ title: "露营装备清单", body: "正文", count: 3 }),
    );
  });

  it("未配置模型 / 缺 title（含纯空白）都抛可读错误（不触达 textClient）", async () => {
    await expect(executeSkill("content_titles", { title: "T" }, makeContext())).rejects.toThrow(
      "未配置文本模型，无法生成标题",
    );
    await expect(executeSkill("content_titles", {}, makeModelContext({}))).rejects.toThrow("缺少标题（title）参数");
    // trim 是 title 校验里唯一有真实分支价值的一行，单独钉住
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

  it("intensity 非法或缺省时回退 medium（Pi 边界已做枚举校验，回退防的是工作流等非 Pi 调用方）", async () => {
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

  it("intensity 的 light 档原样透传，draft_id 的典型幻觉值落到可读错误", async () => {
    mocks.draftFindFirst.mockResolvedValue({ id: 12, title: "T", body: "B" });
    mocks.draftUpdate.mockResolvedValue({ id: 12, title: "T", body: "N" });
    const rewriteNote = vi.fn(async () => "N");
    await executeSkill("content_rewrite", { draft_id: 12, intensity: "light" }, makeModelContext({ rewriteNote }));
    expect(rewriteNote).toHaveBeenLastCalledWith(expect.objectContaining({ intensity: "light" }));
    // 0 是模型最典型的幻觉值：falsy → 「缺少草稿」而不是去查 id=0
    await expect(executeSkill("content_rewrite", { draft_id: 0 }, makeModelContext({}))).rejects.toThrow(
      "缺少草稿（draft_id）参数",
    );
    // 12.7：Prisma 对非整数 id 返回 null（不抛校验错）→ 「草稿 12.7 不存在」
    mocks.draftFindFirst.mockResolvedValue(null);
    await expect(executeSkill("content_rewrite", { draft_id: 12.7 }, makeModelContext({}))).rejects.toThrow(
      "草稿 12.7 不存在",
    );
  });

  it("instruction 非字符串时透传空串（不污染提示词）", async () => {
    mocks.draftFindFirst.mockResolvedValue({ id: 12, title: "T", body: "B" });
    mocks.draftUpdate.mockResolvedValue({ id: 12, title: "T", body: "N" });
    const rewriteNote = vi.fn(async () => "N");
    await executeSkill("content_rewrite", { draft_id: 12, instruction: 123 }, makeModelContext({ rewriteNote }));
    expect(rewriteNote).toHaveBeenLastCalledWith(expect.objectContaining({ instruction: "" }));
  });
});

describe("analytics_reports", () => {
  it("正常读取：返回 reports 与 count，limit 钳制在 1..20", async () => {
    const reports = [{ id: 1, keyword: "露营" }, { id: 2, keyword: "收纳" }];
    mocks.listExplosionReports.mockResolvedValue(reports);
    const result = await executeSkill("analytics_reports", { limit: 999 }, makeContext());
    expect(mocks.listExplosionReports).toHaveBeenCalledWith(7, 20);
    expect(result.count).toBe(2);
    expect(result.reports).toEqual(reports);
  });

  it("空结果表明原因（用户知道去哪里产出报告）", async () => {
    mocks.listExplosionReports.mockResolvedValue([]);
    const result = await executeSkill("analytics_reports", {}, makeContext());
    expect(mocks.listExplosionReports).toHaveBeenCalledWith(7, 5);
    expect(result.count).toBe(0);
    expect(result.reason).toBe("还没有爆款拆解报告，可先在「爆款拆解」页生成");
  });
});

describe("kb_get", () => {
  it("正常读取：返回 context 与 length", async () => {
    mocks.buildKbContext.mockResolvedValue("【账号定位】露营装备测评");
    const result = await executeSkill("kb_get", {}, makeContext());
    expect(mocks.buildKbContext).toHaveBeenCalledWith(7);
    expect(result.length).toBe("【账号定位】露营装备测评".length);
    expect(result.context).toBe("【账号定位】露营装备测评");
  });

  it("知识库为空时 length=0 并带出 reason", async () => {
    mocks.buildKbContext.mockResolvedValue("");
    const result = await executeSkill("kb_get", {}, makeContext());
    expect(result.length).toBe(0);
    expect(result.reason).toBe("知识库尚未配置，可先在「知识库」页填写账号定位与口吻");
  });
});
