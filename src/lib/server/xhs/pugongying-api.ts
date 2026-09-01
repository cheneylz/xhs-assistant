/**
 * 蒲公英（pgy.xiaohongshu.com）商业平台 API 客户端
 * 对应原版 Python 文件：XHS_ALL_IN_ONE/apis/xhs_pugongying_apis.py（逐逻辑翻译）
 *
 * 翻译说明：
 * 1. 签名走 PC 端 X-s/X-t（generateXs 语义，蒲公英接口只携带 X-s/X-t），
 *    由 PcDeviceProfile 提供签名会话上下文（nextSignContext）。
 *    原版 _signed_headers 向 generate_pugongying_headers 传 profile 属重构中间态
 *    （当前 util 签名不接收 profile，且其内部 generate_xs_xs_common 缺少必传参数必然抛错），
 *    本翻译按其设计意图实现，详见 pugongying.ts 文件头注释。
 * 2. chooseCategories 原版使用 input() 交互读取选择，服务端环境改为由调用方传入 choice 参数。
 * 3. 请求超时沿用 Python 版 REQUEST_TIMEOUT = 15 秒。
 */
import { BrowserHttpClient } from "./core/http";
import { spliceStr } from "./core/params";
import { PcDeviceProfile } from "./pc/state";
import {
  generatePugongyingData,
  generatePugongyingHeaders,
  getPugongyingBozhuData,
  getPugongyingHeadersTemplate,
  type PugongyingCategory,
} from "./pugongying";

/** 请求超时（毫秒，对应 Python 版 REQUEST_TIMEOUT = 15 秒） */
const REQUEST_TIMEOUT_MS = 15 * 1000;

/** 蒲公英平台 API（类名与语义对应 Python 版 PuGongYingAPI） */
export class PuGongYingAPI {
  /** 蒲公英平台基础地址 */
  readonly baseUrl = "https://pgy.xiaohongshu.com";
  /** PC 签名设备资料（懒加载，对应 self.profile） */
  private profile: PcDeviceProfile | null = null;
  /** 共享 HTTP 传输客户端 */
  private readonly httpClient = new BrowserHttpClient();

  /** 生成带签名的请求头（对应 _signed_headers） */
  private signedHeaders(cookies: unknown, api: string, data = ""): Record<string, string> {
    if (this.profile === null) {
      this.profile = new PcDeviceProfile({ cookies });
    } else {
      this.profile.updateCookies(cookies);
    }
    return generatePugongyingHeaders(this.profile.cookieMap.a1, api, data, {
      cookie: this.profile.documentCookie,
      signContext: this.profile.nextSignContext(api),
    });
  }

  /** 获取全部类目（对应 get_all_categories） */
  async getAllCategories(cookies: unknown): Promise<PugongyingCategory[]> {
    const api = "/api/solar/cooperator/content/tag_tree";
    const headers = this.signedHeaders(cookies, api);
    const response = await this.httpClient.get(this.baseUrl + api, { headers, cookies, timeout: REQUEST_TIMEOUT_MS });
    const resJson = response.json() as Record<string, unknown>;
    return resJson["data"] as PugongyingCategory[];
  }

  /** 选择类目并生成 contentTag（对应 choose_categories，choice 由调用方传入） */
  async chooseCategories(cookies: unknown, choice: string): Promise<[unknown[] | null, PugongyingCategory[]]> {
    const distributionCategory = await this.getAllCategories(cookies);
    for (const [firstIndex, firstCategory] of distributionCategory.entries()) {
      console.info(`${firstIndex}: ${String(firstCategory.taxonomy1Tag)}`);
      for (const [secondIndex, secondCategory] of (firstCategory.taxonomy2Tags ?? []).entries()) {
        console.info(`---- ${secondIndex}: ${String(secondCategory)}`);
      }
    }
    const contentTag = generatePugongyingData(choice, distributionCategory);
    return [contentTag, distributionCategory];
  }

  /** 获取跟踪标识（对应 get_track） */
  async getTrack(data: Record<string, unknown>, cookies: unknown): Promise<Record<string, unknown>> {
    const api = "/api/solar/cooperator/blogger/track";
    const dataStr = JSON.stringify(data);
    const headers = this.signedHeaders(cookies, api, dataStr);
    const response = await this.httpClient.post(this.baseUrl + api, { headers, cookies, data: dataStr, timeout: REQUEST_TIMEOUT_MS });
    return response.json() as Record<string, unknown>;
  }

  /** 分页获取博主列表（对应 get_user_by_page） */
  async getUserByPage(page: number, cookies: unknown, contentTag?: unknown): Promise<[unknown[], number]> {
    const api = "/api/solar/cooperator/blogger/v2";
    const selfInfo = await this.getSelfInfo(cookies);
    const brandUserId = (selfInfo["data"] as Record<string, unknown>)["userId"] as string;
    // brandUserId = cookies['x-user-id-ark.xiaohongshu.com']（保留原注释）
    const data = getPugongyingBozhuData(page, brandUserId, contentTag);
    const trackId = ((await this.getTrack(data, cookies))["data"] as Record<string, unknown>)["trackId"] as string;
    data.trackId = trackId;
    const dataStr = JSON.stringify(data);
    const headers = this.signedHeaders(cookies, api, dataStr);
    const response = await this.httpClient.post(this.baseUrl + api, { headers, cookies, data: dataStr, timeout: REQUEST_TIMEOUT_MS });
    const resJson = response.json() as Record<string, unknown>;
    const total = (resJson["data"] as Record<string, unknown>)["total"] as number;
    const userList = (resJson["data"] as Record<string, unknown>)["kols"] as unknown[];
    return [userList, total];
  }

  /** 获取指定数量的博主（对应 get_some_user） */
  async getSomeUser(num: number, cookies: unknown, contentTag?: unknown): Promise<unknown[]> {
    const userList: unknown[] = [];
    let page = 1;
    while (userList.length < num) {
      const [userListTemp, total] = await this.getUserByPage(page, cookies, contentTag);
      userList.push(...userListTemp);
      page += 1;
      if (page > total / 20 + 1) {
        break;
      }
    }
    return userList.length > num ? userList.slice(0, num) : userList;
  }

  /** 获取博主数据摘要（对应 get_user_detail） */
  async getUserDetail(userId: string, cookies: unknown): Promise<Record<string, unknown>> {
    const api = "/api/solar/kol/dataV3/dataSummary";
    const params = { userId, business: "0" };
    const headers = this.signedHeaders(cookies, api);
    const response = await this.httpClient.get(spliceStr(this.baseUrl + api, params), { headers, cookies, timeout: REQUEST_TIMEOUT_MS });
    return response.json() as Record<string, unknown>;
  }

  /** 获取博主粉丝摘要（对应 get_user_fans_detail） */
  async getUserFansDetail(userId: string, cookies: unknown): Promise<Record<string, unknown>> {
    const api = "/api/solar/kol/dataV3/fansSummary";
    const params = { userId };
    const headers = this.signedHeaders(cookies, api);
    const response = await this.httpClient.get(spliceStr(this.baseUrl + api, params), { headers, cookies, timeout: REQUEST_TIMEOUT_MS });
    return response.json() as Record<string, unknown>;
  }

  /** 获取博主粉丝历史（对应 get_user_fans_history） */
  async getUserFansHistory(userId: string, cookies: unknown): Promise<Record<string, unknown>> {
    const api = `/api/solar/kol/data/${userId}/fans_overall_new_history`;
    const params = { dateType: "1", increaseType: "1" };
    const headers = this.signedHeaders(cookies, api);
    const response = await this.httpClient.get(spliceStr(this.baseUrl + api, params), { headers, cookies, timeout: REQUEST_TIMEOUT_MS });
    return response.json() as Record<string, unknown>;
  }

  /** 获取博主笔记数据（对应 get_user_notes_detail） */
  async getUserNotesDetail(userId: string, cookies: unknown): Promise<Record<string, unknown>> {
    const api = "/api/solar/kol/dataV3/notesRate";
    const params = { userId, business: "0", noteType: "3", dateType: "1", advertiseSwitch: "1" };
    const headers = this.signedHeaders(cookies, api);
    const response = await this.httpClient.get(spliceStr(this.baseUrl + api, params), { headers, cookies, timeout: REQUEST_TIMEOUT_MS });
    return response.json() as Record<string, unknown>;
  }

  /** 获取当前账号信息（对应 get_self_info，仅用模板头不签名） */
  async getSelfInfo(cookies: unknown): Promise<Record<string, unknown>> {
    const url = "https://pgy.xiaohongshu.com/api/solar/user/info";
    const headers = getPugongyingHeadersTemplate();
    const response = await this.httpClient.get(url, { headers, cookies, timeout: REQUEST_TIMEOUT_MS });
    return response.json() as Record<string, unknown>;
  }

  /** 发起邀约（对应 send_invite） */
  async sendInvite(
    userId: string,
    cookies: unknown,
    productName: string,
    time: [number, number],
    inviteContent: string,
    contactInfo: string,
  ): Promise<Record<string, unknown>> {
    const api = "/api/solar/invite/initiate_invite";
    const selfInfo = await this.getSelfInfo(cookies);
    const dataObj = selfInfo["data"] as Record<string, unknown>;
    const cooperateBrandId = dataObj["userId"] as string;
    const cooperateBrandName = dataObj["nickName"] as string;
    const data = {
      kolId: userId,
      cooperateBrandId,
      cooperateBrandName,
      inviteType: 1,
      productName,
      expectedPublishTimeStart: time[0],
      expectedPublishTimeEnd: time[1],
      inviteContent,
      contactInfo,
      contactType: 1,
      brandUserId: cooperateBrandId,
    };
    const dataStr = JSON.stringify(data);
    // 注意：与 Python 版一致，签名使用空 data（signedHeaders 默认值），请求体单独携带 JSON 字符串
    const headers = this.signedHeaders(cookies, api);
    const response = await this.httpClient.post(this.baseUrl + api, { headers, cookies, data: dataStr, timeout: REQUEST_TIMEOUT_MS });
    return response.json() as Record<string, unknown>;
  }
}
