/**
 * LLM 结构化输出解析工具：从回复中提取 JSON 对象
 * 容忍 markdown 代码块与前后缀噪声；非 JSON 返回 null
 */

/** 提取首个 JSON 对象（代码块包裹 / 裸 JSON / 带噪声均可） */
export function extractJsonObject<T>(content: string): T | null {
  let text = content.trim();
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) text = fenceMatch[1].trim();
  const braceStart = text.indexOf("{");
  const braceEnd = text.lastIndexOf("}");
  if (braceStart >= 0 && braceEnd > braceStart) {
    try {
      return JSON.parse(text.slice(braceStart, braceEnd + 1)) as T;
    } catch {
      return null;
    }
  }
  return null;
}

/** 提取数组（某些模型直接输出数组） */
export function extractJsonArray<T>(content: string): T[] | null {
  let text = content.trim();
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) text = fenceMatch[1].trim();
  const bracketStart = text.indexOf("[");
  const bracketEnd = text.lastIndexOf("]");
  if (bracketStart >= 0 && bracketEnd > bracketStart) {
    try {
      const value = JSON.parse(text.slice(bracketStart, bracketEnd + 1));
      return Array.isArray(value) ? (value as T[]) : null;
    } catch {
      return null;
    }
  }
  return null;
}
