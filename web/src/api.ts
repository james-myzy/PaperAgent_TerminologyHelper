/** 与本地 agent 服务通信：文档、术语、翻译、导出、对话 */

export interface Term {
  id: string;
  name: string;
  zhName?: string;
  brief: string;
  source?: string;
  pages?: number[];
  /** 是否在正文里铺高亮（单字母、文件名、配置键这类会关掉） */
  highlight?: boolean;
}

export interface Block {
  type: "h" | "p";
  text: string;
}

export interface PageBlock {
  page: number;
  text: string;
  blocks: Block[];
}

export interface DocPayload {
  id: string;
  title: string;
  kind: string;
  filename: string;
  pageCount: number;
  charCount: number;
  language: string;
  pages: PageBlock[];
  terms: Term[];
  details: Record<string, string>;
  translations: Record<string, string>;
  /** 逐段译文缓存：键是「页码:段序号」，值是 { hash, text } */
  blockTranslations?: Record<string, { hash: string; text: string }>;
}

export interface ServerConfig {
  ok: boolean;
  provider: string;
  model: string;
  baseUrl: string;
  hasKey: boolean;
  /** 已配置时只回显尾部，如 sk-…a91f */
  keyMask?: string;
  /** true = 模型由 DeepSeek Harness 统一提供（插件模式），不需要自己填 Key */
  managed?: boolean;
  maxSteps: number;
}

export interface AgentEvent {
  type: string;
  [key: string]: unknown;
}

/**
 * 部署前缀：独立运行时是 ""，挂到 DSH 的 /paper-agent/ 下时由 Vite 的 base 提供。
 * 所有接口都经过它，保证同一份代码两种部署都能用。
 */
const BASE = (import.meta.env?.BASE_URL ?? "/").replace(/\/+$/, "");

export function apiUrl(path: string): string {
  if (!path.startsWith("/")) return `${BASE}/${path}`;
  return `${BASE}${path}`;
}

async function asJson(res: Response) {
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((payload as { error?: string }).error ?? `请求失败（${res.status}）`);
  return payload;
}

export async function fetchConfig(): Promise<ServerConfig> {
  const res = await fetch(apiUrl("/api/health"));
  return asJson(res) as Promise<ServerConfig>;
}

/** 保存模型设置（写入 .env，重启后仍生效） */
export async function saveSettings(payload: {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}): Promise<ServerConfig> {
  const res = await fetch(apiUrl("/api/settings"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return asJson(res) as Promise<ServerConfig>;
}

export async function fetchDocument(id: string): Promise<DocPayload | null> {
  const res = await fetch(apiUrl(`/api/documents/${id}`));
  if (!res.ok) return null;
  return (await res.json()) as DocPayload;
}

export async function uploadDocument(file: File): Promise<DocPayload> {
  const buffer = await file.arrayBuffer();
  const res = await fetch(apiUrl("/api/documents"), {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-Filename": encodeURIComponent(file.name),
    },
    body: buffer,
  });
  return asJson(res) as Promise<DocPayload>;
}

export async function uploadText(text: string, title = "粘贴的正文"): Promise<DocPayload> {
  const file = new File([text], `${title}.txt`, { type: "text/plain" });
  return uploadDocument(file);
}

/** 读 SSE：POST + ReadableStream，逐帧回调 */
async function readSSE(
  url: string,
  payload: unknown,
  onEvent: (event: AgentEvent) => void,
  signal?: AbortSignal,
) {
  const res = await fetch(apiUrl(url), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    let message = `请求失败（${res.status}）`;
    try {
      message = JSON.parse(detail).error ?? message;
    } catch {
      /* 非 JSON 错误体 */
    }
    throw new Error(message);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const chunk = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      for (const line of chunk.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const raw = line.slice(5).trim();
        if (!raw) continue;
        try {
          onEvent(JSON.parse(raw) as AgentEvent);
        } catch {
          /* 半包忽略 */
        }
      }
      boundary = buffer.indexOf("\n\n");
    }
  }
}

export async function streamChat(
  payload: { documentId?: string | null; messages: { role: string; content: string }[] },
  onEvent: (event: AgentEvent) => void,
  signal?: AbortSignal,
) {
  return readSSE("/api/chat", payload, onEvent, signal);
}

/** 术语识别（词库 + 模型），返回术语并写入服务端状态 */
export async function extractTerms(docId: string, maxChunks?: number): Promise<{ terms: Term[] }> {
  const res = await fetch(apiUrl(`/api/documents/${docId}/terms`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(maxChunks ? { max_chunks: maxChunks } : {}),
  });
  return asJson(res) as Promise<{ terms: Term[] }>;
}

/** 点术语 → 边生成边推送的三段式解释 */
export async function explainTermStream(
  docId: string,
  term: string,
  onEvent: (event: AgentEvent) => void,
  signal?: AbortSignal,
  options: { force?: boolean } = {},
) {
  return readSSE(
    `/api/documents/${docId}/explain`,
    { term, force: Boolean(options.force) },
    onEvent,
    signal,
  );
}

/** 选段解释：服务端按「页码 + 选段」缓存，同一段只问一次模型 */
export async function explainPassageStream(
  docId: string,
  payload: { text: string; page?: number; force?: boolean },
  onEvent: (event: AgentEvent) => void,
  signal?: AbortSignal,
) {
  return readSSE(`/api/documents/${docId}/explain-passage`, payload, onEvent, signal);
}

/**
 * 双语对照：逐段翻译，边生成边推送。
 * 事件：start(total) / progress(done,total) / block(page,index,text,cached) / done(count,cached)
 */
export async function translateBlocksStream(
  docId: string,
  pages: number[] | undefined,
  onEvent: (event: AgentEvent) => void,
  signal?: AbortSignal,
  options: { force?: boolean } = {},
) {
  return readSSE(
    `/api/documents/${docId}/translate-blocks`,
    { pages, force: Boolean(options.force) },
    onEvent,
    signal,
  );
}

export async function exportDocx(docId: string): Promise<{ url: string; filename: string; terms: number }> {
  const res = await fetch(apiUrl(`/api/documents/${docId}/export`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  const payload = (await asJson(res)) as { url: string; filename: string; terms: number };
  // 服务端返回的是根路径，挂到子路径下时要补上 base
  return { ...payload, url: apiUrl(payload.url) };
}

/** 读者自己添加术语（立刻在正文高亮） */
export async function addCustomTerm(
  docId: string,
  payload: { name: string; zhName?: string; brief?: string },
): Promise<{ terms: Term[]; added: Term }> {
  const res = await fetch(apiUrl(`/api/documents/${docId}/terms/custom`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return asJson(res) as Promise<{ terms: Term[]; added: Term }>;
}

/** 删除术语（服务端记下来，重新识别不会复活） */
export async function deleteTerm(docId: string, termId: string): Promise<{ terms: Term[] }> {
  const res = await fetch(apiUrl(`/api/documents/${docId}/terms/${termId}`), { method: "DELETE" });
  return asJson(res) as Promise<{ terms: Term[] }>;
}
