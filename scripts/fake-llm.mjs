/**
 * 假的 OpenAI 兼容服务，用来验证「真实模型通道」的代码路径：
 * 流式 SSE 解析、tool_calls 增量拼装、多轮工具循环、非流式补全。
 * 只在本地自检时使用，不参与生产。
 *
 * 启动：node scripts/fake-llm.mjs
 * 用法：LLM_PROVIDER=deepseek LLM_BASE_URL=http://127.0.0.1:8899/v1 LLM_API_KEY=test npm start
 */
import { createServer } from "node:http";

const PORT = Number(process.env.FAKE_LLM_PORT ?? 8899);

function sse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function chunk(delta, finish = null) {
  return { choices: [{ index: 0, delta, finish_reason: finish }] };
}

function lastUser(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === "user") return String(messages[i].content ?? "");
  }
  return "";
}

function pickTool(text) {
  if (/导出|下载|word/i.test(text)) return "export_highlighted_docx";
  if (/翻译/.test(text)) return "translate_document";
  if (/术语|识别/.test(text)) return "extract_terms";
  return "document_overview";
}

const server = createServer((req, res) => {
  if (!req.url?.endsWith("/chat/completions")) {
    res.writeHead(404).end("not found");
    return;
  }
  let raw = "";
  req.on("data", (c) => {
    raw += c;
  });
  req.on("end", async () => {
    let body = {};
    try {
      body = JSON.parse(raw);
    } catch {
      res.writeHead(400).end("bad json");
      return;
    }
    const messages = body.messages ?? [];
    const last = messages[messages.length - 1] ?? {};
    const hasToolResult = messages.some((m) => m.role === "tool");

    // 非流式：术语抽取 / 术语详解等内部调用
    if (!body.stream) {
      const prompt = lastUser(messages);
      let content;
      if (/术语：/.test(prompt)) {
        content =
          "【专业定义】该术语指模型中对序列位置进行加权聚合的机制。\n【上下文释义】在本文语境下，它承担跨位置信息交互的核心作用。\n【相关引申】与卷积、循环结构相比，它的路径长度更短。";
      } else if (/提取|术语|JSON 数组/.test(prompt) || messages.some((m) => String(m.content).includes("穷尽式提取"))) {
        content = JSON.stringify([
          { name: "sparse attention", zhName: "稀疏注意力", brief: "只对部分位置计算注意力以降低复杂度。" },
          { name: "retrieval-augmented generation", zhName: "检索增强生成", brief: "先检索外部资料再生成回答的范式。" },
        ]);
      } else {
        content = "这是假模型返回的译文：论文讨论了 Transformer 架构与自注意力机制。";
      }
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }));
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    if (!hasToolResult) {
      // 第一跳：返回一个工具调用，验证 tool_calls 增量拼装
      const name = pickTool(lastUser(messages));
      const id = `call_fake_${Date.now()}`;
      sse(res, chunk({ role: "assistant", content: "" }));
      // 故意把工具名和参数拆成两段，模拟真实服务端的分片行为
      sse(res, chunk({ tool_calls: [{ index: 0, id, type: "function", function: { name: name.slice(0, 6), arguments: "" } }] }));
      sse(res, chunk({ tool_calls: [{ index: 0, function: { name: name.slice(6), arguments: '{"query":"' } }] }));
      sse(res, chunk({ tool_calls: [{ index: 0, function: { arguments: 'attention"}' } }] }));
      sse(res, chunk({}, "tool_calls"));
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    // 第二跳：基于工具结果给最终回答
    const toolMsg = [...messages].reverse().find((m) => m.role === "tool");
    const summary = String(toolMsg?.content ?? "").slice(0, 160);
    const answer = `根据工具 ${toolMsg?.name ?? ""} 的结果：\n${summary}\n\n这段结论来自原文，可以继续点开术语看详解。`;
    for (const piece of answer.match(/[\s\S]{1,14}/g) ?? []) {
      sse(res, chunk({ content: piece }));
      await new Promise((r) => setTimeout(r, 8));
    }
    sse(res, chunk({}, "stop"));
    res.write("data: [DONE]\n\n");
    res.end();
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`fake-llm listening on http://127.0.0.1:${PORT}/v1`);
});
