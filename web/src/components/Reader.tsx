import { memo, useMemo } from "react";
import type { DocPayload, Term } from "../api";
import { buildMatcher, type TermMatcher } from "../termMatch";

/** 同一个术语在正文里最多铺多少处高亮，再往后就留白，避免整页发黄 */
const HIGHLIGHT_LIMIT = 14;

interface Seg {
  text: string;
  term?: Term;
}

interface ReaderProps {
  doc: DocPayload;
  /** 双语对照：原文一段后面跟一段译文 */
  bilingual: boolean;
  /** 逐段译文缓存：键是「页码:段序号」 */
  blockTrans: Record<string, string>;
  transProgress: { done: number; total: number } | null;
  activeTermId: string | null;
  onTermClick: (term: Term, el: HTMLElement) => void;
  onHome: () => void;
  onExport: () => void;
  exporting: boolean;
  analyzing: boolean;
  onOpenAgent: () => void;
}

/** 预先算好每段的切分与高亮配额，整篇只算一次 */
function buildPlan(doc: DocPayload, matcher: TermMatcher): Map<string, Seg[]> {
  const plan = new Map<string, Seg[]>();
  const budget = new Map<string, number>();
  const { re, lookup } = matcher;

  for (const page of doc.pages) {
    (page.blocks ?? []).forEach((block, index) => {
      if (block.type === "h") return;
      const segs: Seg[] = [];
      let last = 0;
      let m: RegExpExecArray | null;
      re.lastIndex = 0;
      while ((m = re.exec(block.text)) !== null) {
        if (m.index > last) segs.push({ text: block.text.slice(last, m.index) });
        const term = lookup.get(m[0].toLowerCase());
        const used = term ? budget.get(term.id) ?? 0 : 0;
        if (term && term.highlight !== false && used < HIGHLIGHT_LIMIT) {
          budget.set(term.id, used + 1);
          segs.push({ text: m[0], term });
        } else {
          segs.push({ text: m[0] });
        }
        last = m.index + m[0].length;
        if (m.index === re.lastIndex) re.lastIndex += 1;
      }
      if (last < block.text.length) segs.push({ text: block.text.slice(last) });
      plan.set(`${page.page}:${index}`, segs);
    });
  }
  return plan;
}

const Paragraph = memo(function Paragraph({
  segments,
  onTermClick,
}: {
  segments: Seg[];
  onTermClick: (term: Term, el: HTMLElement) => void;
}) {
  return (
    <p className="block-p">
      {segments.map((seg, i) =>
        seg.term ? (
          <mark
            key={i}
            className="term"
            data-term-id={seg.term.id}
            title={seg.term.zhName ?? seg.term.name}
            onClick={(e) => onTermClick(seg.term!, e.currentTarget)}
          >
            {seg.text}
          </mark>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )}
    </p>
  );
});

export default function Reader({
  doc,
  bilingual,
  blockTrans,
  transProgress,
  onTermClick,
  onHome,
  onExport,
  exporting,
  analyzing,
  onOpenAgent,
}: ReaderProps) {
  const matcher = useMemo(() => buildMatcher(doc.terms), [doc.terms]);
  const plan = useMemo(() => buildPlan(doc, matcher), [doc, matcher]);

  return (
    <div className="stage" id="stage">
      <article className="paper">
        <h1>{doc.title}</h1>
        <div className="paper-sub">
          <span>{doc.kind.toUpperCase()}</span>
          <span>{doc.pageCount} 页</span>
          <span>{doc.charCount.toLocaleString()} 字</span>
          <span>{doc.language === "en" ? "英文" : doc.language === "zh" ? "中文" : "语言未知"}</span>
          {doc.terms.length ? <span>{doc.terms.length} 个术语已标注</span> : null}
          {bilingual ? <span className="sub-badge">双语对照已开启</span> : null}
        </div>

        {analyzing && doc.terms.length === 0 ? (
          <div className="banner" style={{ borderRadius: 8, marginBottom: 18 }}>
            <span className="spinner" />
            正在识别专业术语：词库扫描 + 模型语义抽取…（长文约 20–40 秒）
          </div>
        ) : null}

        {bilingual && transProgress ? (
          <div className="banner" style={{ borderRadius: 8, marginBottom: 18 }}>
            <span className="spinner" />
            正在逐段翻译：{transProgress.done} / {transProgress.total || "…"} 段
            （译好的段落会立刻出现在原文下方）
          </div>
        ) : null}

        {doc.pages.map((page) => {
          const blocks = page.blocks ?? [{ type: "p" as const, text: page.text }];

          return (
            <section className="page-block" key={page.page} data-page={page.page}>
              {doc.pages.length > 1 ? <div className="page-marker">第 {page.page} 页</div> : null}
              {blocks.map((block, i) => {
                const key = `${page.page}:${i}`;
                const translated = bilingual ? blockTrans[key] : undefined;
                const isHeading = block.type === "h";
                const segments = plan.get(key) ?? [{ text: block.text }];

                return (
                  <div className="block-pair" key={key}>
                    {isHeading ? (
                      <div className="block-h">{block.text}</div>
                    ) : (
                      <Paragraph segments={segments} onTermClick={onTermClick} />
                    )}
                    {bilingual ? (
                      translated ? (
                        <div className={`block-trans${isHeading ? " is-heading" : ""}`}>
                          {translated}
                        </div>
                      ) : (
                        <div className="block-trans pending">
                          <span className="spin-dot" />
                          翻译中…
                        </div>
                      )
                    ) : null}
                  </div>
                );
              })}
            </section>
          );
        })}

        <div style={{ margin: "34px 0 0", display: "flex", gap: 10, justifyContent: "center" }}>
          <button className="btn" onClick={onOpenAgent}>
            ✦ 让智能体分析这篇论文
          </button>
          <button className="btn" onClick={onHome}>
            换一篇
          </button>
          <button className="btn" onClick={onExport} disabled={exporting}>
            {exporting ? "导出中…" : "导出高亮 Word"}
          </button>
        </div>
      </article>
    </div>
  );
}
