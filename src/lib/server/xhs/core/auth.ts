/**
 * 共享平台配置与认证基类（对应原版 xhs_core/auth.py）
 */
export const AUTH_LOGIN_SOURCES = new Set(["cookie", "qrcode", "phone"]);

export interface PlatformOrigins {
  web: string;
  api: string;
  search?: string;
  login?: string;
  security?: string;
  captcha?: string;
  sem?: string;
  edith?: string;
  upload?: string;
  public_web?: string;
}

/** 平台身份与命名服务源（对应 XHSPlatformConfig） */
export class XHSPlatformConfig {
  readonly name: string;
  readonly appId: string;
  readonly cookieDomain: string;
  readonly origins: Record<string, string>;

  constructor(name: string, appId: string, cookieDomain: string, origins: Record<string, string>) {
    this.name = name;
    this.appId = appId;
    this.cookieDomain = cookieDomain;
    const normalized: Record<string, string> = {};
    for (const [role, origin] of Object.entries(origins)) {
      const clean = String(origin).replace(/\/+$/, "");
      try {
        const parsed = new URL(clean);
        if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname) {
          throw new Error(`invalid ${name} origin for ${role}: ${origin}`);
        }
      } catch {
        throw new Error(`invalid ${name} origin for ${role}: ${origin}`);
      }
      normalized[String(role)] = clean;
    }
    if (!normalized.web || !normalized.api) {
      throw new Error("platform origins must contain web and api roles");
    }
    this.origins = normalized;
  }

  origin(role = "api"): string {
    const value = this.origins[String(role)];
    if (!value) {
      throw new Error(`${this.name} platform has no origin role ${role}; available: ${Object.keys(this.origins).sort().join(", ")}`);
    }
    return value;
  }

  host(role = "api"): string {
    return new URL(this.origin(role)).host;
  }
}

export const PC_PLATFORM_CONFIG = new XHSPlatformConfig("pc", "xhs-pc-web", ".xiaohongshu.com", {
  web: "https://www.xiaohongshu.com",
  api: "https://edith.xiaohongshu.com",
  search: "https://so.xiaohongshu.com",
  login: "https://www.xiaohongshu.com",
  security: "https://as.xiaohongshu.com",
  captcha: "https://edith.xiaohongshu.com",
  sem: "https://pages.xiaohongshu.com",
});

export const CREATOR_PLATFORM_CONFIG = new XHSPlatformConfig("creator", "ugc", ".xiaohongshu.com", {
  web: "https://creator.xiaohongshu.com",
  api: "https://creator.xiaohongshu.com",
  login: "https://customer.xiaohongshu.com",
  security: "https://as.xiaohongshu.com",
  captcha: "https://edith.xiaohongshu.com",
  edith: "https://edith.xiaohongshu.com",
  upload: "https://ros-upload.xiaohongshu.com",
  public_web: "https://www.xiaohongshu.com",
});

/** 认证基类（对应 XHSAuth） */
export abstract class XHSAuth {
  platform = "";
  proxies?: Record<string, string> | null;
  protected platformConfig: XHSPlatformConfig | null = null;

  get config(): XHSPlatformConfig {
    if (!this.platformConfig) {
      throw new Error(`${this.constructor.name} must define PLATFORM_CONFIG`);
    }
    return this.platformConfig;
  }

  get domains(): Record<string, string> {
    return this.config.origins;
  }

  origin(role = "api"): string {
    return this.config.origin(role);
  }

  /** 绑定子类身份并校验登录来源（对应 _bind_platform） */
  protected bindPlatform(loginSource: string): string {
    this.platform = this.config.name;
    const source = String(loginSource || "cookie");
    if (!AUTH_LOGIN_SOURCES.has(source)) {
      throw new Error("login_source must be cookie, qrcode, or phone");
    }
    return source;
  }
}
