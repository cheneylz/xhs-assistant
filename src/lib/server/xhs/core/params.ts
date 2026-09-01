/**
 * 平台无关的请求标识（对应原版 xhs_core/params.py）
 */
/** 生成 x-b3-traceid（16 位十六进制随机串） */
export function generateXB3Traceid(length = 16): string {
  const alphabet = "abcdef0123456789";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += alphabet[Math.floor(16 * Math.random())];
  }
  return result;
}

let xraySeq = Math.floor(Math.random() * 0x7fffff);

/** 生成 x-xray-traceid（还原自 xhs_xray.js traceId） */
export function generateXrayTraceid(): string {
  const now = Date.now();
  xraySeq = (xraySeq + 1) & 0x7fffff;
  const part1 = ((BigInt(now) << 23n) | BigInt(xraySeq)) & 0xffffffffffffffffn;
  const random64 = (BigInt(Math.floor(Math.random() * 0x100000000)) << 32n) | BigInt(Math.floor(Math.random() * 0x100000000));
  return part1.toString(16).padStart(16, "0") + random64.toString(16).padStart(16, "0");
}

/** 拼接 api 与查询参数（对应 splice_str） */
export function spliceStr(api: string, params: Record<string, unknown>): string {
  const query = Object.entries(params)
    .map(([key, value]) => `${encodeURIComponent(key)}=${value === null || value === undefined ? "" : encodeURIComponent(String(value))}`)
    .join("&");
  return `${api}?${query}`;
}
