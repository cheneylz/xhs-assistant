/**
 * 千帆（pgy.xiaohongshu.com 直播分发）请求工具（对应原版 xhs_qianfan_util.py）
 * 说明：DistributionCategory 类型导出供 API 层（qianfan-api.ts）复用。
 */
import { generateXB3Traceid } from "./core/params";

/** 千帆请求头模板（对应 get_qianfan_headers_template） */
export function getQianfanHeadersTemplate(): Record<string, string> {
  return {
    authority: "pgy.xiaohongshu.com",
    accept: "application/json, text/plain, */*",
    "accept-language": "zh-CN,zh;q=0.9",
    "cache-control": "no-cache",
    pragma: "no-cache",
    referer: "https://pgy.xiaohongshu.com/microapp/distribution/live-broadcast/kol",
    "sec-ch-ua": '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "x-b3-traceid": generateXB3Traceid(),
  };
}

/** 千帆博主详情请求头（对应 get_qianfan_userDetail_headers_template） */
export function getQianfanUserDetailHeadersTemplate(userId: string): Record<string, string> {
  return {
    authority: "pgy.xiaohongshu.com",
    accept: "application/json, text/plain, */*",
    "accept-language": "zh-CN,zh;q=0.9",
    "cache-control": "no-cache",
    "content-type": "application/json;charset=UTF-8",
    origin: "https://pgy.xiaohongshu.com",
    pragma: "no-cache",
    referer: `https://pgy.xiaohongshu.com/microapp/distribution/live-blogger-info/${userId}`,
    "sec-ch-ua": '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "x-b3-traceid": generateXB3Traceid(),
  };
}

export interface DistributionCategory {
  first_category?: unknown;
  second_category?: unknown[];
}

/** 千帆直播分发查询数据（对应 generate_qianfan_data） */
export function generateQianfanData(choice: string, distributionCategory: DistributionCategory[], page: number): Record<string, unknown> {
  if (choice === "-1") {
    return {
      buyer_activity: [],
      live_plan_range: [],
      seed: 1000 + Math.floor(Math.random() * 9000),
      page,
      limit: 20,
    };
  }
  const liveFirstCategory: unknown[] = [];
  const liveSecondCategory: unknown[] = [];
  for (const cateCategory of choice.split("-")) {
    const parts = cateCategory.split("(");
    const categoryIndex = Number.parseInt(parts[0], 10);
    const category = distributionCategory[categoryIndex];
    liveFirstCategory.push(category?.first_category);
    if (parts.length > 1) {
      const secondIndexes = parts[1].slice(0, -1).split(",");
      for (const secondIndex of secondIndexes) {
        const seconds = category?.second_category ?? [];
        liveSecondCategory.push(seconds[Number.parseInt(secondIndex, 10)]);
      }
    } else {
      liveSecondCategory.push(...((category?.second_category as unknown[]) ?? []));
    }
  }
  return {
    buyer_activity: [],
    live_plan_range: [],
    live_first_category: liveFirstCategory,
    live_second_category: liveSecondCategory,
    seed: 1000 + Math.floor(Math.random() * 9000),
    page,
    limit: 20,
  };
}
