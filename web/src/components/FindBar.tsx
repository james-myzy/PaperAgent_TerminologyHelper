import { useEffect, useRef, useState } from "react";

/**
 * 论文内搜索：直接在已渲染的正文里定位（不额外请求），
 * 命中段落滚动到视口中央并闪一下。
 */
interface Hit {
  el: HTMLElement;
  offset: number;
}

export default function FindBar({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const collect = (q: string): Hit[] => {
    const trimmed = q.trim();
    if (!trimmed) return [];
    const nodes = Array.from(
      document.querySelectorAll<HTMLElement>(".paper .block-p, .paper .block-h"),
    );
    const found: Hit[] = [];
    const needle = trimmed.toLowerCase();
    for (const el of nodes) {
      const text = (el.textContent ?? "").toLowerCase();
      let offset = text.indexOf(needle);
      while (offset !== -1) {
        found.push({ el, offset });
        offset = text.indexOf(needle, offset + needle.length);
      }
    }
    return found;
  };

  const jump = (list: Hit[], target: number) => {
    if (!list.length) return;
    const wrapped = ((target % list.length) + list.length) % list.length;
    setIndex(wrapped);
    const hit = list[wrapped];
    hit.el.scrollIntoView({ behavior: "smooth", block: "center" });
    hit.el.classList.add("flash");
    window.setTimeout(() => hit.el.classList.remove("flash"), 1100);
  };

  const run = (next: boolean) => {
    if (!query.trim()) return;
    const list = hits.length ? hits : collect(query);
    if (!hits.length) setHits(list);
    if (!list.length) return;
    jump(list, next ? index + 1 : index - 1);
  };

  return (
    <div
      style={{
        position: "fixed",
        top: 66,
        right: 20,
        zIndex: 70,
        display: "flex",
        alignItems: "center",
        gap: 8,
        background: "#fff",
        border: "1px solid var(--line)",
        borderRadius: 11,
        boxShadow: "var(--shadow-md)",
        padding: "8px 10px",
      }}
    >
      <span style={{ color: "var(--muted)", fontSize: 13 }}>⌕</span>
      <input
        ref={inputRef}
        value={query}
        placeholder="在论文中查找…"
        onChange={(e) => {
          const value = e.target.value;
          setQuery(value);
          const list = collect(value);
          setHits(list);
          setIndex(0);
          if (list.length) {
            list[0].el.scrollIntoView({ behavior: "smooth", block: "center" });
            list[0].el.classList.add("flash");
            window.setTimeout(() => list[0].el.classList.remove("flash"), 1100);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            run(!e.shiftKey);
          }
          if (e.key === "Escape") onClose();
        }}
        style={{
          width: 190,
          border: "none",
          outline: "none",
          fontSize: 12.5,
          color: "var(--ink)",
          background: "transparent",
        }}
      />
      <span style={{ fontSize: 11, color: "var(--muted)", fontFamily: "var(--mono)", minWidth: 52, textAlign: "right" }}>
        {hits.length ? `${index + 1} / ${hits.length}` : query ? "0" : ""}
      </span>
      <button className="mini" onClick={() => run(false)} title="上一处">
        ↑
      </button>
      <button className="mini" onClick={() => run(true)} title="下一处">
        ↓
      </button>
      <button className="mini" onClick={onClose} title="关闭">
        ✕
      </button>
    </div>
  );
}
