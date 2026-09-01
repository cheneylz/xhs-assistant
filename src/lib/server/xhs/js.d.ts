/**
 * 原版签名算法 JS 文件的类型声明（文件本身原样保留，不做任何修改）
 * 这些文件与 Python 版共用同一份源文件，XHS 升级签名时同步替换
 */

declare module "./js/core/b1.js" {
  export function generateB1(options?: Record<string, unknown>): { b1: string; mini: Record<string, unknown> };
  export function decodeB1(value: string): Record<string, unknown>;
  export function encodeB1FromMini(mini: Record<string, unknown>): string;
  export function buildMiniFields(options: Record<string, unknown>): Record<string, unknown>;
  export function formatTelemetry(options: Record<string, unknown>): string;
  export function orderedMiniFields(fields: Record<string, unknown>): Array<[string, unknown]>;
  export function rc4BinaryString(...args: unknown[]): unknown;
  export function customBase64(...args: unknown[]): unknown;
  export function customBase64Decode(...args: unknown[]): unknown;
  export const B1_RC4_KEY: unknown;
  export const B1_BASE64_ALPHABET: unknown;
  export const MINI_FIELD_KEYS: string[];
}

declare module "./js/core/sign.js" {
  export interface SignResult {
    xs?: string;
    xt?: string;
    xs_common?: string;
    x3?: string;
    len?: number;
    prefix?: string;
    [key: string]: unknown;
  }
  export function signFull(input: Record<string, unknown>): SignResult;
  export function encodeXs(...args: unknown[]): string;
  export function encodeUtf8(value: string): string;
  export function b64XS(...args: unknown[]): string;
  export function runDsfProgram(program: string, inputBytes: number[], timeoutMs?: number): number[];
}

declare module "./js/core/xs_common.js" {
  export function xsCommon(...args: unknown[]): unknown;
  export function gens9(...args: unknown[]): unknown;
}

declare module "./js/core/mns.js" {
  export function signTier(...args: unknown[]): unknown;
  export function hexToBytes(...args: unknown[]): unknown[];
}

declare module "./js/pc/profile.js" {
  export function buildProfileFields(options: Record<string, unknown>): Record<string, unknown>;
  export function encodeProfileData(fields: Record<string, unknown>): string;
  export function generateProfileData(options: Record<string, unknown>): string;
}

declare module "./js/pc/rap.js" {
  export function buildRapPure(options: { api: string; data: string; fingerprint: Buffer }): string;
  export function xxHash32(...args: unknown[]): unknown;
  export function randomAscii(...args: unknown[]): unknown;
  export const ALPHABET36: string;
}

declare module "./js/creator/profile.js" {
  export function buildTelemetry(...args: unknown[]): unknown;
  export function buildProfileFields(options: Record<string, unknown>): Record<string, unknown>;
  export function encodeProfileData(fields: Record<string, unknown>): string;
  export function generateProfileData(options: Record<string, unknown>): string;
}

declare module "./js/creator/xhs_creator_sign.js" {
  export function dec2hex(value: number, width?: number): string;
  export function urlSing(value: string, timestampMs?: number): string;
}

declare module "./js/creator/profile.js";
declare module "./js/pc/reference_profile.json" {
  const value: Record<string, any>;
  export default value;
}
declare module "./js/creator/reference_profile.json" {
  const value: Record<string, any>;
  export default value;
}
declare module "./js/pc/rap_fingerprint_template.json" {
  const value: Record<string, any>;
  export default value;
}
declare module "./js/creator/rap_fingerprint_creator.json" {
  const value: Record<string, any>;
  export default value;
}
declare module "./js/core/mns_keystreams.json" {
  const value: Record<string, any>;
  export default value;
}
declare module "./js/core/mns_0101_keystream.json" {
  const value: Record<string, any>;
  export default value;
}
