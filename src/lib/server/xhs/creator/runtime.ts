/**
 * Creator 签名运行时（对应原版 xhs_creator/runtime.py）
 */
import {
  generateB1 as coreGenerateB1,
  generateCreatorProfileData,
  generateWebsectiga,
  runSigner as coreRunSigner,
  type SignerInput,
} from "../core/runtime";

export { generateCreatorProfileData, generateWebsectiga };

/** 生成 b1（对应 generate_b1，门禁一致） */
export function generateB1(options?: Record<string, unknown>): string {
  return coreGenerateB1(options);
}

/** Creator 签名（对应 run_signer，含 0101/0201 门禁） */
export function runSigner(input: SignerInput): Record<string, unknown> {
  return coreRunSigner(input, { gate: "creator" }) ?? {};
}
