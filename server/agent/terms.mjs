/**
 * 术语引擎：词库规则扫描（零成本、高召回）+ 模型语义抽取（覆盖新词），
 * 两路结果按归一化 key 融合去重，与原应用 analyzePaperTerms 的策略保持一致。
 */
import { createHash } from "node:crypto";
import { config } from "../config.mjs";
import { llm } from "./llm.mjs";
import { scanTerms } from "../lib/scanner.mjs";
import { termKey } from "../lib/termMatch.mjs";
import {
  TERM_EXTRACT_SYSTEM,
  EXPLAIN_SYSTEM,
  SEARCH_EXPLAIN_SYSTEM,
  TRANSLATE_SYSTEM,
  PASSAGE_SYSTEM,
} from "./prompts.mjs";

function parseTermArray(raw) {
  let text = String(raw || "").replace(/^\uFEFF/, "").trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) return [];
  let arr;
  try {
    arr = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const result = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const name = String(item.name ?? item.term ?? item.english ?? "").trim();
    if (!name) continue;
    const brief = String(item.brief ?? item.definition ?? item.desc ?? item.explanation ?? "").trim();
    const zhName = String(item.zhName ?? item.zh ?? item.chinese ?? item.translation ?? "").trim();
    result.push({ name, brief: brief || `${name}（待补充解释）`, zhName: zhName || undefined });
  }
  return result;
}

function chunkPages(pages, maxLen, maxChunks) {
  const chunks = [];
  let current = [];
  let length = 0;
  for (const page of pages) {
    if (length + page.text.length > maxLen && current.length) {
      chunks.push(current);
      current = [];
      length = 0;
      if (chunks.length >= maxChunks) break;
    }
    current.push(page);
    length += page.text.length;
  }
  if (current.length && chunks.length < maxChunks) chunks.push(current);
  return chunks;
}

/** 用模型对若干块文本做语义抽取，失败就只保留词库结果，不阻断主流程 */
async function aiExtractTerms(doc, { signal, maxChunks }) {
  const chunks = chunkPages(doc.pages, config.termChunkChars, maxChunks ?? config.termMaxChunks);
  const lists = await Promise.all(
    chunks.map(async (chunk) => {
      const text = chunk.map((p) => p.text).join("\n");
      try {
        const { text: raw } = await llm.completeChat({
          messages: [
            { role: "system", content: TERM_EXTRACT_SYSTEM },
            { role: "user", content: `论文标题：${doc.title}\n论文文本：\n${text}` },
          ],
          temperature: 0.1,
          maxTokens: 8192,
          signal,
        });
        return parseTermArray(raw);
      } catch {
        return [];
      }
    }),
  );
  return { lists, scannedChunks: chunks.length, totalChunks: chunks.length };
}

/** 代码类噪声（文件名、配置键、命令）：留在术语表里，但不铺满正文高亮 */
function highlightable(name) {
  const n = name.trim();
  if (n.length < 3) return false;
  if (/[\\/:]/.test(n)) return false;
  if (/\.(exe|dll|json|md|txt|png|jpe?g|cpp|h|py|js|ts|ya?ml)\b/i.test(n)) return false;
  // camelCase 配置键（problemMatcher、cppbuild 之类）
  if (/^[a-z]+[A-Z][a-zA-Z]*$/.test(n)) return false;
  return true;
}

/**
 * 去掉“永远只作为更长术语的一部分出现”的短词。
 * 例：horizon 全部出现在 long-horizon / Long-Horizon World Models 里，
 * 它既没有独立高亮（长词优先匹配会吃掉它），跳转也永远找不到位置。
 * 只丢“完全没有独立出现”的，JEPA 这类本身独立成词的不会被误删。
 */
function dropShadowedTerms(terms, pages) {
  const texts = pages.map((p) => p.text.toLowerCase());
  const kept = [];
  const dropped = [];

  for (const term of terms) {
    // 词库里的术语即使这次只出现在长术语内部也保留（neural network 这类不该被删）
    if (term.source === "词库") {
      kept.push(term);
      continue;
    }
    const needle = term.name.toLowerCase();
    const longer = terms.filter(
      (u) => u !== term && u.name.length > term.name.length && u.name.toLowerCase().includes(needle),
    );
    if (!longer.length) {
      kept.push(term);
      continue;
    }

    let total = 0;
    let standalone = 0;
    for (const text of texts) {
      let from = 0;
      for (;;) {
        const at = text.indexOf(needle, from);
        if (at === -1) break;
        total += 1;
        from = at + needle.length;
        const covered = longer.some((u) => {
          const big = u.name.toLowerCase();
          let start = text.indexOf(big);
          while (start !== -1) {
            if (start <= at && at + needle.length <= start + big.length) return true;
            start = text.indexOf(big, start + 1);
          }
          return false;
        });
        if (!covered) standalone += 1;
      }
    }

    if (total > 0 && standalone === 0) dropped.push(term.name);
    else kept.push(term);
  }

  if (dropped.length) {
    console.log(`[terms] 过滤被长术语完全覆盖的短词 ${dropped.length} 个：${dropped.slice(0, 8).join("、")}${dropped.length > 8 ? "…" : ""}`);
  }
  return kept;
}

/**
 * 单字母/纯 ASCII 词用词边界找，避免 "g" 命中 "Learning" 这类误报。
 * 直接决定术语的"首次出现页"，页计算错了排序也会歪。
 */
function boundaryPattern(name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return /^[a-zA-Z0-9][a-zA-Z0-9\-+.#/]*$/.test(name)
    ? new RegExp(`\\b${escaped}\\b`, "i")
    : null;
}

function pagesContaining(name, pages) {
  const re = boundaryPattern(name);
  return pages
    .filter((p) => (re ? re.test(p.text) : p.text.toLowerCase().includes(name.toLowerCase())))
    .map((p) => p.page);
}

/** 读者自己添加的术语：一定铺高亮，页位置现算 */
export function buildCustomTerm(doc, { name, zhName, brief } = {}) {
  const clean = String(name ?? "").trim();
  if (!clean) return null;
  return {
    id: `custom-${termKey(clean).slice(0, 24)}`,
    name: clean,
    zhName: String(zhName ?? "").trim() || undefined,
    brief: String(brief ?? "").trim() || "（自定义术语，点击可让智能体解释）",
    source: "自定义",
    pages: pagesContaining(clean, doc.pages),
    highlight: true,
  };
}

export async function extractTerms(doc, { signal, maxChunks } = {}) {
  const hits = scanTerms(doc.pages);
  const { lists, scannedChunks } = await aiExtractTerms(doc, { signal, maxChunks });

  const merged = new Map();
  for (const hit of hits) {
    merged.set(termKey(hit.name), {
      name: hit.name,
      zhName: hit.zhName,
      brief: `${hit.zhName}（来自专业词库）`,
      fromGlossary: true,
    });
  }
  for (const list of lists) {
    for (const item of list) {
      const key = termKey(item.name);
      if (!key || merged.has(key)) continue;
      merged.set(key, { ...item, fromGlossary: false });
    }
  }

  let index = 0;
  const terms = [];
  for (const item of merged.values()) {
    index += 1;
    const pages = pagesContaining(item.name, doc.pages);
    terms.push({
      id: `term-${index}-${termKey(item.name).slice(0, 24)}`,
      name: item.name,
      zhName: item.zhName || undefined,
      brief: item.brief,
      source: item.fromGlossary ? "词库" : "AI",
      pages,
      highlight: highlightable(item.name),
    });
  }

  const visible = dropShadowedTerms(terms, doc.pages);
  return { terms: visible, glossaryHits: hits.length, aiLists: lists.length, scannedChunks };
}

function explainMessages(doc, termName) {
  const needle = termName.toLowerCase();
  const hitPage = doc.pages.find((p) => p.text.toLowerCase().includes(needle));
  const existing = doc.terms.find((t) => termKey(t.name) === termKey(termName));
  const context = (hitPage?.text ?? doc.pages[0]?.text ?? "").slice(0, 600);
  return {
    page: hitPage?.page ?? null,
    messages: [
      { role: "system", content: EXPLAIN_SYSTEM },
      {
        role: "user",
        content: [
          `论文标题：${doc.title}`,
          `相关上下文：${context}`,
          `术语：${existing?.name ?? termName}`,
          existing?.zhName ? `中文译名：${existing.zhName}` : "",
          existing?.brief ? `已有简释：${existing.brief}` : "",
          "请按三段结构给出专业、通俗的详细解释。",
        ]
          .filter(Boolean)
          .join("\n"),
      },
    ],
  };
}

export async function explainTerm(doc, termName, { signal } = {}) {
  const { messages, page } = explainMessages(doc, termName);
  const { text } = await llm.completeChat({
    messages,
    temperature: 0.3,
    maxTokens: 1200,
    signal,
  });
  return { text, page };
}

/** 阅读器里点术语用：边生成边推给气泡，0.5 秒就能看到第一段 */
export async function explainTermStream(doc, termName, { signal, onDelta } = {}) {
  const { messages, page } = explainMessages(doc, termName);
  const { text } = await llm.streamChat({
    messages,
    signal,
    onText: (delta) => onDelta?.(delta),
  });
  return { text, page };
}

/**
 * 选段解释：不走智能体的工具循环，直接把「选段 + 所在页上下文」发给模型，
 * 便宜、快，而且天然适合按内容做缓存（同一段只问一次）。
 */
export async function explainPassageStream(doc, { text, page }, { signal, onDelta } = {}) {
  const selected = String(text ?? "").replace(/\s+/g, " ").trim().slice(0, 1500);
  const pageObj = doc.pages.find((p) => p.page === Number(page)) ?? doc.pages[0];
  const pageText = (pageObj?.text ?? "").replace(/\s+/g, " ");

  // 取选段在页内的前后文，帮助模型判断这段话的位置与作用
  const at = pageText.indexOf(selected.slice(0, 40));
  const context =
    at === -1
      ? pageText.slice(0, 1200)
      : pageText.slice(Math.max(0, at - 500), Math.min(pageText.length, at + selected.length + 500));

  const messages = [
    { role: "system", content: PASSAGE_SYSTEM },
    {
      role: "user",
      content: [
        `论文标题：${doc.title}`,
        `所在页：第 ${pageObj?.page ?? 1} 页`,
        `选段：「${selected}」`,
        `该页上下文：${context}`,
        "请按四部分结构解释这一段。",
      ].join("\n"),
    },
  ];

  const { text: answer } = await llm.streamChat({
    messages,
    signal,
    onText: (delta) => onDelta?.(delta),
  });
  return { text: answer, page: pageObj?.page ?? 1 };
}

export async function explainInDocument(doc, query, snippets, { signal } = {}) {
  const snippetText = snippets.length
    ? snippets.map((s, i) => `【原文片段${i + 1}】${s}`).join("\n")
    : "（未提供原文片段）";
  const { text } = await llm.completeChat({
    messages: [
      { role: "system", content: SEARCH_EXPLAIN_SYSTEM },
      { role: "user", content: `搜索词：${query}\n\n${snippetText}\n\n请结合上述原文，解释"${query}"在本文中的含义与作用。` },
    ],
    temperature: 0.3,
    maxTokens: 800,
    signal,
  });
  return text;
}

const TRANSLATE_CHUNK = 2600;

export async function translatePages(doc, pages, { signal } = {}) {
  const results = {};
  for (const page of pages) {
    const parts = [];
    for (let i = 0; i < page.text.length; i += TRANSLATE_CHUNK) {
      parts.push(page.text.slice(i, i + TRANSLATE_CHUNK));
    }
    const translated = [];
    for (const part of parts.slice(0, 4)) {
      const { text } = await llm.completeChat({
        messages: [
          { role: "system", content: TRANSLATE_SYSTEM },
          { role: "user", content: part },
        ],
        temperature: 0.2,
        maxTokens: 2600,
        signal,
      });
      translated.push(text.trim());
    }
    results[page.page] = translated.join("\n\n");
  }
  return results;
}

/* ------------------------------------------------------------------ */
/* 逐段翻译：保留段落边界，供「双语对照」在原文里一段原文一段译文地插入    */
/* ------------------------------------------------------------------ */

/** 段落之间的分隔符，模型按同样格式返回 */
const BLOCK_SEP = "\n\n@@\n\n";
const BLOCK_SEP_RE = /\n\s*@@\s*\n/;

/** 每段翻译的缓存键：段落文本的短哈希，文本不变就复用 */
function hashBlock(text) {
  return createHash("sha1").update(text).digest("hex").slice(0, 16);
}

/** 一批段落送模型：要求段数、顺序与分隔符都保持一致 */
async function translateBatch(texts, signal) {
  const { text } = await llm.completeChat({
    messages: [
      { role: "system", content: TRANSLATE_SYSTEM },
      {
        role: "user",
        content: [
          `下面有 ${texts.length} 段英文，用单独一行 @@ 分隔。`,
          "请逐段翻译成简体中文，保持同样的段数与顺序，输出时也用单独一行 @@ 分隔。",
          "不要加编号、不要解释、不要空段。",
          "",
          texts.join(BLOCK_SEP),
        ].join("\n"),
      },
    ],
    temperature: 0.2,
    maxTokens: 3000,
    signal,
  });

  const parts = String(text)
    .split(BLOCK_SEP_RE)
    .map((part) => part.trim())
    .filter(Boolean);
  return parts;
}

/**
 * 逐段翻译整篇（或指定页）。
 * @param {object} doc
 * @param {{ pages?: number[], force?: boolean, signal?: AbortSignal,
 *   onBlock?: (block: {page:number,index:number,text:string,cached:boolean}) => void,
 *   onProgress?: (progress: {done:number,total:number}) => void }} [options]
 * @returns {Promise<{ count: number, cached: number, translations: Record<string,string> }>}
 */
export async function translateBlocks(doc, options = {}) {
  const { pages, force = false, signal, onBlock, onProgress } = options;
  const targets = pages?.length
    ? doc.pages.filter((page) => pages.includes(page.page))
    : doc.pages;
  const previous = doc.blockTranslations ?? {};
  const translations = {};
  let total = 0;
  for (const page of targets) total += (page.blocks ?? []).length;
  let done = 0;
  let cachedCount = 0;

  for (const page of targets) {
    const blocks = page.blocks ?? [];
    /** 待翻译段落 */
    const pending = [];

    blocks.forEach((block, index) => {
      const text = String(block.text ?? "").trim();
      if (!text) return;
      const key = `${page.page}:${index}`;
      const hash = hashBlock(text);
      const hit = previous[key];
      if (!force && hit && hit.hash === hash && hit.text) {
        translations[key] = hit;
        cachedCount += 1;
        done += 1;
        onProgress?.({ done, total });
        onBlock?.({ page: page.page, index, text: hit.text, cached: true });
        return;
      }
      pending.push({ index, key, text, hash });
    });

    // 按「每批最多 8 段、合计不超过 4000 字符」切批，兼顾吞吐与模型输出上限
    const batches = [];
    let current = [];
    let chars = 0;
    for (const item of pending) {
      if (current.length >= 8 || (chars + item.text.length > 4000 && current.length > 0)) {
        batches.push(current);
        current = [];
        chars = 0;
      }
      current.push(item);
      chars += item.text.length;
    }
    if (current.length) batches.push(current);

    // 并发跑 3 批：单批失败只影响自己，进度与缓存按段写入
    const queue = batches.slice();
    const pageNumber = page.page;
    const work = async (batch) => {
      let parts = [];
      try {
        parts = await translateBatch(
          batch.map((item) => item.text),
          signal,
        );
      } catch {
        parts = [];
      }

      // 段数对不上时退化为逐段翻译，保证顺序与完整性
      if (parts.length !== batch.length) {
        parts = [];
        for (const item of batch) {
          try {
            const { text } = await llm.completeChat({
              messages: [
                { role: "system", content: TRANSLATE_SYSTEM },
                { role: "user", content: item.text },
              ],
              temperature: 0.2,
              maxTokens: 1200,
              signal,
            });
            parts.push(String(text).trim());
          } catch {
            parts.push("");
          }
        }
      }

      batch.forEach((item, i) => {
        const text = parts[i] ?? "";
        if (!text) {
          done += 1;
          onProgress?.({ done, total });
          return;
        }
        translations[item.key] = { hash: item.hash, text };
        done += 1;
        onProgress?.({ done, total });
        onBlock?.({ page: pageNumber, index: item.index, text, cached: false });
      });
    };

    const workers = Array.from({ length: Math.min(3, queue.length) }, async () => {
      while (queue.length) {
        const batch = queue.shift();
        if (!batch) break;
        await work(batch);
      }
    });
    await Promise.all(workers);
  }

  return { count: done, cached: cachedCount, translations };
}
