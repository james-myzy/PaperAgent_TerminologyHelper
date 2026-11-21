/**
 * 智能体主循环：模型 → 工具 → 观察 → 再决策，直到给出最终回答。
 * 原应用是「点按钮走固定流程」，这里是「说一句话，模型自己编排工具」。
 */
import { config } from "../config.mjs";
import { AGENT_SYSTEM } from "./prompts.mjs";
import { llm } from "./llm.mjs";
import { toolDefs, runTool } from "./tools.mjs";

const MAX_TOOL_RESULT_CHARS = 6000;

function safeParseArgs(raw) {
  if (!raw || !String(raw).trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export async function runAgent({ doc, history, emit, signal }) {
  const messages = [{ role: "system", content: AGENT_SYSTEM }, ...history];
  let finalText = "";
  let steps = 0;
  const usedTools = [];

  while (steps < config.maxSteps) {
    steps += 1;
    emit({ type: "step", step: steps, max: config.maxSteps });

    const { text, toolCalls } = await llm.streamChat({
      messages,
      tools: toolDefs,
      ctx: { hasDocument: Boolean(doc), terms: doc?.terms?.length ?? 0 },
      signal,
      onText: (delta) => emit({ type: "delta", text: delta }),
    });

    finalText += text;

    if (!toolCalls.length) break;

    messages.push({
      role: "assistant",
      content: text || null,
      tool_calls: toolCalls.map((c) => ({
        id: c.id,
        type: "function",
        function: { name: c.name, arguments: c.arguments || "{}" },
      })),
    });

    for (const call of toolCalls) {
      const args = safeParseArgs(call.arguments);
      usedTools.push(call.name);
      emit({ type: "tool", id: call.id, name: call.name, args, status: "running" });

      let result;
      try {
        result = await runTool(call.name, args, { doc, emit, signal });
        emit({
          type: "tool_result",
          id: call.id,
          name: call.name,
          ok: true,
          summary: result.summary,
          payload: result.payload ?? null,
        });
        if (result.state) emit({ type: "state", ...result.state, documentId: doc?.id });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        emit({ type: "tool_result", id: call.id, name: call.name, ok: false, summary: message });
        result = { summary: `工具执行失败：${message}` };
      }

      messages.push({
        role: "tool",
        tool_call_id: call.id,
        name: call.name,
        content: String(result.summary).slice(0, MAX_TOOL_RESULT_CHARS),
      });
    }
  }

  // 工具跑完却没有正文：补一次收尾总结，别让用户只看到一堆工具卡片
  if (!finalText.trim()) {
    const { text } = await llm.completeChat({
      messages: [
        ...messages,
        {
          role: "user",
          content: "请基于以上工具结果，用中文给出一段简洁的总结与下一步建议，不要列出原始工具参数。",
        },
      ],
      temperature: 0.3,
      signal,
    });
    finalText = text;
    emit({ type: "delta", text });
  }

  return { text: finalText, steps, usedTools };
}
