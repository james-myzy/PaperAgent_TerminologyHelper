/**
 * 最小移植示例：不启动 HTTP 服务、不带前端，直接在自己的脚本里跑智能体。
 *
 * 运行：node examples/embed-agent.mjs
 * 依赖：项目根目录的 .env（LLM_API_KEY 等），或直接设环境变量
 *
 * 这个文件只 import 了三个模块：
 *   server/agent/loop.mjs   —— 工具循环
 *   server/agent/tools.mjs  —— 工具定义（如需自定义工具，改它）
 *   server/parse.mjs        —— 可选：把 PDF/DOCX 解析成 pages
 */
import { runAgent } from "../server/agent/loop.mjs";
import { parseDocument } from "../server/parse.mjs";
import { readFile } from "node:fs/promises";

/* ---------------- 1. 准备文档对象（智能体只依赖这个结构） ---------------- */

let doc;

if (process.argv[2]) {
  // 传了文件路径：走真实解析
  const buf = await readFile(process.argv[2]);
  const parsed = await parseDocument(buf, process.argv[2].split(/[\\/]/).pop());
  doc = { id: "embed-demo", terms: [], details: {}, translations: {}, ...parsed };
} else {
  // 没传就用内置样例，方便一条命令跑通
  const pageText =
    "The Transformer replaces recurrence with self-attention. " +
    "Scaled dot-product attention computes similarity between queries and keys, " +
    "and multi-head attention lets the model attend to several subspaces at once. " +
    "The model is trained with the Adam optimizer and a warm-up learning rate schedule.";
  doc = {
    id: "embed-demo",
    title: "内置样例：注意力机制",
    kind: "txt",
    filename: "demo.txt",
    language: "en",
    charCount: pageText.length,
    pages: [{ page: 1, text: pageText, blocks: [{ type: "p", text: pageText }] }],
    terms: [],
    details: {},
    translations: {},
  };
}

/* ---------------- 2. 跑一轮对话，事件自己处理 ---------------- */

const history = [{ role: "user", content: "这篇文档讲了什么？用两句话概括，并把专业术语识别出来。" }];

let buffer = "";
const emit = (event) => {
  switch (event.type) {
    case "delta":
      buffer += event.text;
      process.stdout.write(event.text);
      break;
    case "tool":
      console.log(`\n  [调用工具] ${event.name} ${JSON.stringify(event.args)}`);
      break;
    case "tool_result":
      console.log(`  [工具返回] ${event.ok ? "ok" : "失败"}：${String(event.summary).slice(0, 90)}…`);
      break;
    case "state":
      if (event.terms) console.log(`  [状态] 术语 ${event.terms.length} 个已写回文档对象`);
      break;
    case "error":
      console.error(`\n  [错误] ${event.message}`);
      break;
    default:
      break;
  }
};

const result = await runAgent({ doc, history, emit });

console.log(`\n\n—— 完成：${result.steps} 步，工具链 ${result.usedTools.join(" → ") || "(无)"} ——`);
console.log(`文档对象里的术语数：${doc.terms.length}`);
