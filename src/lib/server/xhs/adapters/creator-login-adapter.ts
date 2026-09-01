/**
 * Creator 登录适配器（对应原版 backend/app/adapters/xhs/creator_login_adapter.py）
 */
import { withDirectXhsRequestEnv } from "../request-env";
import { XHSCreatorLoginApi } from "../creator/login-api";

export class XhsCreatorLoginAdapter {
  /** 用户 Cookie 交换 Creator 会话（对应 exchange_from_user_cookies） */
  async exchangeFromUserCookies(userCookies: Record<string, unknown>): Promise<Record<string, unknown>> {
    return withDirectXhsRequestEnv(async () => {
      const api = new XHSCreatorLoginApi();
      const [success, message, payload] = await api.exchangeCreatorSessionFromUserCookies(userCookies);
      if (!success || !payload) throw new Error(message);
      return { status: "confirmed", cookies: payload.cookies };
    });
  }

  /** 创建 QR 登录（对应 create_qrcode） */
  async createQrcode(): Promise<Record<string, unknown>> {
    return withDirectXhsRequestEnv(async () => {
      const api = new XHSCreatorLoginApi();
      const cookies = await api.generateInitCookies();
      const [success, message, payload] = await api.generateQrcode(cookies);
      if (!success || !payload || !("qr_id" in payload)) throw new Error(message);
      return {
        cookies: payload.cookies,
        qr_id: payload.qr_id,
        qr_url: payload.qr_url,
      };
    });
  }

  /** 轮询 QR 状态（对应 check_qrcode_status） */
  async checkQrcodeStatus(qrId: string, cookies: Record<string, unknown>): Promise<{ status: string; cookies: Record<string, unknown> }> {
    return withDirectXhsRequestEnv(async () => {
      const api = new XHSCreatorLoginApi();
      const [success, message, updatedCookies] = await api.checkQrcodeStatus(qrId, cookies);
      let status = success ? "confirmed" : "pending";
      if (message.includes("过期") || message.toLowerCase().includes("expired")) status = "expired";
      if (message.includes("确认") || message.toLowerCase().includes("confirm")) status = "scanned";
      return { status, cookies: updatedCookies ?? {} };
    });
  }

  /** 用户信息（对应 get_user_info） */
  async getUserInfo(cookies: Record<string, unknown>): Promise<Record<string, unknown>> {
    return withDirectXhsRequestEnv(async () => {
      const api = new XHSCreatorLoginApi();
      const [success, data] = await api.getUserInfo(cookies);
      if (!success) throw new Error("Failed to fetch XHS Creator user info");
      const info = data ?? {};
      return {
        external_user_id: String(info.userId ?? ""),
        nickname: String(info.userName ?? ""),
        avatar_url: String(info.userAvatar ?? ""),
        profile: {
          red_id: String(info.redId ?? info.red_id ?? ""),
          role: String(info.role ?? ""),
          real_name_verified: info.realNameVerified,
          followers: info.fans ?? info.followers ?? info.followerCount,
          following: info.follows ?? info.following ?? info.followingCount,
          likes: info.likedCount ?? info.likes ?? info.likeCount,
          raw: data,
        },
      };
    });
  }

  /** 短信验证码（对应 create_phone_session） */
  async createPhoneSession(phone: string): Promise<Record<string, unknown>> {
    return withDirectXhsRequestEnv(async () => {
      const api = new XHSCreatorLoginApi();
      const cookies = await api.generateInitCookies();
      const [success, message] = await api.sendPhoneCode(phone, cookies);
      if (!success) throw new Error(message);
      return { cookies, message: message || "sent" };
    });
  }

  /** 短信登录确认（对应 confirm_phone_login） */
  async confirmPhoneLogin(phone: string, code: string, cookies: Record<string, unknown>): Promise<Record<string, unknown>> {
    return withDirectXhsRequestEnv(async () => {
      const api = new XHSCreatorLoginApi();
      const [success, message, payload] = await api.loginByPhone(phone, code, cookies);
      if (!success || !payload) throw new Error(message);
      return { status: "confirmed", cookies: payload.cookies };
    });
  }
}
