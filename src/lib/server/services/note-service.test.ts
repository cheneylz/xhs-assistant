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
    // 字符串按非对象处理；cover_url 不是字符串也不当封面
    expect(projectNote(makeNote({ rawJson: "不是对象" }), []).cover_url).toBe("");
    expect(projectNote(makeNote({ rawJson: { cover_url: 123 } }), []).cover_url).toBe("");
  });

  it("空白 image 素材（url 与 localPath 皆空）时封面为空串且不回退 raw_json（与现状等价，勿改）", () => {
    const result = projectNote(
      makeNote({ rawJson: { cover_url: "https://example.com/raw.jpg" } }),
      [makeAsset({ url: "", localPath: "" })],
    );
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
