/**
 * 端到端自检：上传文档 → 跑一轮智能体对话 → 校验 SSE 事件与导出文件。
 * 用法：先 npm start（另开一个窗口），再 node scripts/smoke.mjs
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const BASE = process.env.SMOKE_BASE ?? "http://127.0.0.1:8787";
const here = dirname(fileURLToPath(import.meta.url));

function assert(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`);
}

async function health() {
  const res = await fetch(`${BASE}/api/health`);
  const json = await res.json();
  console.log(`[1/5] 健康检查 ok，provider=${json.provider} model=${json.model} hasKey=${json.hasKey}`);
  assert(json.ok === true, "health.ok");
  return json;
}

async function upload() {
  const text = await readFile(join(here, "..", "fixtures", "sample-paper.txt"), "utf8");
  const res = await fetch(`${BASE}/api/documents`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream", "X-Filename": encodeURIComponent("sample-paper.txt") },
    body: text,
  });
  const doc = await res.json();
  assert(res.ok, `上传文档：${JSON.stringify(doc)}`);
  console.log(`[2/5] 文档解析 ok：${doc.title} / ${doc.pages.length} 段 / ${doc.charCount} 字 / ${doc.language}`);
  return doc;
}

async function chat(doc, content) {
  const res = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ documentId: doc.id, messages: [{ role: "user", content }] }),
  });
  assert(res.ok, `chat 状态 ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index = buffer.indexOf("\n\n");
    while (index !== -1) {
      const chunk = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      for (const line of chunk.split("\n")) {
        if (line.startsWith("data:")) {
          try {
            events.push(JSON.parse(line.slice(5).trim()));
          } catch {
            /* ignore */
          }
        }
      }
      index = buffer.indexOf("\n\n");
    }
  }
  return events;
}

const config = await health();
const doc = await upload();

// 轮次一：概览 + 术语识别
const first = await chat(doc, "这份文档讲什么？先把专业术语识别出来。");
const firstTypes = new Set(first.map((e) => e.type));
assert(firstTypes.has("delta") || firstTypes.has("done"), "第一轮应有正文或结束事件");
const firstTools = first.filter((e) => e.type === "tool").map((e) => e.name);
console.log(`[3/5] 第一轮事件 ${first.length} 条，工具：${firstTools.join(" → ") || "（无）"}`);
assert(!first.some((e) => e.type === "error"), `第一轮不应报错：${JSON.stringify(first.find((e) => e.type === "error"))}`);

// 术语是否写进文档状态
const stateEvents = first.filter((e) => e.type === "state");
const termState = stateEvents.find((e) => e.terms);
if (termState) {
  console.log(`      识别到术语 ${termState.terms.length} 个，例如：${termState.terms.slice(0, 5).map((t) => t.name).join("、")}`);
  assert(termState.terms.length > 0, "术语数量应大于 0");
}

// 轮次二：导出高亮 Word
const second = await chat(doc, "导出术语高亮的 Word 文档");
const exportResult = second.find((e) => e.type === "tool_result" && e.payload?.url);
assert(exportResult, `应返回导出文件：${JSON.stringify(second.filter((e) => e.type === "tool_result"))}`);
console.log(`[4/5] 导出 ok：${exportResult.payload.filename}`);

const fileRes = await fetch(`${BASE}${exportResult.payload.url}`);
const bytes = new Uint8Array(await fileRes.arrayBuffer());
assert(fileRes.ok && bytes.length > 1000, "导出文件应可下载且非空");
const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
assert(isZip, "docx 应是 zip 容器");
console.log(`[5/5] 下载校验 ok：${(bytes.length / 1024).toFixed(1)} KB，docx 头正确`);

console.log("\n全部通过 ✅");
