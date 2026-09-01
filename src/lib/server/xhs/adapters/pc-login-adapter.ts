/**
 * PC 登录适配器（对应原版 backend/app/adapters/xhs/pc_login_adapter.py）
 */
import { withDirectXhsRequestEnv } from "../request-env";
import { XHSLoginApi } from "../pc/login-api";

export class XhsPcLoginAdapter {
  /** 创建 QR 登录（对应 create_qrcode） */
  async createQrcode(): Promise<Record<string, unknown>> {
    return withDirectXhsRequestEnv(async () => {
      const api = new XHSLoginApi();
      const cookies = await api.generateInitCookies();
      const [success, message, payload] = await api.generateQrcode(cookies);
      if (!success || !payload || !("qr_id" in payload)) throw new Error(message);
      return {
        cookies: payload.cookies,
        qr_id: payload.qr_id,
        code: payload.code,
        qr_url: payload.qr_url,
      };
    });
  }

  /** 轮询 QR 状态（对应 check_qrcode_status） */
  async checkQrcodeStatus(qrId: string, code: string, cookies: Record<string, string>): Promise<{ status: string; cookies: Record<string, unknown> }> {
    return withDirectXhsRequestEnv(async () => {
      const api = new XHSLoginApi();
      const [success, message, updatedCookies] = await api.checkQrcodeStatus(qrId, code, cookies);
      let status = success ? "confirmed" : "pending";
      if (message.includes("过期") || message.toLowerCase().includes("expired")) status = "expired";
      if (message.includes("确认") || message.toLowerCase().includes("confirm")) status = "scanned";
      return { status, cookies: (updatedCookies ?? {}) as Record<string, unknown> };
    });
  }

  /** 用户信息（对应 get_user_info） */
  async getUserInfo(cookies: Record<string, string>): Promise<Record<string, unknown>> {
    return withDirectXhsRequestEnv(async () => {
      const api = new XHSLoginApi();
      const [success, data, _] = await api.getUserInfo(cookies);
      if (!success) throw new Error("Failed to fetch XHS user info");
      const info = data ?? {};
      return {
        external_user_id: String(info.user_id ?? ""),
        nickname: String(info.nickname ?? ""),
        avatar_url: String(info.images ?? info.imageb ?? ""),
        profile: {
          red_id: String(info.red_id ?? info.redId ?? ""),
          followers: info.fans ?? info.followers ?? info.follower_count,
          following: info.follows ?? info.following ?? info.following_count,
          likes: info.liked_count ?? info.likes ?? info.like_count,
          raw: data,
        },
      };
    });
  }

  /** 短信验证码（对应 create_phone_session） */
  async createPhoneSession(phone: string): Promise<Record<string, unknown>> {
    return withDirectXhsRequestEnv(async () => {
      const api = new XHSLoginApi();
      const cookies = await api.generateInitCookies();
      const [success, message] = await api.sendPhoneCode(phone, cookies, "86");
      if (!success) throw new Error(message);
      return { cookies, message: message || "sent" };
    });
  }

  /** 短信登录确认（对应 confirm_phone_login） */
  async confirmPhoneLogin(phone: string, code: string, cookies: Record<string, string>): Promise<Record<string, unknown>> {
    return withDirectXhsRequestEnv(async () => {
      const api = new XHSLoginApi();
      const [success, message, payload] = await api.loginByPhone(phone, code, cookies, "86");
      if (!success || !payload) throw new Error(message);
      return { status: "confirmed", cookies: payload.cookies };
    });
  }
}
