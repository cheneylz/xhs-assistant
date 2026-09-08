/**
 * AI 服务（对应原版 backend/app/services/ai_service.py）
 * OpenAI 兼容文本/图片客户端，用 fetch 替代 requests
 */
import { existsSync, readFileSync } from "node:fs";
import { getConfig } from "../core/config";
import { renderPrompt } from "../../../prompts/loader";

export interface ModelConfigLike {
  id: number;
  userId: number;
  name: string;
  modelType: string;
  provider: string;
  modelName: string;
  baseUrl: string;
  encryptedApiKey: string;
  isDefault: boolean;
}

/** 尝试多种编码解析 JSON（对应 _load_json_response） */
function loadJsonResponse(body: Buffer): unknown {
  const raw = body;
  const encodings = ["utf-8-sig", "utf-8"];
  for (const encoding of encodings) {
    try {
      return JSON.parse(raw.toString(encoding as BufferEncoding));
    } catch {
      // 继续尝试下一编码
    }
  }
  try {
    return JSON.parse(raw.toString("utf-8"));
  } catch (error) {
    throw new Error(`AI response is not valid JSON: ${(error as Error).message}`);
  }
}

async function postJson(endpoint: string, body: unknown, apiKey: string, timeoutMs: number): Promise<{ json: unknown; status: number; bodyText: string }> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const responseBody = Buffer.from(await response.arrayBuffer());
  const json = loadJsonResponse(responseBody);
  if (!response.ok) {
    const error = new Error(`AI request failed: HTTP ${response.status}`);
    (error as Error & { response?: unknown }).response = json;
    throw error;
  }
  return { json, status: response.status, bodyText: responseBody.toString("utf-8") };
}

function contentFromPayload(payload: Record<string, unknown>): string {
  const choices = payload.choices;
  const content = (choices as Array<{ message?: { content?: unknown } }> | undefined)?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("AI response missing choices[0].message.content");
  }
  return content.trim();
}

/** 文案包（C-01）：标题备选 + 正文 + 话题标签 + CTA */
export interface NotePack {
  titles: string[];
  body: string;
  tags: string[];
  cta: string[];
}

/** 去AI味强度 → 改写要求（C-02） */
export function rewriteIntensityInstruction(intensity?: string): string {
  switch (intensity) {
    case "light":
      return "轻度去AI味：仅微调表达，去除明显模板化措辞，不做大改";
    case "deep":
      return "深度去AI味：彻底重写，删除模板化开头（如「今天给大家分享一下」）、避免「首先/其次/最后」等结构化连接词，加入第一人称真实体验细节、口语化表达和情绪词，读起来像真实用户随手写的";
    default:
      return "中度去AI味：口语化改写，删除模板化开头与结构化连接词，增加第一人称体验描述和语气词";
  }
}

/** 解析文案包输出：优先 JSON，失败降级为「标题：/正文：/标签：/CTA：」文本解析（纯函数，可单测） */
export function parseNotePack(content: string): NotePack {
  const text = content.trim();
  // 1) JSON 优先
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  let jsonText = fenceMatch ? fenceMatch[1].trim() : text;
  const braceStart = jsonText.indexOf("{");
  const braceEnd = jsonText.lastIndexOf("}");
  if (braceStart >= 0 && braceEnd > braceStart) {
    try {
      const payload = JSON.parse(jsonText.slice(braceStart, braceEnd + 1)) as Record<string, unknown>;
      const titles = Array.isArray(payload.titles) ? payload.titles.map(String).map(cleanListItem).filter(Boolean) : [];
      const tags = Array.isArray(payload.tags) ? payload.tags.map(String).map(cleanListItem).filter(Boolean) : [];
      const cta = Array.isArray(payload.cta) ? payload.cta.map(String).map(cleanListItem).filter(Boolean) : [];
      const body = typeof payload.body === "string" ? payload.body.trim() : "";
      if (body && (titles.length || tags.length)) {
        return { titles: titles.slice(0, 5), body, tags: tags.slice(0, 10), cta: cta.slice(0, 2) };
      }
    } catch {
      // 继续文本解析
    }
  }
  // 2) 文本解析降级：标题：… / 正文：… / 标签：… / CTA：…
  const lines = text.split("\n");
  const titles: string[] = [];
  let body = "";
  const tags: string[] = [];
  const cta: string[] = [];
  let section: "none" | "body" | "tags" | "cta" = "none";
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.startsWith("标题")) {
      section = "none";
      const value = line.replace(/^标题[:：\s\d\-、.。]*/, "").trim();
      if (value) titles.push(value);
      continue;
    }
    if (line.startsWith("正文")) {
      section = "body";
      const value = line.replace(/^正文[:：]?\s*/, "").trim();
      if (value) body = value;
      continue;
    }
    if (line.startsWith("标签")) {
      section = "tags";
      const value = line.replace(/^标签[:：]?\s*/, "").trim();
      for (const tag of splitCsv(value)) {
        if (tag) tags.push(tag);
      }
      continue;
    }
    if (line.startsWith("CTA") || line.startsWith("行动") || line.startsWith("引导")) {
      section = "cta";
      const value = line.replace(/^(CTA|行动引导|引导)[:：]?\s*/, "").trim();
      if (value) cta.push(value);
      continue;
    }
    if (section === "body" && line) body = body ? `${body}\n${line}` : line;
    if (section === "tags" && line) {
      for (const tag of splitCsv(line)) {
        if (tag) tags.push(tag);
      }
    }
    if (section === "cta" && line) cta.push(line);
  }
  return { titles: titles.slice(0, 5), body, tags: tags.slice(0, 10), cta: cta.slice(0, 2) };
}

/** 清洗列表项（序号/引号/# 前缀） */
function cleanListItem(value: string): string {
  return value.replace(/^[\s\d\-、.。:##"'“”]+|[\s"'”’]+$/g, "").trim();
}

/** 按逗号/换行/井号拆分话题标签 */
function splitCsv(value: string): string[] {
  return value
    .replace(/，/g, ",")
    .split(/[,\n#]+/)
    .map((item) => item.trim().replace(/^#/, ""))
    .filter(Boolean);
}

/** OpenAI 兼容文本客户端（对应 OpenAICompatibleTextClient） */
export class OpenAICompatibleTextClient {
  async complete(options: {
    modelConfig: ModelConfigLike;
    apiKey: string;
    systemPrompt: string;
    userPrompt: string;
    temperature?: number;
    onUsage?: (usage: { promptTokens: number; completionTokens: number }) => void; // S-06 用量采集回调
  }): Promise<string> {
    const { modelConfig, apiKey, systemPrompt, userPrompt, temperature = 0.7, onUsage } = options;
    if (!modelConfig.baseUrl) throw new Error("Text model base_url is required");
    if (!modelConfig.modelName) throw new Error("Text model_name is required");
    if (!apiKey) throw new Error("Text model api_key is required");
    const endpoint = `${modelConfig.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const { json } = await postJson(
      endpoint,
      {
        model: modelConfig.modelName,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature,
      },
      apiKey,
      60000,
    );
    if (onUsage) {
      const usage = (json as Record<string, unknown>).usage as Record<string, unknown> | undefined;
      if (usage) {
        onUsage({
          promptTokens: Number(usage.prompt_tokens ?? usage.promptTokens ?? 0) || 0,
          completionTokens: Number(usage.completion_tokens ?? usage.completionTokens ?? 0) || 0,
        });
      }
    }
    return contentFromPayload(json as Record<string, unknown>);
  }

  async rewriteNote(options: {
    modelConfig: ModelConfigLike;
    apiKey: string;
    title: string;
    body: string;
    instruction: string;
    intensity?: string; // 去AI味强度：light/medium/deep（C-02）
    onUsage?: (usage: { promptTokens: number; completionTokens: number }) => void;
  }): Promise<string> {
    const intensityInstruction = rewriteIntensityInstruction(options.intensity);
    const combined = [intensityInstruction, options.instruction || ""].filter(Boolean).join("\n") || "提升表达、增强小红书语感";
    return this.complete({
      modelConfig: options.modelConfig,
      apiKey: options.apiKey,
      systemPrompt: renderPrompt("ai-notes.md", "rewrite-note"),
      userPrompt: `改写要求：${combined}\n\n标题：${options.title}\n\n正文：\n${options.body}`,
      onUsage: options.onUsage,
    });
  }

  async generateNote(options: { modelConfig: ModelConfigLike; apiKey: string; topic: string; reference: 
    string; instruction: string; onUsage?: (usage: { promptTokens: number; completionTokens: number }) => void }): Promise<{ title: string; body: string }> {
    const content = await this.complete({
      modelConfig: options.modelConfig,
      apiKey: options.apiKey,
      systemPrompt: renderPrompt("ai-notes.md", "generate-note"),
      userPrompt: `请生成一篇小红书笔记，格式必须是：\n标题：...\n正文：...\n\n选题：${options.topic}\n参考材料：${options.reference || "无"}\n要求：${options.instruction || "自然、有信息密度"}`,
      onUsage: options.onUsage,
    });
    let title = options.topic;
    let body = content;
    for (const line of content.split("\n")) {
      if (line.startsWith("标题：")) {
        title = line.replace("标题：", "").trim() || title;
        break;
      }
    }
    if (content.includes("正文：")) {
      body = content.slice(content.indexOf("正文：") + 3).trim();
    }
    return { title, body };
  }

  /** 生成完整文案包（C-01）：标题 3-5 备选 + 正文 + 标签 + CTA，结构化输出 */
  async generateNotePack(options: {
    modelConfig: ModelConfigLike;
    apiKey: string;
    topic: string;
    kbContext?: string; // 知识库上下文（buildKbContext 输出）
    direction?: string; // 内容方向
    style?: string; // 文案风格：种草型/干货型/测评型
    reference?: string;
    instruction?: string;
    onUsage?: (usage: { promptTokens: number; completionTokens: number }) => void;
  }): Promise<NotePack> {
    const { modelConfig, apiKey, topic, kbContext = "", direction, style, reference, instruction } = options;
    const kbSection = kbContext ? `\n\n【账号知识库（必须遵循）】\n${kbContext}` : "";
    const styleLine = style ? `，文案风格为「${style}」` : "";
    const directionLine = direction ? `\n内容方向：${direction}` : "";
    const content = await this.complete({
      modelConfig,
      apiKey,
      systemPrompt: renderPrompt("ai-notes.md", "note-pack", { styleLine }),
      userPrompt: `选题：${topic}${directionLine}\n参考材料：${reference || "无"}\n额外要求：${instruction || "自然、有信息密度"}${kbSection}`,
      temperature: 0.8,
      onUsage: options.onUsage,
    });
    return parseNotePack(content);
  }

  /** 生成短视频分镜脚本（C-05）：开场钩子 → 内容展开 → 结尾引导 */
  async generateVideoScript(options: {
    modelConfig: ModelConfigLike;
    apiKey: string;
    title: string;
    body: string;
    onUsage?: (usage: { promptTokens: number; completionTokens: number }) => void;
  }): Promise<string> {
    return this.complete({
      modelConfig: options.modelConfig,
      apiKey: options.apiKey,
      systemPrompt: renderPrompt("ai-notes.md", "video-script"),
      userPrompt: `标题：${options.title}\n\n文案：\n${options.body}`,
      temperature: 0.7,
      onUsage: options.onUsage,
    });
  }

  async generateTitles(options: { modelConfig: ModelConfigLike; apiKey: string; title: string; body: string; count: number; onUsage?: (usage: { promptTokens: number; completionTokens: number }) => void }): Promise<string[]> {
    const content = await this.complete({
      modelConfig: options.modelConfig,
      apiKey: options.apiKey,
      systemPrompt: renderPrompt("ai-notes.md", "generate-titles"),
      userPrompt: `请给出 ${options.count} 个小红书标题，每行一个。\n原标题：${options.title}\n正文：${options.body}`,
      onUsage: options.onUsage,
    });
    return content
      .split("\n")
      .map((line) => line.replace(/^[\s\d\-、.。]+/, "").trim())
      .filter(Boolean)
      .slice(0, options.count);
  }

  async generateTags(options: { modelConfig: ModelConfigLike; apiKey: string; title: string; body: string; count: number; onUsage?: (usage: { promptTokens: number; completionTokens: number }) => void }): Promise<string[]> {
    const content = await this.complete({
      modelConfig: options.modelConfig,
      apiKey: options.apiKey,
      systemPrompt: renderPrompt("ai-notes.md", "generate-tags"),
      userPrompt: `请给出 ${options.count} 个小红书话题标签，只输出标签，用逗号或换行分隔。\n标题：${options.title}\n正文：${options.body}`,
      onUsage: options.onUsage,
    });
    const separators = content.replace(/，/g, ",").replace(/\n/g, ",").split(",");
    return separators
      .map((item) => item.trim().replace(/^#/, ""))
      .filter(Boolean)
      .slice(0, options.count);
  }

  async polishText(options: { modelConfig: ModelConfigLike; apiKey: string; text: string; instruction: string; onUsage?: (usage: { promptTokens: number; completionTokens: number }) => void }): Promise<string> {
    return this.complete({
      modelConfig: options.modelConfig,
      apiKey: options.apiKey,
      systemPrompt: renderPrompt("ai-notes.md", "polish-text"),
      userPrompt: `润色要求：${options.instruction || "更自然、清晰、有种草感"}\n\n原文：\n${options.text}`,
      onUsage: options.onUsage,
    });
  }
}

/** 解析本地图片为 data URL（对应 _resolve_image_ref） */
function resolveImageRef(url: string): string {
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  if (url.startsWith("/api/files/media/")) {
    const fileName = url.split("/").pop() ?? "";
    const local = `${getConfig().storageDir}/media/${fileName}`;
    if (existsSync(local)) {
      const raw = readFileSync(local);
      const ext = local.split(".").pop()?.toLowerCase() ?? "png";
      const mime: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp" };
      return `data:${mime[ext] ?? "image/png"};base64,${raw.toString("base64")}`;
    }
  }
  return url;
}

/** OpenAI 兼容图片客户端（对应 OpenAICompatibleImageClient） */
export class OpenAICompatibleImageClient {
  private validate(modelConfig: ModelConfigLike, apiKey: string): void {
    if (!modelConfig.baseUrl) throw new Error("Image model base_url is required");
    if (!modelConfig.modelName) throw new Error("Image model_name is required");
    if (!apiKey) throw new Error("Image model api_key is required");
  }

  async generateCover(options: { modelConfig: ModelConfigLike; apiKey: string; prompt: string; size: string; style: string }): Promise<{ url: string; raw: unknown }> {
    return this.generateImage({
      modelConfig: options.modelConfig,
      apiKey: options.apiKey,
      prompt: `${options.prompt}\nStyle: ${options.style || "clean XHS cover"}`,
    });
  }

  async generateImage(options: {
    modelConfig: ModelConfigLike;
    apiKey: string;
    prompt: string;
    referenceImages?: string[] | null;
  }): Promise<{ url: string; raw: unknown }> {
    const { modelConfig, apiKey, prompt, referenceImages } = options;
    this.validate(modelConfig, apiKey);
    const endpoint = `${modelConfig.baseUrl.replace(/\/+$/, "")}/images/generations`;
    const body: Record<string, unknown> = { model: modelConfig.modelName, prompt, response_format: "url" };
    if (referenceImages && referenceImages.length) {
      const resolved = referenceImages.map(resolveImageRef);
      if (resolved.length === 1) body.image = resolved[0];
      else {
        body.image = resolved;
        body.sequential_image_generation = "disabled";
      }
      body.watermark = false;
    }
    let json: unknown;
    try {
      const result = await postJson(endpoint, body, apiKey, 180000);
      json = result.json;
    } catch (error) {
      const errorWithResponse = error as Error & { response?: unknown };
      let detail = String(errorWithResponse.message);
      const errorPayload = errorWithResponse.response as Record<string, unknown> | undefined;
      const errorDetail = errorPayload?.error as Record<string, unknown> | undefined;
      if (errorDetail?.message) detail = String(errorDetail.message);
      throw new Error(`图片生成失败: ${detail}`);
    }
    const payload = json as Record<string, unknown>;
    const item = (payload.data as Array<Record<string, unknown>> | undefined)?.[0];
    if (!item) throw new Error("Image response missing data[0]");
    const imageRef = item.url ?? item.b64_json;
    if (typeof imageRef !== "string" || !imageRef) throw new Error("Image response missing url or b64_json");
    return { url: imageRef, raw: payload };
  }

  async describeImage(options: { modelConfig: ModelConfigLike; apiKey: string; imageUrl: string; instruction: string }): Promise<string> {
    const { modelConfig, apiKey, imageUrl, instruction } = options;
    this.validate(modelConfig, apiKey);
    const endpoint = `${modelConfig.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const { json } = await postJson(
      endpoint,
      {
        model: modelConfig.modelName,
        messages: [
          { role: "system", content: renderPrompt("ai-notes.md", "describe-image") },
          {
            role: "user",
            content: [
              { type: "text", text: instruction || "描述这张图片适合的小红书卖点。" },
              { type: "image_url", image_url: { url: resolveImageRef(imageUrl) } },
            ],
          },
        ],
      },
      apiKey,
      120000,
    );
    return contentFromPayload(json as Record<string, unknown>);
  }
}
