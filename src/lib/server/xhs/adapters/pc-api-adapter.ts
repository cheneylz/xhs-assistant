/**
 * PC API 适配器（对应原版 backend/app/adapters/xhs/pc_api_adapter.py）
 */
import { withDirectXhsRequestEnv } from "../request-env";
import { XHSPcAuth } from "../pc/auth";
import { XhsPcApis } from "../pc/api";

export class XhsPcApiAdapter {
  cookies: string;

  constructor(cookies: string) {
    this.cookies = cookies;
  }

  private api(): { auth: XHSPcAuth; client: XhsPcApis } {
    const auth = XHSPcAuth.fromCookie(this.cookies);
    return { auth, client: new XhsPcApis(auth) };
  }

  /** 搜索笔记（对应 search_note，参数按 SDK 位置参数传递） */
  async searchNote(
    keyword: string,
    page = 1,
    sortTypeChoice = 0,
    noteType = 0,
    noteTime = 0,
    noteRange = 0,
    posDistance = 0,
    geo = "",
  ): Promise<[boolean, string, unknown]> {
    return withDirectXhsRequestEnv(async () => {
      return this.api().client.searchNote(keyword, page, sortTypeChoice, noteType, noteTime, noteRange, posDistance, geo);
    });
  }

  /** 笔记详情（对应 get_note_info） */
  async getNoteInfo(url: string): Promise<[boolean, string, unknown]> {
    return withDirectXhsRequestEnv(async () => {
      return this.api().client.getNoteInfo(url);
    });
  }

  /** 全部评论（对应 get_note_all_comment） */
  async getNoteComments(noteUrl: string): Promise<[boolean, string, unknown]> {
    return withDirectXhsRequestEnv(async () => {
      return this.api().client.getNoteAllComment(noteUrl);
    });
  }

  /** 发布评论（对应 post_comment） */
  async postComment(noteId: string, content: string, xsecToken: string, parentCommentId: string | null = null): Promise<[boolean, string, unknown]> {
    return withDirectXhsRequestEnv(async () => {
      return this.api().client.postComment(noteId, content, xsecToken, parentCommentId);
    });
  }

  /** 用户全部笔记（对应 get_user_all_notes） */
  async getUserNotes(userUrl: string): Promise<[boolean, string, unknown]> {
    return withDirectXhsRequestEnv(async () => {
      return this.api().client.getUserAllNotes(userUrl);
    });
  }

  /** 自身信息（对应 get_self_info，失败抛错） */
  async getSelfInfo(): Promise<Record<string, unknown>> {
    return withDirectXhsRequestEnv(async () => {
      const [success, message, resJson] = await this.api().client.getUserMe();
      const payload = resJson && typeof resJson === "object" && !Array.isArray(resJson)
        ? ((resJson as Record<string, unknown>).data as Record<string, unknown> | undefined)
        : undefined;
      if (!success || !payload) {
        throw new Error(message || "XHS self profile refresh failed");
      }
      return payload;
    });
  }
}
