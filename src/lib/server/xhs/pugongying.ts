/**
 * 蒲公英（pgy.xiaohongshu.com）请求工具（对应原版 xhs_pugongying_util.py）
 * 注意：原版 generate_pugongying_headers 调用 generate_xs_xs_common，但为重构中间态——
 * 未传 cookie/b1/dsl_pair/sign_context 必然抛错。蒲公英接口只携带 X-s/X-t（不发送 X-S-Common），
 * 按 Python generate_xs 的 docstring 设计意图（蒲公英等接口不应伪造 b1/dsl_pair）平移为 generateXs。
 */
import { generateXB3Traceid } from "./core/params";
import { generateXs, getRequestHeadersTemplate } from "./pc/params";

/** 蒲公英请求头模板 */
export function getPugongyingHeadersTemplate(): Record<string, string> {
  return {
    authority: "pgy.xiaohongshu.com",
    accept: "application/json, text/plain, */*",
    "accept-language": "zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6",
    authorization: "",
    "cache-control": "no-cache",
    "content-type": "application/json;charset=UTF-8",
    origin: "https://pgy.xiaohongshu.com",
    pragma: "no-cache",
    referer: "https://pgy.xiaohongshu.com/solar/pre-trade/kol",
    "sec-ch-ua": '"Chromium";v="122", "Not(A:Brand";v="24", "Microsoft Edge";v="122"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0",
    "x-b3-traceid": "",
    "x-s": "",
    "x-t": "",
  };
}

/** 蒲公英分类项（对应 distribution_category 的元素，供 API 层复用） */
export interface PugongyingCategory {
  taxonomy1Tag?: unknown;
  taxonomy2Tags?: unknown[];
}

/** 生成蒲公英签名请求头（对应 generate_pugongying_headers） */
export function generatePugongyingHeaders(
  a1: string,
  api: string,
  data = "",
  options: { cookie?: string; tier?: string | null; signContext?: Record<string, unknown> } = {},
): Record<string, string> {
  const [xs, xt] = generateXs(a1, api, data, "POST", { cookie: options.cookie, tier: options.tier, signContext: options.signContext });
  const headers = getRequestHeadersTemplate();
  headers["x-s"] = xs;
  headers["x-t"] = String(xt);
  headers["x-b3-traceid"] = generateXB3Traceid();
  return headers;
}

/** 蒲公英博主列表查询数据（对应 get_pugongying_bozhu_data） */
export function getPugongyingBozhuData(page: number, brandUserId: string, contentTag?: unknown): Record<string, unknown> {
  const data: Record<string, unknown> = {
    searchType: 1,
    column: "comprehensiverank",
    sort: "desc",
    pageNum: page,
    pageSize: 20,
    brandUserId,
    personalTags: [],
    featureTags: [],
    estimatePicReadPrice: [],
    estimateVideoReadPrice: [],
    fansNumberLower: null,
    fansNumberUpper: null,
    noteType: 0,
    gender: null,
    location: null,
    tradeType: "不限",
    fansAge: 0,
    fansGender: 0,
    fansNumUp: 0,
    cpc: false,
    excludeLowActive: false,
    newHighQuality: 0,
    efficiencyValid: 0,
    clothingIndustry: 0,
    firstIndustry: "",
    secondIndustry: "",
    activityCodes: [],
  };
  if (contentTag !== undefined && contentTag !== null) {
    data.contentTag = contentTag;
  }
  return data;
}

/** 解析分类选择生成 contentTag（对应 generate_pugongying_data） */
export function generatePugongyingData(choice: string, distributionCategory: PugongyingCategory[]): unknown[] | null {
  if (choice === "-1") return null;
  const contentTag: unknown[] = [];
  for (const cateCategory of choice.split("-")) {
    const parts = cateCategory.split("(");
    const categoryIndex = Number.parseInt(parts[0], 10);
    if (parts.length > 1) {
      const secondIndexes = parts[1].slice(0, -1).split(",");
      for (const secondIndex of secondIndexes) {
        const tags = distributionCategory[categoryIndex]?.taxonomy2Tags ?? [];
        contentTag.push(tags[Number.parseInt(secondIndex, 10)]);
      }
    } else {
      contentTag.push(distributionCategory[categoryIndex]?.taxonomy1Tag);
    }
  }
  return contentTag;
}
