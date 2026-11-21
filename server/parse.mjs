/**
 * 文档解析：PDF / DOCX / TXT / MD → { title, pages: [{ page, blocks, text }] }
 *
 * 阅读器要“保留论文完整形式”，所以这里不只给纯文本，还做一层轻量的块结构识别：
 * 标题、小节标题、段落。版式（双栏、字体、图表）无法从文字层还原，但分段与层级要尽量留住。
 */
import { extname, basename } from "node:path";

const PAGE_CHARS = 2600;

function normalizeText(text) {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const SECTION_WORDS =
  /^(abstract|introduction|related work|background|preliminar\w*|method\w*|approach|model|experiment\w*|evaluation|results?|discussion|conclusion\w*|references|acknowledg\w*|appendix|摘要|引言|绪论|相关工作|方法|实验|结果|讨论|结论|参考文献|致谢|附录)\b/i;

/** 判断一行是不是小节标题 */
function isHeading(line) {
  const text = line.trim();
  if (!text) return false;
  if (text.length > 90) return false;
  // 以句末标点结尾的更像正文
  const endsLikeSentence = /[。.!?；;:]$/.test(text);
  // 1. Introduction / 2.3 Method / III. Results
  if (/^(\d+(\.\d+)*|[IVX]+)[.、)]\s+\S/.test(text) && !endsLikeSentence && text.split(/\s+/).length <= 10) {
    return true;
  }
  if (SECTION_WORDS.test(text) && text.split(/\s+/).length <= 8 && !endsLikeSentence) return true;
  // 全大写短行（英文论文常见）
  if (text.length <= 60 && /^[A-Z][A-Z0-9\s&:：''\-—–]+$/.test(text) && text.split(/\s+/).length <= 8) return true;
  return false;
}

/** 把一段页文本拆成「标题 / 段落」块 */
function toBlocks(text) {
  const lines = text.split("\n");
  const blocks = [];
  let buffer = [];
  let prev = "";

  const flush = () => {
    const paragraph = buffer.join(" ").replace(/\s+/g, " ").trim();
    buffer = [];
    if (!paragraph) return;
    blocks.push({ type: "p", text: paragraph });
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      flush();
      prev = "";
      continue;
    }
    if (isHeading(line)) {
      flush();
      blocks.push({ type: "h", text: line.replace(/\s+/g, " ") });
      prev = line;
      continue;
    }
    // PDF 的一行只是排版折行，没有空行；用「上一行很短且以句末标点结尾」判断段尾
    const prevEndsParagraph = /[.!?。！？…”"')\]]$/.test(prev) && prev.length < 62;
    const startsNewItem = buffer.length > 0 && /^([•·*]|\(?\d+[.)])\s+/.test(line);
    if (startsNewItem || (prevEndsParagraph && /^[A-Z0-9\u4e00-\u9fa5（(]/.test(line))) {
      flush();
    }
    buffer.push(line);
    prev = line;
  }
  flush();
  return blocks;
}

/** docx / txt：没有真实“页”，按字符量切成伪页 */
function paragraphsToPages(paragraphs) {
  const pages = [];
  let buffer = [];
  let length = 0;
  const flush = () => {
    if (!buffer.length) return;
    // 用空行分隔，保住 docx / txt 原有的段落边界
    const text = normalizeText(buffer.join("\n\n"));
    if (text) pages.push({ page: pages.length + 1, text, blocks: toBlocks(text) });
    buffer = [];
    length = 0;
  };
  for (const p of paragraphs) {
    const text = p.trim();
    if (!text) continue;
    buffer.push(text);
    length += text.length;
    if (length >= PAGE_CHARS) flush();
  }
  flush();
  return pages;
}

async function parsePdf(buffer) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: false,
    isEvalSupported: false,
    useWorkerFetch: false,
    verbosity: 0,
  });
  const pdf = await task.promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i += 1) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    let text = "";
    for (const item of content.items) {
      if (typeof item.str !== "string") continue;
      text += item.str;
      text += item.hasEOL ? "\n" : "";
    }
    const cleaned = normalizeText(text);
    if (cleaned) {
      pages.push({ page: i, text: cleaned, blocks: toBlocks(cleaned) });
    }
    page.cleanup();
  }
  let title = "";
  try {
    const meta = await pdf.getMetadata();
    title = String(meta?.info?.Title ?? "").trim();
  } catch {
    /* 元数据缺失不影响正文 */
  }
  const pageCount = pdf.numPages;
  await pdf.destroy();
  return { pages, title, pageCount };
}

async function parseDocx(buffer) {
  const mammoth = await import("mammoth");
  const { value } = await mammoth.extractRawText({ buffer });
  const paragraphs = String(value || "").split(/\n{2,}|\n/);
  return { pages: paragraphsToPages(paragraphs), title: "" };
}

function parsePlain(buffer) {
  const text = buffer.toString("utf8");
  const paragraphs = text.split(/\n{2,}/);
  return { pages: paragraphsToPages(paragraphs), title: "" };
}

const LEGAL_NOISE =
  /permission|attribution|hereby|copyright|licen[cs]e|all rights reserved|doi\.org|arxiv:\s*\d|provided proper|reproduce the tables/i;

/** 像不像论文标题：多词、Title Case 或全大写、不以连接标点结尾 */
function looksLikeTitle(line) {
  if (line.length < 8 || line.length > 120) return false;
  if (SECTION_WORDS.test(line)) return false;
  if (LEGAL_NOISE.test(line)) return false;
  if (/[;,]$/.test(line)) return false;
  if (line.includes("@")) return false;
  if (/^(abstract|摘要|introduction|引言)\b/i.test(line)) return false;

  const words = line.split(/\s+/).filter(Boolean);
  if (words.length < 2) return false;

  const capitalized = words.filter((word) => /^[A-Z0-9(“"(]/.test(word)).length;
  const letters = line.replace(/[^A-Za-z]/g, "");
  const uppercase = letters.replace(/[^A-Z]/g, "").length;
  const ratio = capitalized / words.length;
  // Title Case（多数词首字母大写）或全大写，且不是整行数字/符号
  return letters.length > 6 && (ratio >= 0.6 || uppercase / letters.length > 0.85);
}

function guessTitle(pages, filename) {
  const lines =
    pages[0]?.text
      ?.split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 14) ?? [];

  // 1) 优先在前十几行里找真正像标题的一行（跳过版权声明、作者机构、arXiv 水印）
  const candidate = lines.find((line) => looksLikeTitle(line));
  if (candidate) return candidate;

  // 2) 退回老规则：首行足够长且不是章节名
  const firstLine = lines[0] ?? "";
  if (firstLine && firstLine.length >= 8 && firstLine.length <= 120 && !SECTION_WORDS.test(firstLine)) {
    return firstLine;
  }
  const fromName = basename(filename, extname(filename)).replace(/[_-]+/g, " ").trim();
  return fromName || "未命名文档";
}

/** 标题已经在页面顶部单独渲染，把正文里重复的第一块去掉 */
function stripTitle(pages, title) {
  const first = pages[0];
  if (!first?.blocks?.length || !title) return;
  const block = first.blocks[0];
  if (!block.text.toLowerCase().startsWith(title.toLowerCase())) return;
  const rest = block.text
    .slice(title.length)
    .replace(/^[\s.。:：—–-]+/, "")
    .trim();
  if (rest) first.blocks[0] = { ...block, text: rest };
  else first.blocks.shift();
}

function detectLanguage(pages) {
  const sample = pages.slice(0, 3).map((p) => p.text).join("").slice(0, 4000);
  const cjk = (sample.match(/[\u4e00-\u9fa5]/g) || []).length;
  const latin = (sample.match(/[A-Za-z]/g) || []).length;
  if (cjk === 0 && latin === 0) return "unknown";
  return cjk > latin ? "zh" : "en";
}

export async function parseDocument(buffer, filename) {
  const ext = extname(filename).toLowerCase();
  let parsed;
  if (ext === ".pdf") {
    parsed = await parsePdf(buffer);
  } else if (ext === ".docx") {
    parsed = await parseDocx(buffer);
  } else if (ext === ".txt" || ext === ".md" || ext === ".markdown") {
    parsed = parsePlain(buffer);
  } else if (ext === ".doc") {
    throw new Error("不支持旧版 .doc 格式，请先用 Word 另存为 .docx 后重试。");
  } else {
    throw new Error(`不支持的文件类型 ${ext || "(无扩展名)"}，请上传 PDF / DOCX / TXT / MD。`);
  }

  if (!parsed.pages.length) {
    throw new Error(
      "未能从文档中提取到文本。若这是扫描件（图片型 PDF），需要 OCR 才能识别，请改用带文字层的 PDF 或直接粘贴正文。",
    );
  }

  const charCount = parsed.pages.reduce((sum, p) => sum + p.text.length, 0);
  if (charCount < 40) {
    throw new Error("文档文本过少（可能是扫描件或空文档），无法进行术语分析。");
  }

  const title = parsed.title || guessTitle(parsed.pages, filename);
  stripTitle(parsed.pages, title);

  return {
    title,
    kind: ext.replace(".", ""),
    filename,
    pages: parsed.pages,
    pageCount: parsed.pageCount ?? parsed.pages.length,
    charCount,
    language: detectLanguage(parsed.pages),
  };
}
