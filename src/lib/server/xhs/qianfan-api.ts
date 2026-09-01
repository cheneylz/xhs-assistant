/**
 * 千帆（pgy.xiaohongshu.com 直播分发）API 客户端
 * 对应原版 Python 文件：XHS_ALL_IN_ONE/apis/xhs_qianfan_apis.py（逐逻辑翻译）
 *
 * 翻译说明：
 * 1. 千帆接口不使用 PC 签名（原版仅 requests + 固定请求头模板，x-b3-traceid 每次请求新生成）。
 * 2. chooseCategories 原版使用 input() 交互读取选择，服务端环境改为由调用方传入 choice 参数。
 * 3. 请求超时沿用 Python 版 REQUEST_TIMEOUT = 15 秒。
 */
import { BrowserHttpClient } from "./core/http";
import { spliceStr } from "./core/params";
import {
  generateQianfanData,
  getQianfanHeadersTemplate,
  getQianfanUserDetailHeadersTemplate,
  type DistributionCategory,
} from "./qianfan";

/** 请求超时（毫秒，对应 Python 版 REQUEST_TIMEOUT = 15 秒） */
const REQUEST_TIMEOUT_MS = 15 * 1000;

/** 千帆直播分发 API（类名与语义对应 Python 版 QianFanAPI） */
export class QianFanAPI {
  /** 共享 HTTP 传输客户端 */
  private readonly httpClient = new BrowserHttpClient();

  /** 获取全部类目（对应 get_all_categories） */
  async getAllCategories(cookies: unknown): Promise<DistributionCategory[]> {
    const headers = getQianfanHeadersTemplate();
    const url = "https://pgy.xiaohongshu.com/api/draco/distributor-square/distributors-tags";
    const params = { types: "content_category,distribution_category,user_design_tag,content_tag" };
    const response = await this.httpClient.get(spliceStr(url, params), { headers, cookies, timeout: REQUEST_TIMEOUT_MS });
    const resJson = response.json() as Record<string, unknown>;
    const data = resJson["data"] as Record<string, unknown>;
    const distributorTagMap = data["distributor_tag_map"] as Record<string, unknown>;
    return distributorTagMap["distribution_category"] as DistributionCategory[];
  }

  /** 选择类目（对应 choose_categories，choice 由调用方传入） */
  async chooseCategories(cookies: unknown, choice: string): Promise<[string, DistributionCategory[]]> {
    const distributionCategory = await this.getAllCategories(cookies);
    for (const [firstIndex, firstCategory] of distributionCategory.entries()) {
      console.info(`${firstIndex}: ${String(firstCategory.first_category)}`);
      for (const [secondIndex, secondCategory] of (firstCategory.second_category ?? []).entries()) {
        console.info(`---- ${secondIndex}: ${String(secondCategory)}`);
      }
    }
    return [choice, distributionCategory];
  }

  /** 分页获取达人列表（对应 get_user_by_page） */
  async getUserByPage(
    choice: string,
    distributionCategory: DistributionCategory[],
    page: number,
    cookies: unknown,
  ): Promise<[unknown[], number]> {
    const headers = getQianfanHeadersTemplate();
    const url = "https://pgy.xiaohongshu.com/api/draco/distributor-square/distributors";
    const data = generateQianfanData(choice, distributionCategory, page);
    const dataStr = JSON.stringify(data);
    const response = await this.httpClient.post(url, { headers, cookies, data: dataStr, timeout: REQUEST_TIMEOUT_MS });
    const resJson = response.json() as Record<string, unknown>;
    const dataObj = resJson["data"] as Record<string, unknown>;
    const total = dataObj["total"] as number;
    const userList = dataObj["list"] as unknown[];
    return [userList, total];
  }

  /** 获取指定数量的达人（对应 get_some_user） */
  async getSomeUser(
    choice: string,
    distributionCategory: DistributionCategory[],
    num: number,
    cookies: unknown,
  ): Promise<unknown[]> {
    const userList: unknown[] = [];
    let page = 1;
    while (userList.length < num) {
      const [userListTemp, total] = await this.getUserByPage(choice, distributionCategory, page, cookies);
      userList.push(...userListTemp);
      page += 1;
      if (page > total / 20 + 1) {
        break;
      }
    }
    return userList.length > num ? userList.slice(0, num) : userList;
  }

  /** 获取达人数据概览（对应 get_user_detail） */
  async getUserDetail(userId: string, cookies: unknown): Promise<Record<string, unknown>> {
    const headers = getQianfanUserDetailHeadersTemplate(userId);
    const url = "https://pgy.xiaohongshu.com/api/draco/distributor-square/distributor/detail/overview/v2";
    const data = { buyer_id: userId, date_type: 2 };
    const dataStr = JSON.stringify(data);
    const response = await this.httpClient.post(url, { headers, cookies, data: dataStr, timeout: REQUEST_TIMEOUT_MS });
    return response.json() as Record<string, unknown>;
  }

  /** 获取达人合作类目（对应 get_user_cooperation） */
  async getUserCooperation(userId: string, cookies: unknown): Promise<Record<string, unknown>> {
    const headers = getQianfanUserDetailHeadersTemplate(userId);
    const url = "https://pgy.xiaohongshu.com/api/draco/distributor-square/distributor/cooperative/category/v2";
    const data = { buyer_id: userId, first_live_category: "", second_live_category: "", date_type: 2, page: 1, size: 10 };
    const dataStr = JSON.stringify(data);
    const response = await this.httpClient.post(url, { headers, cookies, data: dataStr, timeout: REQUEST_TIMEOUT_MS });
    return response.json() as Record<string, unknown>;
  }

  /** 获取达人合作店铺（对应 get_user_shop） */
  async getUserShop(userId: string, cookies: unknown): Promise<Record<string, unknown>> {
    const headers = getQianfanUserDetailHeadersTemplate(userId);
    const url = "https://pgy.xiaohongshu.com/api/draco/distributor-square/distributor/cooperative/shop/v2";
    const data = { buyer_id: userId, first_live_category: "", second_live_category: "", date_type: 2, page: 1, size: 10 };
    const dataStr = JSON.stringify(data);
    const response = await this.httpClient.post(url, { headers, cookies, data: dataStr, timeout: REQUEST_TIMEOUT_MS });
    return response.json() as Record<string, unknown>;
  }

  /** 获取达人带货商品（对应 get_user_item） */
  async getUserItem(userId: string, cookies: unknown): Promise<Record<string, unknown>> {
    const headers = getQianfanUserDetailHeadersTemplate(userId);
    const url = "https://pgy.xiaohongshu.com/api/draco/distributor-square/distributor/cooperative/item/v2";
    const data = { buyer_id: userId, first_live_category: "", second_live_category: "", date_type: 2, page: 1, size: 10 };
    const dataStr = JSON.stringify(data);
    const response = await this.httpClient.post(url, { headers, cookies, data: dataStr, timeout: REQUEST_TIMEOUT_MS });
    return response.json() as Record<string, unknown>;
  }

  /** 获取达人粉丝数据（对应 get_user_fans；注意原版 URL 即 distribuitor 拼写，保留） */
  async getUserFans(userId: string, cookies: unknown): Promise<Record<string, unknown>> {
    const headers = getQianfanUserDetailHeadersTemplate(userId);
    const url = "https://pgy.xiaohongshu.com/api/draco/distributor-square/distribuitor/detail/fans";
    const params = { distributor_id: userId, date_type: "2" };
    const response = await this.httpClient.get(spliceStr(url, params), { headers, cookies, timeout: REQUEST_TIMEOUT_MS });
    return response.json() as Record<string, unknown>;
  }
}
