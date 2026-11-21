/**
 * 把 paper-agent 的「OpenAI 风格」模型调用桥接到 DSH 的 ctx.llm。
 *
 * 好处：插件不需要用户再填 API Key，直接用 Harness 里已经配好的模型；
 * 换模型只改 cordis.patch.yml 里的 provider / model。
 */
const uid = () => globalThis.crypto.randomUUID();

/**
 * OpenAI 风格消息 → DSH 消息。
 * DSH 的 assistant / tool 消息是有身份的结构化消息，这里按它的形状构造：
 *   assistant: { id, role, content: [text?, tool-call...], source: { kind: 'model' } }
 *   tool:      { id, role: 'tool', toolCallId, content: [text], source: { kind: 'tool', callId } }
 */
function toDshMessages(messages) {
  const systems = [];
  const conversation = [];

  for (const message of messages) {
    const role = message?.role;
    if (role === "system") {
      const text = String(message.content ?? "").trim();
      if (text) systems.push(text);
      continue;
    }

    if (role === "user") {
      conversation.push({
        id: uid(),
        role: "user",
        content: [{ type: "text", text: String(message.content ?? "") }],
        source: { kind: "user" },
      });
      continue;
    }

    if (role === "assistant") {
      const content = [];
      const text = String(message.content ?? "");
      if (text) content.push({ type: "text", text });
      for (const call of message.tool_calls ?? []) {
        content.push({
          type: "tool-call",
          id: String(call.id ?? `call_${content.length}`),
          name: String(call.function?.name ?? ""),
          arguments: String(call.function?.arguments ?? "{}"),
        });
      }
      if (!content.length) content.push({ type: "text", text: "" });
      conversation.push({
        id: uid(),
        role: "assistant",
        content,
        source: { kind: "model" },
      });
      continue;
    }

    if (role === "tool") {
      const callId = String(message.tool_call_id ?? "");
      conversation.push({
        id: uid(),
        role: "tool",
        toolCallId: callId,
        content: [{ type: "text", text: String(message.content ?? "") }],
        source: { kind: "tool", callId },
      });
    }
  }

  return { system: systems.join("\n\n"), conversation };
}

/** OpenAI 的 tools 声明 → DSH 的 ToolSchema[] */
function toDshTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  return tools
    .map((tool) => {
      const fn = tool?.function ?? tool;
      if (!fn?.name) return null;
      return {
        name: String(fn.name),
        description: String(fn.description ?? ""),
        parameters: fn.parameters ?? { type: "object", properties: {} },
      };
    })
    .filter(Boolean);
}

/**
 * @param {object} ctx - cordis 上下文（需要 llm 服务）
 * @param {{ provider?: string, model?: string, maxTokens?: number }} options
 */
export function createDshTransport(ctx, options = {}) {
  const provider = options.provider ?? "deepseek-official";
  const model = options.model ?? "deepseek-flash";
  const defaultMaxTokens = options.maxTokens ?? 4096;

  const resolveLlm = () => ctx.get?.("llm") ?? ctx.llm;

  async function streamChat({ messages, tools, signal, onText, maxTokens } = {}) {
    const llm = resolveLlm();
    if (!llm || typeof llm.stream !== "function") {
      throw new Error("当前 DSH 组合没有可用的 llm 服务，无法调用模型");
    }

    const { system, conversation } = toDshMessages(messages ?? []);
    const calls = new Map();
    let text = "";
    let finishReason = "stop";

    for await (const chunk of llm.stream({
      provider,
      model,
      system: system || undefined,
      messages: conversation,
      tools: toDshTools(tools),
      maxTokens: maxTokens ?? defaultMaxTokens,
      signal,
    })) {
      if (chunk.type === "text-delta") {
        text += chunk.text;
        onText?.(chunk.text);
      } else if (chunk.type === "tool-call-delta") {
        const slot = calls.get(chunk.index) ?? { id: chunk.id, name: "", arguments: "" };
        if (chunk.id) slot.id = chunk.id;
        if (chunk.name) slot.name += chunk.name;
        if (chunk.argumentsDelta) slot.arguments += chunk.argumentsDelta;
        calls.set(chunk.index, slot);
      } else if (chunk.type === "finish") {
        finishReason = chunk.reason?.kind ?? "stop";
      }
    }

    const toolCalls = [...calls.values()]
      .filter((call) => call.name)
      .map((call, index) => ({
        id: call.id ?? `call_${index}`,
        name: call.name,
        arguments: call.arguments || "{}",
      }));

    return {
      text,
      toolCalls,
      finishReason: toolCalls.length > 0 ? "tool_calls" : finishReason,
    };
  }

  async function completeChat({ messages, signal, maxTokens, onText } = {}) {
    const result = await streamChat({ messages, signal, maxTokens, onText });
    return { text: result.text };
  }

  return { streamChat, completeChat, provider, model };
}
