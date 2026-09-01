/**
 * PC 签名运行时（对应原版 xhs_pc/runtime.py）
 * 门禁逻辑与 Python 版一致；JS 调用直接 require（消除子进程）
 */
import { generateB1 as coreGenerateB1, generatePcProfileData, generateWebsectiga, runSigner as coreRunSigner, type SignerInput } from "../core/runtime";

export { generatePcProfileData, generateWebsectiga };

/** 生成 b1（对应 generate_b1，门禁一致） */
export function generateB1(options?: Record<string, unknown>): string {
  return coreGenerateB1(options);
}

/** 执行签名核心并按 PC 档位门禁校验（对应 run_signer） */
export function runSigner(
  input: SignerInput,
): Record<string, unknown> | null {
  return coreRunSigner(input, { gate: "pc" });
}

export const PC_WEBSECTIGA_DEFAULT_PAGE_URL = "https://www.xiaohongshu.com/explore?channel_id=homefeed_recommend";
