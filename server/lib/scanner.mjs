/**
 * 规则引擎（移植自原应用 src/lib/scanner.ts）：
 * 用多学科词库 + 缩写表对全文做高召回扫描，零模型成本，
 * 作为 AI 语义抽取的兜底，避免专业缩写被漏掉。
 */
import { GLOSSARY, ABBREVIATIONS } from "./glossary.mjs";

function findAll(text, term) {
  if (!term) return [];
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const wordBoundary = /^[a-zA-Z0-9]+$/.test(term);
  const re = new RegExp(wordBoundary ? `\\b${escaped}\\b` : escaped, "gi");
  const positions = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    positions.push(m.index);
    if (m.index === re.lastIndex) re.lastIndex += 1;
  }
  return positions;
}

export function scanTerms(pages) {
  const lowerPages = pages.map((p) => ({ page: p.page, lower: p.text.toLowerCase() }));
  const hitMap = new Map();

  for (const [abbr, zh] of Object.entries(ABBREVIATIONS)) {
    const escaped = abbr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\\b${escaped}\\b`, "g");
    const foundPages = [];
    for (const p of pages) {
      re.lastIndex = 0;
      if (re.test(p.text)) foundPages.push(p.page);
    }
    if (foundPages.length > 0) hitMap.set(abbr, { name: abbr, zhName: zh, pages: foundPages });
  }

  for (const [term, zh] of Object.entries(GLOSSARY)) {
    const foundPages = [];
    for (const p of lowerPages) {
      if (findAll(p.lower, term.toLowerCase()).length > 0) foundPages.push(p.page);
    }
    if (foundPages.length > 0) {
      const key = term.toLowerCase();
      if (!hitMap.has(key)) hitMap.set(key, { name: term, zhName: zh, pages: foundPages });
    }
  }

  return Array.from(hitMap.values());
}
