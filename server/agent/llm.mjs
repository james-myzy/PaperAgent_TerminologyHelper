/**
 * LLM 客户端：OpenAI 兼容协议（DeepSeek / 通义 / vLLM / Ollama 都能直连）。
 *
 * 两个实现：
 *  - deepseek：真实流式调用，支持 function calling 的增量拼装；
 *  - mock：离线演示模式，不需要 API Key，用脚本化响应验证「模型→工具→回复」整条链路。
 */
import { config } from "../config.mjs";
import { getLlmTransport } from "../llm-transport.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function* sseLines(response) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line.startsWith("data:")) yield line.slice(5).trim();
      index = buffer.indexOf("\n");
    }
  }
  const tail = buffer.trim();
  if (tail.startsWith("data:")) yield tail.slice(5).trim();
}

/** 合并调用方 signal 与超时 signal */
function withTimeout(signal) {
  const timeout = AbortSignal.timeout(config.requestTimeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function endpoint() {
  return `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;
}

async function streamChatReal({ messages, tools, temperature = 0.2, signal, onText }) {
  const body = {
    model: config.model,
    messages,
    stream: true,
    temperature,
  };
  if (tools?.length) {
    body.tools = tools;
    body.tool_choice = "auto";
  }

  const response = await fetch(endpoint(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: withTimeout(signal),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`模型接口返回 ${response.status}：${detail.slice(0, 300)}`);
  }

  let text = "";
  const toolCalls = [];
  let finishReason = "stop";

  for await (const data of sseLines(response)) {
    if (data === "[DONE]") break;
    let payload;
    try {
      payload = JSON.parse(data);
    } catch {
      continue;
    }
    const choice = payload.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta ?? {};
    if (typeof delta.content === "string" && delta.content) {
      text += delta.content;
      onText?.(delta.content);
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const call of delta.tool_calls) {
        const index = call.index ?? 0;
        if (!toolCalls[index]) {
          toolCalls[index] = { id: call.id ?? `call_${index}`, name: "", arguments: "" };
        }
        if (call.id) toolCalls[index].id = call.id;
        if (call.function?.name) toolCalls[index].name += call.function.name;
        if (call.function?.arguments) toolCalls[index].arguments += call.function.arguments;
      }
    }
  }

  return {
    text,
    toolCalls: toolCalls.filter(Boolean).filter((c) => c.name),
    finishReason,
  };
}

async function completeChatReal({ messages, temperature = 0.2, maxTokens, signal, json }) {
  const body = {
    model: config.model,
    messages,
    stream: false,
    temperature,
  };
  if (maxTokens) body.max_tokens = maxTokens;
  if (json) body.response_format = { type: "json_object" };

  const response = await fetch(endpoint(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: withTimeout(signal),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`模型接口返回 ${response.status}：${detail.slice(0, 300)}`);
  }
  const payload = await response.json();
  return { text: payload.choices?.[0]?.message?.content ?? "" };
}

/* ------------------------------------------------------------------ */
/* 离线演示模式：无需 API Key，行为可预测，用于自检与演示                 */
/* ------------------------------------------------------------------ */

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === "user") return String(messages[i].content ?? "");
  }
  return "";
}

function pickMockTool(messages, ctx) {
  const hasToolResult = messages.some((m) => m.role === "tool");
  if (hasToolResult) return null;
  const text = lastUserText(messages);
  // 顺序：先认明确动作词，再看泛化的「术语/高亮」，否则「导出术语高亮 Word」会被误判成抽取
  if (/导出|下载|word|docx/i.test(text)) return { name: "export_highlighted_docx", arguments: "{}" };
  // 优先取引号里的术语名，「解释一下「X」」应识别成 X 而不是「一下」
  const quoted = text.match(/[「“"]([^」”"]{2,40})[」”"]/);
  if (quoted && /解释|说明|什么意思|含义/.test(text)) {
    return { name: "explain_term", arguments: JSON.stringify({ term: quoted[1] }) };
  }
  const explicit = text.match(/解释(?:一下)?\s*([^\s「」“”"，。,、]{2,40})/);
  if (explicit) return { name: "explain_term", arguments: JSON.stringify({ term: explicit[1] }) };
  if (/翻译|译成|中文版/.test(text)) return { name: "translate_text", arguments: "{}" };
  if (/术语|抽取|识别|高亮/.test(text)) return { name: "extract_terms", arguments: "{}" };
  const search = text.match(/(?:搜索|查找|定位)[「“"]?([^「」”"，。]{2,30})/);
  if (search) return { name: "search_document", arguments: JSON.stringify({ query: search[1] }) };
  if (!ctx?.hasDocument) return { name: "document_overview", arguments: "{}" };
  return { name: "document_overview", arguments: "{}" };
}

function mockAnswer(messages, ctx) {
  const toolMessages = messages.filter((m) => m.role === "tool");
  if (!toolMessages.length) return "";
  const last = toolMessages[toolMessages.length - 1];
  let summary = "";
  try {
    const parsed = JSON.parse(last.content);
    summary = parsed.summary ?? JSON.stringify(parsed).slice(0, 400);
  } catch {
    summary = String(last.content).slice(0, 400);
  }
  return `（离线演示模式）已执行工具 \`${last.name ?? "工具"}\`。\n\n${summary}\n\n配置 .env 中的 LLM_API_KEY 后，这里会换成真实模型基于文档内容的分析回答。`;
}

const mock = {
  async streamChat({ messages, ctx, onText }) {
    await sleep(120);
    const call = pickMockTool(messages, ctx);
    if (call) {
      return {
        text: "",
        finishReason: "tool_calls",
        toolCalls: [{ id: `mock_${Date.now()}`, name: call.name, arguments: call.arguments }],
      };
    }
    const answer = mockAnswer(messages, ctx) || "（离线演示模式）请先上传一篇论文，我再来读。";
    for (const piece of answer.match(/[\s\S]{1,12}/g) ?? [answer]) {
      onText?.(piece);
      await sleep(12);
    }
    return { text: answer, finishReason: "stop", toolCalls: [] };
  },
  async completeChat({ messages }) {
    await sleep(80);
    const text = lastUserText(messages);
    const match = text.match(/术语：(.+)/);
    if (match) {
      return {
        text: `【专业定义】${match[1].trim()} 是本文使用的专业术语（离线演示）。\n【上下文释义】结合上下文，它指代文中对应的方法或对象。\n【相关引申】配置真实模型后可获得完整解释。`,
      };
    }
    return { text: `离线演示模式未调用真实模型。原文片段：${text.slice(0, 120)}` };
  },
};

const real = { streamChat: streamChatReal, completeChat: completeChatReal };

/** 外部传输层（DSH 插件注入），见 ../llm-transport.mjs */
const transport = getLlmTransport();

/**
 * 每次调用时再决定走哪条通道。
 * 不能在模块加载时就定死：用户在首页填了 Key 之后要立刻生效，不需要重启；
 * 插件注入 transport 后同样立即改走宿主模型。
 */
export const llm = {
  streamChat(args) {
    const active = getLlmTransport();
    if (active) return active.streamChat(args);
    return (config.provider === "mock" ? mock : real).streamChat(args);
  },
  completeChat(args) {
    const active = getLlmTransport();
    if (active) return active.completeChat(args);
    return (config.provider === "mock" ? mock : real).completeChat(args);
  },
};
