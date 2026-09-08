/**
 * PROMPT 集中管理加载器
 *
 * 所有 LLM Prompt 统一存放于 src/prompts/ 下的 Markdown 文件中，
 * 代码内不再内联 Prompt，统一通过 renderPrompt 加载渲染。
 *
 * 文件格式约定：
 *   每个 Prompt 用 HTML 注释标记段，如：
 *   <!-- prompt:intent -->
 *   你是小红书评论区意图分析助手。...
 *   <!-- /prompt:intent -->
 *
 * 模板变量：正文中的 {{变量名}} 会在渲染时被替换（默认保留未提供变量原样输出）。
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Prompts 目录（dev 与 Docker standalone 下 cwd 均为项目根目录，见 Dockerfile WORKDIR /app） */
const PROMPTS_DIR = join(process.cwd(), "src", "prompts");

/** 文件缓存：以 mtime 判断文件是否变化（dev 下改 md 即时生效） */
const fileCache = new Map<string, { mtimeMs: number; content: string }>();

function readPromptFile(fileName: string): string {
  const filePath = join(PROMPTS_DIR, fileName);
  const stat = statSync(filePath);
  const cached = fileCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.content;
  const content = readFileSync(filePath, "utf-8");
  fileCache.set(filePath, { mtimeMs: stat.mtimeMs, content });
  return content;
}

const SECTION_RE = /<!--\s*prompt:([\w.-]+)\s*-->([\s\S]*?)<!--\s*\/prompt:\1\s*-->/g;

/** 渲染指定 Prompt：读取 md 文件 → 提取对应段 → 替换 {{变量}} 占位符 */
export function renderPrompt(fileName: string, key: string, vars: Record<string, string | number> = {}): string {
  const fileContent = readPromptFile(fileName);
  const sections = new Map<string, string>();
  for (const match of fileContent.matchAll(SECTION_RE)) {
    sections.set(match[1], match[2].trim());
  }
  const template = sections.get(key);
  if (template === undefined) throw new Error(`Prompt 未找到: ${fileName}#${key}`);
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name: string) => {
    const value = vars[name];
    return value !== undefined ? String(value) : match;
  });
}
