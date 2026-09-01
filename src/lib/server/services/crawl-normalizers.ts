/**
 * 爬取数据规范化（对应原版 api/platforms/xhs/crawl.py 与 pc.py 的纯函数，供路由与调度共用）
 */

/** 指标字符串 → 数字（支持 万/w 后缀，对应 _metric） */
export function metric(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") return Math.floor(value);
  if (typeof value === "boolean") return 0;
  let text = String(value).trim().replace(/,/g, "");
  if (!text) return 0;
  let multiplier = 1;
  if (text.endsWith("万")) {
    multiplier = 10000;
    text = text.slice(0, -1);
  } else if (text.toLowerCase().endsWith("w")) {
    multiplier = 10000;
    text = text.slice(0, -1);
  }
  const match = text.match(/\d+(?:\.\d+)?/);
  if (!match) return 0;
  return Math.floor(Number.parseFloat(match[0]) * multiplier);
}

/** 取第一个可用的图片 URL（对应 _first_url） */
export function firstUrl(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.length) return firstUrl(value[0]);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const dict = value as Record<string, unknown>;
    const infoList = dict.info_list;
    if (Array.isArray(infoList) && infoList.length > 1 && infoList[1] && typeof infoList[1] === "object") {
      const preferredUrl = (infoList[1] as Record<string, unknown>).url;
      if (preferredUrl) return String(preferredUrl);
    }
    for (const key of ["url_default", "url_pre", "url", "src"]) {
      if (dict[key]) return String(dict[key]);
    }
    for (const nested of ["info_list", "image_list", "images"]) {
      if (dict[nested]) return firstUrl(dict[nested]);
    }
  }
  return "";
}

/** 取全部图片 URL（去重，对应 _all_urls） */
export function allUrls(value: unknown): string[] {
  if (typeof value === "string") return value ? [value] : [];
  if (Array.isArray(value)) {
    const urls: string[] = [];
    for (const item of value) urls.push(...allUrls(item));
    return urls.filter((url, index) => url && !urls.slice(0, index).includes(url));
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const dict = value as Record<string, unknown>;
    const direct = firstUrl(value);
    if (direct) return [direct];
    const urls: string[] = [];
    for (const nested of ["info_list", "image_list", "images"]) {
      if (dict[nested]) urls.push(...allUrls(dict[nested]));
    }
    return urls.filter((url, index) => url && !urls.slice(0, index).includes(url));
  }
  return [];
}

/** 话题标签名（对应 _tag_names） */
export function tagNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const tags: string[] = [];
  for (const tag of value) {
    let name = "";
    if (typeof tag === "string") {
      name = tag;
    } else if (tag && typeof tag === "object" && !Array.isArray(tag)) {
      const dict = tag as Record<string, unknown>;
      name = String(dict.name ?? dict.tag_name ?? dict.title ?? "");
    }
    if (name && !tags.includes(name)) tags.push(name);
  }
  return tags;
}

/** 笔记 URL（对应 _note_url） */
export function noteUrl(noteId: string, item: Record<string, unknown>, card: Record<string, unknown>): string {
  const xsecToken = String(card.xsec_token ?? item.xsec_token ?? "");
  if (noteId && xsecToken) {
    const xsecSource = String(card.xsec_source ?? item.xsec_source ?? "pc_feed");
    return `https://www.xiaohongshu.com/explore/${noteId}?xsec_token=${xsecToken}&xsec_source=${xsecSource}`;
  }
  for (const value of [card.note_url, card.url, card.share_url, item.note_url, item.url, item.share_url]) {
    if (typeof value === "string" && value) return value;
  }
  return noteId ? `https://www.xiaohongshu.com/explore/${noteId}` : "";
}

/** 视频地址（对应 _video_url） */
export function videoUrl(card: Record<string, unknown>): string {
  for (const key of ["video_addr", "video_url"]) {
    if (card[key]) return String(card[key]);
  }
  const videoInfo = card.video && typeof card.video === "object" ? (card.video as Record<string, unknown>) : {};
  const streamInfo = videoInfo.media && typeof videoInfo.media === "object"
    ? ((videoInfo.media as Record<string, unknown>).stream as Record<string, unknown> ?? {})
    : {};
  for (const codec of ["h264", "h265", "av1"]) {
    const streams = streamInfo[codec];
    if (Array.isArray(streams) && streams.length) {
      const first = streams[0] as Record<string, unknown>;
      if (first?.master_url || first?.url) return String(first.master_url || first.url);
    }
  }
  const consumer = videoInfo.consumer && typeof videoInfo.consumer === "object" ? (videoInfo.consumer as Record<string, unknown>) : {};
  const originKey = consumer.origin_video_key;
  return originKey ? `https://sns-video-bd.xhscdn.com/${originKey}` : "";
}

/** 搜索项规范化（对应 _normalize_search_item） */
export function normalizeSearchItem(item: Record<string, unknown>): Record<string, unknown> {
  const card = (item.note_card ?? item.note ?? item) as Record<string, unknown>;
  const author = (card.user ?? card.author ?? {}) as Record<string, unknown>;
  const interact = (card.interact_info ?? card.interaction ?? {}) as Record<string, unknown>;
  const noteId = String(card.note_id ?? card.id ?? item.id ?? "");
  const timestamp = card.time ?? card.create_time ?? item.time ?? item.create_time ?? 0;
  return {
    note_id: noteId,
    note_url: noteUrl(noteId, item, card),
    title: String(card.display_title ?? card.title ?? ""),
    content: String(card.desc ?? card.content ?? ""),
    author_id: String(author.user_id ?? author.id ?? ""),
    author_name: String(author.nickname ?? author.name ?? ""),
    author_avatar: String(author.avatar ?? author.avatar_url ?? ""),
    cover_url: firstUrl(card.cover ?? card.image_list ?? card.images),
    image_urls: allUrls(card.image_list ?? card.images ?? card.cover),
    likes: metric(interact.liked_count ?? interact.likes),
    collects: metric(interact.collected_count ?? interact.collects),
    comments: metric(interact.comment_count ?? interact.comments),
    shares: metric(interact.share_count ?? interact.shares),
    type: String(card.type ?? item.model_type ?? ""),
    timestamp,
    raw: item,
  };
}

/** 提取数据条目（对应 _data_items） */
export function dataItems(rawPayload: unknown): Array<Record<string, unknown>> {
  if (!rawPayload || typeof rawPayload !== "object" || Array.isArray(rawPayload)) return [];
  const payload = rawPayload as Record<string, unknown>;
  const data = payload.data && typeof payload.data === "object" && !Array.isArray(payload.data)
    ? (payload.data as Record<string, unknown>)
    : payload;
  const items = data.items ?? data.notes ?? data.list ?? [];
  if (!Array.isArray(items)) return [];
  return items.filter(
    (item): item is Record<string, unknown> =>
      Boolean(item && typeof item === "object" && !Array.isArray(item)) &&
      !["rec_query", "hot_query"].includes(String((item as Record<string, unknown>).model_type)),
  );
}

/** 带指标的原数据（对应 _raw_with_metrics） */
export function rawWithMetrics(normalized: Record<string, unknown>): Record<string, unknown> {
  const raw = normalized.raw && typeof normalized.raw === "object" ? (normalized.raw as Record<string, unknown>) : {};
  return {
    ...raw,
    note_url: normalized.note_url ?? "",
    tags: normalized.tags ?? [],
    likes: normalized.likes ?? 0,
    collects: normalized.collects ?? 0,
    comments: normalized.comments ?? 0,
    shares: normalized.shares ?? 0,
  };
}

/** 图片 URL 列表（对应 _image_urls） */
export function imageUrls(normalized: Record<string, unknown>): string[] {
  const urls = normalized.image_urls;
  if (Array.isArray(urls) && urls.length) {
    return urls.map((url) => String(url)).filter(Boolean);
  }
  const coverUrl = normalized.cover_url;
  return coverUrl ? [String(coverUrl)] : [];
}

// ---------------- 评论规范化（对应 pc.py 评论相关纯函数） ----------------

function commentId(comment: Record<string, unknown>): string {
  return String(comment.comment_id ?? comment.id ?? comment.commentId ?? "");
}

function commentUser(comment: Record<string, unknown>): Record<string, unknown> {
  const user = comment.user_info ?? comment.user ?? comment.author;
  return user && typeof user === "object" && !Array.isArray(user) ? (user as Record<string, unknown>) : {};
}

function commentChildren(comment: Record<string, unknown>): Array<Record<string, unknown>> {
  for (const key of ["sub_comments", "sub_comment", "comments", "replies", "children"]) {
    const value = comment[key];
    if (Array.isArray(value)) return value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)));
  }
  const subPayload = comment.sub_comment_info;
  if (subPayload && typeof subPayload === "object" && !Array.isArray(subPayload)) {
    const value = (subPayload as Record<string, unknown>).comments;
    if (Array.isArray(value)) return value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)));
  }
  return [];
}

function normalizeComment(comment: Record<string, unknown>, parentCommentId: string | null = null): Record<string, unknown> {
  const user = commentUser(comment);
  return {
    comment_id: commentId(comment),
    user_name: String(user.nickname ?? user.name ?? comment.user_name ?? ""),
    user_id: String(user.user_id ?? user.id ?? comment.user_id ?? "") || null,
    content: String(comment.content ?? comment.text ?? comment.desc ?? ""),
    like_count: metric(comment.like_count ?? comment.liked_count ?? comment.likes),
    parent_comment_id: parentCommentId,
    created_at_remote: comment.create_time ?? comment.created_at ?? comment.time ?? null,
    raw_json: comment,
  };
}

function flattenComments(comments: Array<Record<string, unknown>>, parentCommentId: string | null = null): Array<Record<string, unknown>> {
  const flattened: Array<Record<string, unknown>> = [];
  for (const comment of comments) {
    const normalized = normalizeComment(comment, parentCommentId);
    let childParentId = parentCommentId;
    if (normalized.comment_id) {
      flattened.push(normalized);
      childParentId = String(normalized.comment_id);
    }
    flattened.push(...flattenComments(commentChildren(comment), childParentId));
  }
  return flattened;
}

function extractCommentList(rawPayload: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(rawPayload)) {
    return rawPayload.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)));
  }
  if (!rawPayload || typeof rawPayload !== "object") return [];
  const payload = rawPayload as Record<string, unknown>;
  const data = payload.data && typeof payload.data === "object" && !Array.isArray(payload.data)
    ? (payload.data as Record<string, unknown>)
    : payload;
  for (const key of ["comments", "items", "list"]) {
    const value = data[key];
    if (Array.isArray(value)) {
      return value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)));
    }
  }
  return [];
}

/** 扁平化评论负载（对应 normalize_comment_payload） */
export function normalizeCommentPayload(rawPayload: unknown): Array<Record<string, unknown>> {
  return flattenComments(extractCommentList(rawPayload));
}

/** 详情负载规范化（对应 _normalize_detail_payload） */
export function normalizeDetailPayload(rawPayload: Record<string, unknown>, sourceUrl = ""): Record<string, unknown> {
  const data = (rawPayload ?? {}).data && typeof (rawPayload ?? {}).data === "object"
    ? ((rawPayload ?? {}).data as Record<string, unknown>)
    : {};
  const items = Array.isArray(data.items) ? data.items : [];
  const item = items.length && items[0] && typeof items[0] === "object" && !Array.isArray(items[0])
    ? (items[0] as Record<string, unknown>)
    : data;
  const normalized = normalizeSearchItem(item);
  const card = (item.note_card ?? item.note ?? item) as Record<string, unknown>;
  const images = allUrls(card.image_list ?? card.images ?? card.cover);
  if (sourceUrl) normalized.note_url = sourceUrl;
  normalized.image_urls = images;
  const video = videoUrl(card);
  normalized.video_url = video;
  normalized.video_addr = video;
  normalized.tags = tagNames(card.tag_list ?? card.tags ?? card.topics);
  normalized.raw = rawPayload;
  return normalized;
}
