import { useEffect, useLayoutEffect, useRef, useState } from "react";
import * as pdfjs from "pdfjs-dist";
import workerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { Term } from "../api";
import { apiUrl } from "../api";
import { buildMatcher } from "../termMatch";

pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;

interface Props {
  docId: string;
  terms: Term[];
  analyzing?: boolean;
  onTermClick: (term: Term, el: HTMLElement) => void;
  onFallback: () => void;
  onSelectText: (text: string, page: number, rect: { left: number; top: number; width: number; height: number }) => void;
}

interface Hit {
  left: number;
  top: number;
  width: number;
  height: number;
  term: Term;
}

/** 文本块矩形：框选时用来取回文字 */
interface TextBox {
  text: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

interface DragRect {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** 同一行文本的合并结果，用于跨文本块匹配多词术语 */
interface LineItem {
  start: number;
  text: string;
  x: number;
  width: number;
  top: number;
  height: number;
}

function buildHits(
  items: any[],
  viewport: any,
  matcher: ReturnType<typeof buildMatcher>,
): { hits: Hit[]; boxes: TextBox[] } {
  const { re, lookup } = matcher;
  const empty = { hits: [] as Hit[], boxes: [] as TextBox[] };
  if (!lookup.size) {
    // 没术语时也要留文本框，框选照样能用
    const boxes: TextBox[] = [];
    for (const item of items) {
      if (!item?.str || !item.transform) continue;
      const tx = pdfjs.Util.transform(viewport.transform, item.transform);
      const h = (item.height > 0 ? item.height : 10) * viewport.scale;
      boxes.push({
        text: item.str,
        left: tx[4],
        top: tx[5] - h * 0.85,
        width: Math.max(1, item.width * viewport.scale),
        height: h * 1.06,
      });
    }
    return { hits: [], boxes };
  }

  // 1) 按基线聚合成行
  const lines = new Map<number, LineItem[]>();
  for (const item of items) {
    if (!item?.str || !item.transform) continue;
    const tx = pdfjs.Util.transform(viewport.transform, item.transform);
    const fontSize = Math.hypot(tx[2], tx[3]) || Math.abs(tx[3]) || 10;
    const boxHeight = (item.height > 0 ? item.height : fontSize / viewport.scale) * viewport.scale;
    const key = Math.round(tx[5] / 2);
    const entry: LineItem = {
      start: 0,
      text: item.str,
      x: tx[4],
      width: item.width * viewport.scale,
      top: tx[5] - boxHeight * 0.85,
      height: boxHeight * 1.06,
    };
    const list = lines.get(key);
    if (list) list.push(entry);
    else lines.set(key, [entry]);
  }

  const hits: Hit[] = [];
  for (const list of lines.values()) {
    list.sort((a, b) => a.x - b.x);
    // 拼行：只有块之间确实有空隙才补空格。
    // 标题常被 pdf.js 拆成"逐字符"的文本块，无脑补空格会把标题拆成 "W o r l d"，
    // 导致 "world models" 这类多词术语在标题里匹配不上。
    let cursor = 0;
    let prev: LineItem | null = null;
    const chunks: string[] = [];
    for (const entry of list) {
      let sep = "";
      if (prev) {
        const gap = entry.x - (prev.x + prev.width);
        sep = gap > Math.max(1.2, entry.height * 0.16) ? " " : "";
      }
      entry.start = cursor + sep.length;
      cursor = entry.start + entry.text.length;
      chunks.push(sep + entry.text);
      prev = entry;
    }
    const lineText = chunks.join("");
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(lineText)) !== null) {
      const term = lookup.get(m[0].toLowerCase());
      if (!term) continue;
      const begin = m.index;
      const end = m.index + m[0].length;
      const first = list.find((e) => begin >= e.start && begin < e.start + e.text.length) ?? list[0];
      const last =
        [...list].reverse().find((e) => end > e.start && end <= e.start + e.text.length) ??
        list[list.length - 1];
      const x1 = first.x + first.width * ((begin - first.start) / Math.max(1, first.text.length));
      const x2 = last.x + last.width * ((end - last.start) / Math.max(1, last.text.length));
      hits.push({
        left: x1,
        top: first.top,
        width: Math.max(6, x2 - x1),
        height: first.height,
        term,
      });
      if (m.index === re.lastIndex) re.lastIndex += 1;
    }
  }

  // 同时把每个文本块的矩形留下来，供"框选段落"取文字用
  const boxes: TextBox[] = [];
  for (const list of lines.values()) {
    for (const entry of list) {
      if (!entry.text.trim()) continue;
      boxes.push({
        text: entry.text,
        left: entry.x,
        top: entry.top,
        width: Math.max(1, entry.width),
        height: entry.height,
      });
    }
  }

  return { hits, boxes };
}

function PdfPage({
  pdf,
  pageNumber,
  terms,
  baseWidth,
  zoom,
  intrinsic,
  onTermClick,
  onSelectText,
}: {
  pdf: any;
  pageNumber: number;
  terms: Term[];
  baseWidth: number;
  zoom: number;
  intrinsic?: { w: number; h: number };
  onTermClick: (term: Term, el: HTMLElement) => void;
  onSelectText: Props["onSelectText"];
}) {
  const holderRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [hits, setHits] = useState<Hit[]>([]);
  const [boxes, setBoxes] = useState<TextBox[]>([]);
  const [drag, setDrag] = useState<DragRect | null>(null);
  const dragRef = useRef<DragRect | null>(null);
  const [visible, setVisible] = useState(false);
  const [rendered, setRendered] = useState(false);
  const [ratio, setRatio] = useState(1);
  const matcher = buildMatcher(terms);

  /* ---------------- 框选段落：PDF 没有可选中文本层，用矩形选文字块 ---------------- */

  const pointOf = (e: React.MouseEvent) => {
    const wrap = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return { x: e.clientX - wrap.left, y: e.clientY - wrap.top };
  };

  const handleDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest(".pdf-hit")) return; // 点术语不触发框选
    const { x, y } = pointOf(e);
    const rect = { x1: x, y1: y, x2: x, y2: y };
    dragRef.current = rect;
    setDrag(rect);
  };

  const handleMove = (e: React.MouseEvent) => {
    if (!dragRef.current) return;
    const { x, y } = pointOf(e);
    const next = { ...dragRef.current, x2: x, y2: y };
    dragRef.current = next;
    setDrag(next);
  };

  const handleUp = (e: React.MouseEvent) => {
    const rect = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    if (!rect) return;

    const left = Math.min(rect.x1, rect.x2);
    const right = Math.max(rect.x1, rect.x2);
    const top = Math.min(rect.y1, rect.y2);
    const bottom = Math.max(rect.y1, rect.y2);
    if (right - left < 6 || bottom - top < 6) return;

    const picked = boxes.filter(
      (b) =>
        b.left < right &&
        b.left + b.width > left &&
        b.top < bottom &&
        b.top + b.height > top,
    );
    if (!picked.length) return;
    picked.sort((a, b) => (Math.abs(a.top - b.top) > 4 ? a.top - b.top : a.left - b.left));
    const text = picked
      .map((p) => p.text)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (text.length < 4) return;

    const wrap = (e.currentTarget as HTMLElement).getBoundingClientRect();
    onSelectText(text, pageNumber, {
      left: wrap.left + left,
      top: wrap.top + top,
      width: right - left,
      height: bottom - top,
    });
  };

  // 用整篇预先量好的页面尺寸立即占位，避免"先塌再撑"导致滚动错位
  useLayoutEffect(() => {
    if (!intrinsic) return;
    const scale = Math.min(3, Math.max(0.4, (baseWidth * zoom) / intrinsic.w));
    setSize({ width: intrinsic.w * scale, height: intrinsic.h * scale });
  }, [intrinsic, baseWidth, zoom]);

  // 懒渲染：接近视口才画
  useEffect(() => {
    const el = holderRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setVisible(true);
      },
      { rootMargin: "900px 0px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const viewportFor = async () => {
    const page = await pdf.getPage(pageNumber);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(3, Math.max(0.4, (baseWidth * zoom) / base.width));
    return { page, viewport: page.getViewport({ scale }), scale };
  };

  // 先占位：未渲染的页也要有正确高度，否则滚动时页面会跳
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const page = await pdf.getPage(pageNumber);
      if (cancelled) return;
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(3, Math.max(0.4, (baseWidth * zoom) / base.width));
      const viewport = page.getViewport({ scale });
      setSize({ width: viewport.width, height: viewport.height });
    })();
    return () => {
      cancelled = true;
    };
  }, [pdf, pageNumber, baseWidth, zoom]);

  useEffect(() => {
    if (!visible || rendered) return;
    let cancelled = false;
    (async () => {
      const { page, viewport, scale } = await viewportFor();
      if (cancelled) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      await page.render({ canvasContext: ctx, viewport }).promise;
      if (cancelled) return;

      setRatio(scale);
      setSize({ width: viewport.width, height: viewport.height });
      try {
        const content = await page.getTextContent();
        const result = buildHits(content.items, viewport, matcher);
        setHits(result.hits);
        setBoxes(result.boxes);
      } catch {
        setHits([]);
        setBoxes([]);
      }
      setRendered(true);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, rendered, pageNumber, pdf, baseWidth, zoom]);

  // 术语变化（重新识别）后重算高亮；不重画 canvas
  useEffect(() => {
    if (!rendered) return;
    let cancelled = false;
    (async () => {
      const { viewport } = await viewportFor();
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      if (cancelled) return;
      const result = buildHits(content.items, viewport, matcher);
      setHits(result.hits);
      setBoxes(result.boxes);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terms, rendered, pageNumber, pdf, ratio]);

  return (
    <div className="pdf-page" ref={holderRef} data-page={pageNumber}>
      <div className="pdf-page-no">第 {pageNumber} 页</div>
      <div
        className="pdf-canvas-wrap"
        style={{ width: size.width || undefined, height: size.height || undefined }}
        onMouseDown={handleDown}
        onMouseMove={handleMove}
        onMouseUp={handleUp}
        onMouseLeave={() => setDrag(null)}
      >
        <canvas ref={canvasRef} />
        <div className="pdf-overlay">
          {hits.map((hit, i) => (
            <div
              key={`${hit.term.id}-${i}`}
              className="pdf-hit"
              data-term-id={hit.term.id}
              title={hit.term.zhName ?? hit.term.name}
              style={{ left: hit.left, top: hit.top, width: hit.width, height: hit.height }}
              onClick={(e) => onTermClick(hit.term, e.currentTarget)}
            />
          ))}
        </div>
        {drag ? (
          <div
            className="marquee"
            style={{
              left: Math.min(drag.x1, drag.x2),
              top: Math.min(drag.y1, drag.y2),
              width: Math.abs(drag.x2 - drag.x1),
              height: Math.abs(drag.y2 - drag.y1),
            }}
          />
        ) : null}
      </div>
    </div>
  );
}

export default function PdfReader({ docId, terms, analyzing, onTermClick, onFallback, onSelectText }: Props) {
  const [pdf, setPdf] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [baseWidth, setBaseWidth] = useState(900);
  const [sizes, setSizes] = useState<{ w: number; h: number }[]>([]);
  const stageRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    pdfjs
      .getDocument({ url: apiUrl(`/api/documents/${docId}/file`) })
      .promise.then((loaded: any) => {
        if (!cancelled) setPdf(loaded);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [docId]);

  // 先把每页的原始尺寸量出来，渲染前就能占满高度
  useEffect(() => {
    if (!pdf) return;
    let cancelled = false;
    (async () => {
      const list: { w: number; h: number }[] = [];
      for (let i = 1; i <= pdf.numPages; i += 1) {
        const page = await pdf.getPage(i);
        const viewport = page.getViewport({ scale: 1 });
        list.push({ w: viewport.width, h: viewport.height });
      }
      if (!cancelled) setSizes(list);
    })();
    return () => {
      cancelled = true;
    };
  }, [pdf]);

  // 单页基准宽度：跟随容器，但不超过 900px
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const update = () => setBaseWidth(Math.max(320, Math.min(900, el.clientWidth - 56)));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  if (error) {
    return (
      <div className="stage">
        <div className="paper-empty">
          版式视图加载失败：{error}
          <br />
          <button className="btn" style={{ marginTop: 12 }} onClick={onFallback}>
            切换到文本视图
          </button>
        </div>
      </div>
    );
  }

  if (!pdf) {
    return (
      <div className="stage">
        <div className="paper-empty">
          <span className="spinner" style={{ display: "inline-block", marginBottom: 10 }} />
          <div>正在加载 PDF 版式…</div>
        </div>
      </div>
    );
  }

  return (
    <div className="stage pdf-stage" id="stage" ref={stageRef}>
      {analyzing ? (
        <div className="pdf-analyzing">
          <span className="spinner" />
          正在识别专业术语，完成后正文会自动标注…
        </div>
      ) : null}
      <div className="pdf-pages">
        {Array.from({ length: pdf.numPages }, (_, i) => (
          <PdfPage
            key={`${i + 1}-${zoom}`}
            pdf={pdf}
            pageNumber={i + 1}
            terms={terms}
            baseWidth={baseWidth}
            zoom={zoom}
            intrinsic={sizes[i]}
            onTermClick={onTermClick}
            onSelectText={onSelectText}
          />
        ))}
      </div>

      <div className="zoom-bar">
        <button className="mini" onClick={() => setZoom((z) => Math.max(0.6, Math.round((z - 0.15) * 100) / 100))}>
          −
        </button>
        <span>{Math.round(zoom * 100)}%</span>
        <button className="mini" onClick={() => setZoom((z) => Math.min(2.6, Math.round((z + 0.15) * 100) / 100))}>
          +
        </button>
        <button className="mini" onClick={() => setZoom(1)}>
          适应宽度
        </button>
      </div>
    </div>
  );
}
