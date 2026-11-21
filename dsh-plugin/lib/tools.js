/**
 * 注册给 Harness 智能体的工具。
 *
 * 这些工具直接操作「术语透视」的文档状态：和阅读页看到的是同一份数据，
 * 所以对话里解释过的术语，页面上再点开就是缓存结果。
 */
import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";

const textOutput = {
  schema: { type: "string" },
  render: (_args, value) => [{ type: "text", text: String(value) }],
};

function summarizeDoc(doc) {
  return `${doc.title}（${doc.pages.length} 页 / 约 ${doc.charCount} 字 / 术语 ${doc.terms.length} 个 / id ${doc.id}）`;
}

/**
 * @param {object} options
 * @param {string} options.basePath - 页面挂载路径，如 /paper-agent
 * @param {{store: object, parse: object, terms: object, loop: object}} options.modules
 * @param {number} options.maxImportChunks - 导入时最多抽取多少块术语
 */
export function createPaperTools({ basePath, modules, maxImportChunks = 3, maxSteps = 6 }) {
  const { store, parse, terms, loop } = modules;

  const latest = () => {
    const list = store.listDocuments();
    return list.length ? store.getDocument(list[0].id) : null;
  };
  const pick = (id) => {
    if (id) {
      const doc = store.getDocument(String(id));
      if (!doc) throw new Error(`找不到文档 ${id}，先用 paper_list 看看有哪些`);
      return doc;
    }
    const doc = latest();
    if (!doc) throw new Error("还没有导入任何论文：用 paper_import 导入一个本地文件，或在阅读页上传");
    return doc;
  };

  return [
    {
      name: "paper_list",
      description:
        "列出「术语透视」里已经导入的论文（标题、页数、字数、已识别术语数）。想引用具体文档时先用这个工具拿 id。",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "integer", description: "最多列几篇，默认 10" },
        },
        additionalProperties: false,
      },
      output: textOutput,
      async execute(args) {
        const limit = Math.max(1, Math.min(50, Number(args?.limit ?? 10)));
        const docs = store.listDocuments().slice(0, limit);
        if (!docs.length) return "还没有导入任何论文。用 paper_import 导入本地文件，或在侧边栏「术语透视」里上传。";
        const lines = [`共 ${store.listDocuments().length} 篇，最近 ${docs.length} 篇：`];
        for (const doc of docs) {
          const full = store.getDocument(doc.id);
          lines.push(`- ${summarizeDoc(full)}`);
        }
        lines.push("", `阅读页：${basePath}/`);
        return lines.join("\n");
      },
    },
    {
      name: "paper_open",
      description:
        "给出「术语透视」阅读页的地址（可带文档 id），用户点击即可在 Harness 里看到带高亮的原文。需要让用户亲眼看时用它。",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "文档 id；不填则打开最近一篇" },
        },
        additionalProperties: false,
      },
      output: textOutput,
      async execute(args) {
        const doc = pick(args?.id);
        return [
          `阅读页：${basePath}/?doc=${doc.id}`,
          `也可以点 Harness 左侧的「术语透视」入口。`,
          `当前文档：${summarizeDoc(doc)}`,
        ].join("\n");
      },
    },
    {
      name: "paper_terms",
      description:
        "列出某篇论文已经识别出的专业术语（英文名、中文名、一句话解释、出现页）。解释某个术语前先用它确认叫法。",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "文档 id；不填则用最近一篇" },
          limit: { type: "integer", description: "最多列几条，默认 30" },
          query: { type: "string", description: "可选：按名字过滤（不区分大小写）" },
        },
        additionalProperties: false,
      },
      output: textOutput,
      async execute(args) {
        const doc = pick(args?.id);
        const limit = Math.max(1, Math.min(200, Number(args?.limit ?? 30)));
        const query = String(args?.query ?? "").trim().toLowerCase();
        let list = doc.terms;
        if (query) {
          list = list.filter(
            (term) =>
              term.name.toLowerCase().includes(query) || String(term.zhName ?? "").includes(query),
          );
        }
        if (!list.length) {
          return query
            ? `没有匹配「${query}」的术语（当前共 ${doc.terms.length} 个）`
            : `这篇论文还没有识别出术语，可以调用 paper_analyze 识别一次`;
        }
        const lines = [`${doc.title}：共 ${doc.terms.length} 个术语，列出 ${Math.min(limit, list.length)} 个：`];
        for (const term of list.slice(0, limit)) {
          const zh = term.zhName ? `（${term.zhName}）` : "";
          const pages = term.pages?.length ? ` 第 ${term.pages.slice(0, 3).join("、")} 页` : "";
          lines.push(`- ${term.name}${zh}：${term.brief}${pages}`);
        }
        return lines.join("\n");
      },
    },
    {
      name: "paper_explain",
      description:
        "解释论文里的一个术语：给出「专业定义 / 上下文释义 / 相关引申」，贴合这篇论文的语境。解释过一次就缓存，重复调用不再花钱。",
      parameters: {
        type: "object",
        properties: {
          term: { type: "string", description: "术语原文（英文或缩写）" },
          id: { type: "string", description: "文档 id；不填则用最近一篇" },
        },
        required: ["term"],
        additionalProperties: false,
      },
      output: textOutput,
      async execute(args) {
        const term = String(args?.term ?? "").trim();
        if (!term) throw new Error("term 不能为空");
        const doc = pick(args?.id);
        const matched = doc.terms.find(
          (item) => item.name.toLowerCase() === term.toLowerCase() || item.zhName === term,
        );
        const key = matched?.id ?? term;
        const cached = doc.details?.[key];
        if (cached?.trim()) return cached;

        const { text } = await terms.explainTerm(doc, term, {
          signal: AbortSignal.timeout(120_000),
        });
        if (text?.trim()) store.patchDocumentState(doc.id, { details: { [key]: text } });
        return text;
      },
    },
    {
      name: "paper_analyze",
      description:
        "对某篇论文重新识别术语（词库扫描 + 模型抽取），结果会写回阅读页的高亮。用户说「重新识别一下术语」时用它。",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "文档 id；不填则用最近一篇" },
          max_chunks: { type: "integer", description: "最多抽取几块文本，默认 3；越大越全也越慢" },
        },
        additionalProperties: false,
      },
      output: textOutput,
      async execute(args) {
        const doc = pick(args?.id);
        const maxChunks = Math.max(1, Math.min(8, Number(args?.max_chunks ?? maxImportChunks)));
        const result = await terms.extractTerms(doc, {
          maxChunks,
          signal: AbortSignal.timeout(180_000),
        });
        store.patchDocumentState(doc.id, { terms: result.terms });
        const sample = result.terms.slice(0, 5).map((term) => term.name).join("、");
        return `识别完成：${doc.title} 共 ${result.terms.length} 个术语${sample ? `，例如 ${sample}` : ""}`;
      },
    },
    {
      name: "paper_ask",
      description:
        "就当前论文提问，由 Harness 智能体调用精读 / 检索 / 术语等工具回答。适合「这篇论文的方法有什么局限」这类需要读全文的问题。",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", description: "要问的问题" },
          id: { type: "string", description: "文档 id；不填则用最近一篇" },
        },
        required: ["question"],
        additionalProperties: false,
      },
      output: textOutput,
      async execute(args) {
        const question = String(args?.question ?? "").trim();
        if (!question) throw new Error("question 不能为空");
        const doc = pick(args?.id);
        let answer = "";
        const used = [];
        await loop.runAgent({
          doc,
          history: [{ role: "user", content: question }],
          emit: (event) => {
            if (event.type === "delta") answer += event.text ?? "";
            if (event.type === "tool" && event.name) used.push(event.name);
          },
          signal: AbortSignal.timeout(Math.max(120_000, maxSteps * 45_000)),
        });
        const tools = used.length ? `\n\n（用到的工具：${[...new Set(used)].join("、")}）` : "";
        return (answer.trim() || "模型没有返回内容，请换个问法试试。") + tools;
      },
    },
    {
      name: "paper_import",
      description:
        "从本机路径导入一篇论文到「术语透视」（支持 PDF / DOCX / TXT / MD），导入后立即识别术语。用户说「分析这个文件」并给出路径时用它。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "文件的绝对路径" },
          analyze: { type: "boolean", description: "是否立刻识别术语，默认 true" },
        },
        required: ["path"],
        additionalProperties: false,
      },
      output: textOutput,
      async execute(args) {
        const path = String(args?.path ?? "").trim();
        if (!path) throw new Error("path 不能为空");
        let buffer;
        try {
          buffer = readFileSync(path);
        } catch (error) {
          throw new Error(`读不到文件 ${path}：${error instanceof Error ? error.message : String(error)}`);
        }
        const filename = basename(path);
        const parsed = await parse.parseDocument(buffer, filename);
        const doc = store.createDocument(parsed);
        const ext = extname(filename).toLowerCase();
        doc.file = store.saveDocumentFile(doc.id, buffer, ext);
        store.persistDocument(doc);

        let summary = `已导入：${summarizeDoc(doc)}`;
        if (args?.analyze !== false) {
          const result = await terms.extractTerms(doc, {
            maxChunks: maxImportChunks,
            signal: AbortSignal.timeout(180_000),
          });
          store.patchDocumentState(doc.id, { terms: result.terms });
          summary += `\n术语识别：${result.terms.length} 个`;
        }
        summary += `\n阅读页：${basePath}/?doc=${doc.id}`;
        return summary;
      },
    },
  ];
}
