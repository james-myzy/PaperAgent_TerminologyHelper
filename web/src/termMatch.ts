import type { Term } from "../api";

export interface TermMatcher {
  re: RegExp;
  lookup: Map<string, Term>;
}

/** 构建匹配器：英文裸词加词边界，中文直接匹配，长词优先；整篇只建一次 */
export function buildMatcher(terms: Term[]): TermMatcher {
  const lookup = new Map<string, Term>();
  for (const t of terms) {
    for (const candidate of [t.name, t.zhName]) {
      if (!candidate || !candidate.trim()) continue;
      const key = candidate.toLowerCase();
      if (!lookup.has(key)) lookup.set(key, t);
    }
  }
  const keys = Array.from(lookup.keys()).sort((a, b) => b.length - a.length);
  const pattern = keys
    .map((n) => {
      const escaped = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return /^[\x20-\x7e]+$/.test(n) && /[a-zA-Z]/.test(n) ? `\\b${escaped}\\b` : escaped;
    })
    .join("|");
  const re = pattern ? new RegExp(`(${pattern})`, "gi") : /(?!.*)/g;
  return { re, lookup };
}

export function segmentByTerms(text: string, terms: Term[]): { text: string; term?: Term }[] {
  const { re, lookup } = buildMatcher(terms);
  if (!lookup.size) return [{ text }];
  const segments: { text: string; term?: Term }[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) segments.push({ text: text.slice(last, m.index) });
    segments.push({ text: m[0], term: lookup.get(m[0].toLowerCase()) });
    last = m.index + m[0].length;
    if (m.index === re.lastIndex) re.lastIndex += 1;
  }
  if (last < text.length) segments.push({ text: text.slice(last) });
  return segments;
}
