/**
 * 术语匹配核心（移植自原应用 src/lib/termMatch.ts）。
 * 前端高亮与 Word 导出的高亮都走同一套匹配规则，保证「屏幕上看到的」和「导出的」一致。
 */

/** 构建单一正则：英文裸词加词边界，中文直接匹配，长的优先 */
export function buildMatcher(terms) {
  const lookup = new Map();
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

/** 按术语把纯文本切成片段，命中片段带 term */
export function segmentText(text, terms) {
  const { re, lookup } = buildMatcher(terms);
  if (lookup.size === 0) return [{ text }];
  const segments = [];
  let last = 0;
  let m;
  re.lastIndex = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) segments.push({ text: text.slice(last, m.index) });
    segments.push({ text: m[0], term: lookup.get(m[0].toLowerCase()) });
    last = m.index + m[0].length;
    if (m.index === re.lastIndex) re.lastIndex += 1;
  }
  if (last < text.length) segments.push({ text: text.slice(last) });
  return segments;
}

/** 术语归一化 key：忽略大小写与分隔符差异，用于跨引擎去重 */
export function termKey(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[\s\-_/]/g, "");
}
