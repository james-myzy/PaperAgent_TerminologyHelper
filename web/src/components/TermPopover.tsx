import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { explainTermStream, type DocPayload, type Term } from "../api";

interface Props {
  doc: DocPayload;
  term: Term;
  index: number;
  anchor: HTMLElement;
  cachedDetail?: string;
  /** 右侧边界（术语面板打开时把气泡挡在面板左边，避免叠在一起） */
  rightBound?: number;
  onClose: () => void;
  onAskAgent: (question: string) => void;
  /** 拿到解释后回写文档状态，下次点同一个术语直接用缓存，不再请求模型 */
  onExplainDone?: (key: string, text: string) => void;
}

interface Section {
  label: string;
  body: string;
}

/** 把「【专业定义】xxx【上下文释义】yyy」拆成结构化段落 */
function parseSections(text: string): Section[] {
  const parts = text.split(/【([^】]{2,12})】/);
  const sections: Section[] = [];
  // parts[0] 是第一个标签前的残余
  for (let i = 1; i < parts.length; i += 2) {
    const label = parts[i];
    const body = (parts[i + 1] ?? "").trim();
    if (label) sections.push({ label, body });
  }
  if (!sections.length && text.trim()) sections.push({ label: "", body: text.trim() });
  return sections;
}

export default function TermPopover({
  doc,
  term,
  index,
  anchor,
  cachedDetail,
  rightBound,
  onClose,
  onAskAgent,
  onExplainDone,
}: Props) {
  const [text, setText] = useState(cachedDetail ?? "");
  const [loading, setLoading] = useState(!cachedDetail);
  const [fromCache, setFromCache] = useState(Boolean(cachedDetail));
  const [error, setError] = useState<string | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number; above: boolean; caretX: number } | null>(
    null,
  );
  const cardRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // 定位：贴着被点的术语，下面放不下就翻到上面，左右夹到视口内
  const place = () => {
    const rect = anchor.getBoundingClientRect();
    const width = Math.min(388, window.innerWidth - 32);
    const maxRight = rightBound ?? window.innerWidth;
    let left = rect.left + rect.width / 2 - width / 2;
    left = Math.max(16, Math.min(left, maxRight - width - 16));
    const height = cardRef.current?.offsetHeight ?? 320;
    const above = rect.bottom + 12 + height > window.innerHeight - 16;
    const top = above ? Math.max(12, rect.top - 12 - height) : rect.bottom + 12;
    const caretX = Math.max(18, Math.min(rect.left + rect.width / 2 - left, width - 18));
    setPos({ left, top, above, caretX });
  };

  useLayoutEffect(() => {
    place();
    const handler = () => place();
    window.addEventListener("scroll", handler, true);
    window.addEventListener("resize", handler);
    // 平滑滚动 + 懒渲染会让锚点位置继续变化，开头一秒内多贴几次
    const timers = [0, 100, 220, 380, 560, 800, 1100].map((delay) =>
      window.setTimeout(place, delay),
    );
    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
      window.removeEventListener("scroll", handler, true);
      window.removeEventListener("resize", handler);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor, rightBound]);

  const runExplain = (force: boolean) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    if (force) {
      setText("");
      setFromCache(false);
    }
    setLoading(true);
    setError(null);

    explainTermStream(
      doc.id,
      term.name,
      (event) => {
        if (event.type === "delta") setText((prev) => prev + String(event.text ?? ""));
        if (event.type === "done") {
          const finalText = String(event.text ?? "");
          if (finalText) setText(finalText);
          setLoading(false);
          if (event.cached) setFromCache(true);
          // 回写上层：同一个术语以后再点就命中缓存，不再花 token
          if (event.key && finalText) onExplainDone?.(String(event.key), finalText);
          requestAnimationFrame(place);
        }
        if (event.type === "error") {
          setError(String(event.message ?? "解释生成失败"));
          setLoading(false);
        }
      },
      controller.signal,
      { force },
    )
      .catch((err) => {
        if ((err as Error).name !== "AbortError") setError((err as Error).message);
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (cachedDetail) return;
    runExplain(false);
    return () => abortRef.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.id, term.name]);

  useEffect(() => {
    anchor.classList.add("active");
    return () => anchor.classList.remove("active");
  }, [anchor]);

  useEffect(() => {
    // 流式内容变高后重新贴一次位置，避免气泡长到视口外
    const id = requestAnimationFrame(() => place());
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onDown = (e: MouseEvent) => {
      if (cardRef.current && !cardRef.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener("keydown", onKey);
    // 延后一帧，避免打开气泡的这次点击立刻把它关掉
    const timer = window.setTimeout(() => window.addEventListener("mousedown", onDown), 0);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [onClose]);

  const sections = parseSections(text);
  const firstPage = term.pages?.[0];

  return (
    <div
      className="popover"
      ref={cardRef}
      data-above={pos?.above ? "true" : "false"}
      style={{
        left: pos?.left ?? -9999,
        top: pos?.top ?? 0,
        visibility: pos ? "visible" : "hidden",
        ["--caret-x" as string]: `${pos?.caretX ?? 40}px`,
      }}
    >
      <div className="pop-head">
        <div className="pop-title">
          {index >= 0 ? <span className="pop-no">N° {String(index + 1).padStart(2, "0")}</span> : null}
          <span className="pop-name">{term.name}</span>
          {term.zhName ? <span className="pop-zh">{term.zhName}</span> : null}
        </div>
        <div className="pop-meta">
          {term.pages?.length ? <span>出现 {term.pages.length} 处</span> : null}
          {firstPage ? <span>首见第 {firstPage} 页</span> : null}
          {term.source ? <span>{term.source === "词库" ? "专业词库" : term.source}</span> : null}
          {fromCache ? <span className="pop-cache">已缓存 · 未重复请求</span> : null}
        </div>
      </div>

      <div className="pop-body">
        {sections.length === 0 && loading ? (
          <div className="pop-loading">
            <span className="spinner" />
            正在结合本文上下文生成解释…
          </div>
        ) : null}
        {sections.map((section, i) => (
          <div className="pop-section" key={i}>
            {section.label ? <div className="pop-label">{section.label}</div> : null}
            <div className="pop-text">{section.body}</div>
          </div>
        ))}
        {loading && sections.length > 0 ? <span className="typing"><i /><i /><i /></span> : null}
        {error ? <div style={{ color: "var(--warn)", fontSize: 12 }}>{error}</div> : null}
      </div>

      <div className="pop-foot">
        <button className="mini" onClick={() => onAskAgent(`再详细讲讲「${term.name}」在本文中的作用`)}>
          追问智能体
        </button>
        <button
          className="mini"
          onClick={() => {
            navigator.clipboard?.writeText(`${term.name}${term.zhName ? `（${term.zhName}）` : ""}：${text}`);
          }}
        >
          复制解释
        </button>
        <button className="mini" onClick={() => runExplain(true)} disabled={loading}>
          {loading ? "生成中…" : "重新解释"}
        </button>
        <span className="hint">
          {fromCache ? "已缓存 · 未重复请求" : "300 字内 · 贴着本文"}
        </span>
      </div>
    </div>
  );
}
