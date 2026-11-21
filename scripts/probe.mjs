/**
 * 真实模型对话探针：跑一轮复合指令，看模型怎么编排工具、正文质量如何。
 * 用法：node scripts/_probe.mjs
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const BASE = "http://127.0.0.1:8787";
const here = dirname(fileURLToPath(import.meta.url));

const text = await readFile(join(here, "..", "fixtures", "sample-paper.txt"), "utf8");
const doc = await (
  await fetch(`${BASE}/api/documents`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream", "X-Filename": encodeURIComponent("sample-paper.txt") },
    body: text,
  })
).json();
console.log(`文档：${doc.title}\n`);

const question = "这篇论文的主要贡献是什么？用三点说明，然后解释 BLEU score 在这篇论文里的含义，最后导出高亮 Word。";
console.log(`用户：${question}\n`);
console.log("—— 事件流 ——");

const started = Date.now();
const res = await fetch(`${BASE}/api/chat`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ documentId: doc.id, messages: [{ role: "user", content: question }] }),
});
const reader = res.body.getReader();
const decoder = new TextDecoder();
let buffer = "";
let answer = "";

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  let index = buffer.indexOf("\n\n");
  while (index !== -1) {
    const chunk = buffer.slice(0, index);
    buffer = buffer.slice(index + 2);
    for (const line of chunk.split("\n")) {
      if (!line.startsWith("data:")) continue;
      let event;
      try {
        event = JSON.parse(line.slice(5).trim());
      } catch {
        continue;
      }
      if (event.type === "tool") console.log(`  ▸ 调用 ${event.name} ${JSON.stringify(event.args)}`);
      if (event.type === "tool_result") {
        console.log(`  ◂ ${event.name} ${event.ok ? "ok" : "失败"}：${String(event.summary).split("\n")[0].slice(0, 90)}`);
      }
      if (event.type === "state") {
        const keys = Object.keys(event).filter((k) => ["terms", "details", "translations"].includes(k));
        console.log(`  ◈ 状态更新：${keys.join(", ")}`);
      }
      if (event.type === "delta") answer += event.text;
      if (event.type === "error") console.log(`  ✗ 错误：${event.message}`);
      if (event.type === "done") console.log(`  ✓ 结束，步数 ${event.steps}，工具链 ${event.tools.join(" → ")}`);
    }
    index = buffer.indexOf("\n\n");
  }
}
console.log(`\n—— 模型回答（${((Date.now() - started) / 1000).toFixed(1)}s，${answer.length} 字）——\n${answer}`);
