/**
 * 智能体工具箱：把原应用里写死的按钮功能（解析 / 术语识别 / 解释 / 翻译 / 导出）
 * 全部改成模型可调用的函数。模型自己决定调哪个、按什么顺序调。
 */
import { config } from "../config.mjs";
import { buildHighlightedDocx, exportFilename } from "../lib/exportDocx.mjs";
import { saveExport, patchDocumentState } from "../store.mjs";
import { extractTerms, explainTerm, translatePages, explainInDocument } from "./terms.mjs";

export const toolDefs = [
  {
    type: "function",
    function: {
      name: "document_overview",
      description: "查看当前文档的概览：标题、分段数、字数、语言、已识别术语数，以及开头内容。回答任何文档问题前先调用它。",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "read_document",
      description: "按分段读取文档正文。用于精读某一页/某一段，或核实细节。",
      parameters: {
        type: "object",
        properties: {
          page: { type: "number", description: "分段号（从 1 开始）；不传则从第 1 段开始" },
          length: { type: "number", description: "返回的最大字符数，默认 1500，最大 4000" },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_document",
      description: "在文档中检索关键词，返回命中的原文片段与所在分段号。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "要检索的词或短语" },
          limit: { type: "number", description: "最多返回多少条，默认 5" },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "extract_terms",
      description: "识别文档中的专业术语：词库规则扫描 + 模型语义抽取，结果会写入界面术语面板并用于高亮。用户提到术语、识别、高亮、分析论文时调用。",
      parameters: {
        type: "object",
        properties: {
          max_chunks: { type: "number", description: "最多分析多少个文本块（默认 8，长文档可调大到 16）" },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "explain_term",
      description: "解释某个术语：给出专业定义、上下文释义与相关引申，结果写入术语面板。",
      parameters: {
        type: "object",
        properties: { term: { type: "string", description: "术语原文或中文译名" } },
        required: ["term"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "translate_document",
      description: "把文档翻译成中文并写入译文面板。可只翻某一段，默认翻前 3 段。",
      parameters: {
        type: "object",
        properties: {
          page: { type: "number", description: "只翻译指定分段号；不传则翻译前 3 段" },
          limit: { type: "number", description: "翻译多少个分段，默认 3，最大 6" },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "export_highlighted_docx",
      description: "导出术语黄色高亮的 Word 文档（.docx），返回下载地址。",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "list_terms",
      description: "列出当前已识别的术语（含是否已生成详解）。",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
];

const needDoc = () => {
  const error = new Error("当前还没有打开文档，请先上传论文，或让用户粘贴正文。");
  error.code = "no_document";
  throw error;
};

function snippetAround(text, index, query) {
  const start = Math.max(0, index - 70);
  const end = Math.min(text.length, index + query.length + 90);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ")}${end < text.length ? "…" : ""}`;
}

/** @param {string} name @param {Record<string, any>} args @returns {Promise<{summary: string, payload?: any, state?: any}>} */
export async function runTool(name, args, ctx) {
  const { doc, emit, signal } = ctx;
  const state = {};

  switch (name) {
    case "document_overview": {
      if (!doc) needDoc();
      const head = doc.pages[0]?.text.slice(0, 260).replace(/\s+/g, " ") ?? "";
      const summary = [
        `标题：${doc.title}`,
        `分段：${doc.pages.length} 段 / 约 ${doc.charCount} 字 / 语言：${doc.language === "en" ? "英文" : doc.language === "zh" ? "中文" : "未知"}`,
        `已识别术语：${doc.terms.length} 个`,
        `开头内容：${head}`,
      ].join("\n");
      return { summary, payload: { pageCount: doc.pages.length, charCount: doc.charCount, terms: doc.terms.length } };
    }

    case "read_document": {
      if (!doc) needDoc();
      const page = Number(args.page) || 1;
      const length = Math.min(4000, Number(args.length) || 1500);
      const target = doc.pages.find((p) => p.page === page) ?? doc.pages[0];
      const text = target.text.slice(0, length);
      return {
        summary: `第 ${target.page} 段（共 ${doc.pages.length} 段，${target.text.length} 字）${target.text.length > length ? "，已截断" : ""}：\n${text}`,
        payload: { page: target.page, total: doc.pages.length },
      };
    }

    case "search_document": {
      if (!doc) needDoc();
      const query = String(args.query ?? "").trim();
      if (!query) return { summary: "检索词为空。" };
      const limit = Math.min(10, Number(args.limit) || 5);
      const hits = [];
      for (const page of doc.pages) {
        const lower = page.text.toLowerCase();
        let index = lower.indexOf(query.toLowerCase());
        while (index !== -1 && hits.length < limit) {
          hits.push({ page: page.page, snippet: snippetAround(page.text, index, query) });
          index = lower.indexOf(query.toLowerCase(), index + query.length);
        }
        if (hits.length >= limit) break;
      }
      if (!hits.length) {
        return { summary: `文中未直接出现「${query}」。`, payload: { hits: [] } };
      }
      const summary = `「${query}」命中 ${hits.length} 处：\n${hits
        .map((h) => `- 第 ${h.page} 段：${h.snippet}`)
        .join("\n")}`;
      return { summary, payload: { hits } };
    }

    case "extract_terms": {
      if (!doc) needDoc();
      const maxChunks = Math.min(16, Number(args.max_chunks) || config.termMaxChunks);
      const result = await extractTerms(doc, { signal, maxChunks });
      const merged = new Map(doc.terms.map((t) => [t.name.toLowerCase(), t]));
      for (const term of result.terms) merged.set(term.name.toLowerCase(), term);
      const terms = Array.from(merged.values());
      patchDocumentState(doc.id, { terms });
      state.terms = terms;
      const listed = terms
        .slice(0, 40)
        .map((t) => (t.zhName ? `${t.name}（${t.zhName}）` : t.name))
        .join("、");
      return {
        summary: `共识别 ${terms.length} 个术语（词库命中 ${result.glossaryHits} 个，语义抽取 ${result.aiLists} 批）。${listed}${terms.length > 40 ? " 等" : ""}`,
        payload: { count: terms.length, glossaryHits: result.glossaryHits },
        state,
      };
    }

    case "list_terms": {
      if (!doc) needDoc();
      if (!doc.terms.length) return { summary: "当前还没有识别术语，先运行 extract_terms。" };
      const summary = doc.terms
        .map((t) => `- ${t.name}${t.zhName ? `（${t.zhName}）` : ""}：${t.brief}`)
        .join("\n");
      return { summary, payload: { count: doc.terms.length } };
    }

    case "explain_term": {
      if (!doc) needDoc();
      const termName = String(args.term ?? "").trim();
      if (!termName) return { summary: "缺少术语名称。" };
      const { text, page } = await explainTerm(doc, termName, { signal });
      // 面板按术语 id 存详解；没匹配到就退回名字，避免详解丢失
      const matched = doc.terms.find(
        (t) => t.name.toLowerCase() === termName.toLowerCase() || t.zhName === termName,
      );
      const key = matched?.id ?? termName;
      patchDocumentState(doc.id, { details: { [key]: text } });
      state.details = { [key]: text };
      return { summary: `术语「${termName}」详解已生成${page ? `（首次出现在第 ${page} 段）` : ""}：\n${text}`, payload: { term: termName, page }, state };
    }

    case "translate_document": {
      if (!doc) needDoc();
      const limit = Math.min(6, Number(args.limit) || 3);
      const pages = args.page
        ? doc.pages.filter((p) => p.page === Number(args.page))
        : doc.pages.slice(0, limit);
      if (!pages.length) return { summary: "没有可翻译的分段。" };
      const translations = await translatePages(doc, pages, { signal });
      patchDocumentState(doc.id, { translations });
      state.translations = translations;
      const preview = Object.entries(translations)
        .map(([page, text]) => `第 ${page} 段：${text.slice(0, 120)}…`)
        .join("\n");
      return { summary: `已翻译 ${pages.length} 段并写入译文面板。\n${preview}`, payload: { pages: pages.map((p) => p.page) }, state };
    }

    case "export_highlighted_docx": {
      if (!doc) needDoc();
      const buffer = await buildHighlightedDocx(doc);
      const saved = saveExport(buffer, exportFilename(doc.title));
      return {
        summary: `已生成术语高亮 Word：${saved.filename}（${doc.terms.length} 个术语已标注），右侧面板可直接下载。`,
        payload: { ...saved, terms: doc.terms.length },
      };
    }

    default:
      return { summary: `未知工具：${name}` };
  }
}

export { explainInDocument };
