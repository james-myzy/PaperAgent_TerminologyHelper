import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  addCustomTerm,
  deleteTerm,
  explainPassageStream,
  exportDocx,
  extractTerms,
  fetchConfig,
  fetchDocument,
  saveSettings,
  streamChat,
  translateBlocksStream,
  uploadDocument,
  uploadText,
  type DocPayload,
  type ServerConfig,
  type Term,
} from "./api";
import Reader from "./components/Reader";
import PdfReader from "./components/PdfReader";
import TermPopover from "./components/TermPopover";
import { TermBall, TermPanel } from "./components/TermPanel";
import AgentSheet, { type ChatMsg, type ToolRun } from "./components/AgentSheet";
import FindBar from "./components/FindBar";

const uid = () => Math.random().toString(36).slice(2, 10);

/** pdf = 版式视图（原样渲染 PDF），orig = 文本流视图（原文，可开双语对照） */
type View3 = "pdf" | "orig";

interface ActiveTerm {
  term: Term;
  el: HTMLElement;
}

/** 页内首次出现位置；单字母/ASCII 词用词边界，避免 "g" 命中 "Learning" */
function firstOffset(text: string, name: string): number {
  const lower = text.toLowerCase();
  const needle = name.toLowerCase();
  if (!/^[a-z0-9][a-z0-9\-+.#/]*$/i.test(name)) return lower.indexOf(needle);
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`\\b${escaped}\\b`, "i").exec(text);
  return match ? match.index : -1;
}

export default function App() {
  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [keyEditing, setKeyEditing] = useState(false);
  const [keyInput, setKeyInput] = useState("");
  const [savingKey, setSavingKey] = useState(false);
  const [doc, setDoc] = useState<DocPayload | null>(null);
  const [view, setView] = useState<"home" | "reader">("home");
  const [mode, setMode] = useState<View3>("orig");

  const [uploading, setUploading] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  /** 双语对照：原文一段 + 译文一段 */
  const [bilingual, setBilingual] = useState(false);
  const [blockTrans, setBlockTrans] = useState<Record<string, string>>({});
  const [transProgress, setTransProgress] = useState<{ done: number; total: number } | null>(null);
  const [exporting, setExporting] = useState(false);

  const [active, setActive] = useState<ActiveTerm | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);

  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [busy, setBusy] = useState(false);
  const [agentError, setAgentError] = useState<string | null>(null);

  const [toast, setToast] = useState<{ text: string; link?: string } | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteValue, setPasteValue] = useState("");
  const [findOpen, setFindOpen] = useState(false);
  const [selection, setSelection] = useState<{
    text: string;
    page?: number;
    x: number;
    y: number;
    below: boolean;
  } | null>(null);

  const docRef = useRef<DocPayload | null>(null);
  docRef.current = doc;
  const agentAbort = useRef<AbortController | null>(null);
  const translateAbort = useRef<AbortController | null>(null);
  /** 选段解释的本地缓存：同一段再点一次连请求都不发 */
  const passageCache = useRef(new Map<string, string>());

  /** 换文档时统一收口：写入 doc、恢复已缓存的逐段译文 */
  const applyDoc = useCallback((payload: DocPayload) => {
    setDoc(payload);
    docRef.current = payload;
    const seeded: Record<string, string> = {};
    for (const [key, value] of Object.entries(payload.blockTranslations ?? {})) {
      if (value?.text) seeded[key] = value.text;
    }
    setBlockTrans(seeded);
    return seeded;
  }, []);

  useEffect(() => {
    fetchConfig().then(setConfig).catch(() => setConfig(null));
  }, []);

  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("doc");
    if (!id) return;
    fetchDocument(id)
      .then((payload) => {
        if (!payload) return;
        applyDoc(payload);
        setView("reader");
        setMode(payload.hasFile && payload.kind === "pdf" ? "pdf" : "orig");
      })
      .catch(() => {
        /* 文档过期就留在首页 */
      });
  }, [applyDoc]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 6000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  // Ctrl/⌘ + F 打开论文内搜索
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f" && view === "reader") {
        e.preventDefault();
        setFindOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view]);

  /* ------------------------------ 模型设置 ------------------------------ */

  const handleSaveKey = useCallback(async () => {
    const value = keyInput.trim();
    if (!value || savingKey) return;
    setSavingKey(true);
    try {
      const updated = await saveSettings({ apiKey: value });
      setConfig(updated);
      setKeyInput("");
      setKeyEditing(false);
      setToast({
        text: updated.hasKey ? `已保存，当前模型 ${updated.model}` : "已保存",
      });
    } catch (error) {
      setToast({ text: `保存失败：${(error as Error).message}` });
    } finally {
      setSavingKey(false);
    }
  }, [keyInput, savingKey]);

  const handleClearKey = useCallback(async () => {
    if (savingKey) return;
    setSavingKey(true);
    try {
      const updated = await saveSettings({ apiKey: "" });
      setConfig(updated);
      setToast({ text: "已清除 Key，回到离线演示模式" });
    } catch (error) {
      setToast({ text: `清除失败：${(error as Error).message}` });
    } finally {
      setSavingKey(false);
    }
  }, [savingKey]);

  /* ------------------------------ 术语识别 ------------------------------ */

  const runAnalyze = useCallback(async (documentId: string) => {
    setAnalyzing(true);
    try {
      const result = await extractTerms(documentId);
      setDoc((prev) => (prev && prev.id === documentId ? { ...prev, terms: result.terms } : prev));
      if (result.terms.length === 0) {
        setToast({ text: "没有识别到专业术语，可以换个文档试试" });
      } else {
        // 上传后自动展开术语面板，读者不用再去点悬浮球
        setPanelOpen(true);
        setToast({ text: `已自动识别 ${result.terms.length} 个术语，点正文高亮可看解释` });
      }
    } catch (error) {
      setToast({ text: `术语识别失败：${(error as Error).message}` });
    } finally {
      setAnalyzing(false);
    }
  }, []);

  /* ------------------------------ 术语增删 ------------------------------ */

  const handleAddTerm = useCallback(
    async (payload: { name: string; zhName?: string; brief?: string }) => {
      if (!doc) return false;
      try {
        const result = await addCustomTerm(doc.id, payload);
        setDoc((prev) => (prev ? { ...prev, terms: result.terms } : prev));
        setToast({ text: `已添加「${result.added.name}」，正文里已高亮` });
        return true;
      } catch (error) {
        setToast({ text: `添加失败：${(error as Error).message}` });
        return false;
      }
    },
    [doc],
  );

  const handleDeleteTerm = useCallback(
    async (term: Term) => {
      if (!doc) return;
      try {
        const result = await deleteTerm(doc.id, term.id);
        setDoc((prev) => (prev ? { ...prev, terms: result.terms } : prev));
        setActive((prev) => (prev?.term.id === term.id ? null : prev));
        setToast({ text: `已从术语表移除「${term.name}」` });
      } catch (error) {
        setToast({ text: `删除失败：${(error as Error).message}` });
      }
    },
    [doc],
  );

  /* ------------------------------ 上传 ------------------------------ */

  const loadFile = useCallback(
    async (file: File) => {
      if (uploading) return;
      setUploading(true);
      try {
        const parsed = await uploadDocument(file);
        applyDoc(parsed);
        setView("reader");
        setMode(parsed.hasFile && parsed.kind === "pdf" ? "pdf" : "orig");
        setActive(null);
        setMessages([]);
        window.scrollTo({ top: 0 });
        document.getElementById("stage")?.scrollTo({ top: 0 });
        await runAnalyze(parsed.id);
      } catch (error) {
        setToast({ text: (error as Error).message });
      } finally {
        setUploading(false);
      }
    },
    [applyDoc, runAnalyze, uploading],
  );

  const loadPaste = useCallback(async () => {
    const text = pasteValue.trim();
    if (!text) return;
    setPasteOpen(false);
    setPasteValue("");
    setUploading(true);
    try {
      const parsed = await uploadText(text, "粘贴的正文");
      applyDoc(parsed);
      setView("reader");
      setMode("orig");
      setMessages([]);
      await runAnalyze(parsed.id);
    } catch (error) {
      setToast({ text: (error as Error).message });
    } finally {
      setUploading(false);
    }
  }, [pasteValue, runAnalyze]);

  /* ------------------------------ 术语交互 ------------------------------ */

  /**
   * 术语按「文章内出现顺序」排：
   * 先看首次出现的页，再看该页里的字符位置；两样都拿不到的排最后。
   * 这样侧边栏的顺序 = 你从头读到尾遇到它们的顺序，编号 N° 01/02… 也对得上。
   */
  const sortedTerms = useMemo(() => {
    const pageText = new Map<number, string>();
    for (const page of doc?.pages ?? []) pageText.set(page.page, page.text.toLowerCase());

    const rank = (term: Term) => {
      const firstPage = term.pages?.[0];
      if (!firstPage) return { page: Number.POSITIVE_INFINITY, offset: Number.POSITIVE_INFINITY };
      const text = pageText.get(firstPage) ?? "";
      const offset = firstOffset(text, term.name);
      return { page: firstPage, offset: offset === -1 ? Number.POSITIVE_INFINITY : offset };
    };

    return [...(doc?.terms ?? [])].sort((a, b) => {
      const ra = rank(a);
      const rb = rank(b);
      if (ra.page !== rb.page) return ra.page - rb.page;
      if (ra.offset !== rb.offset) return ra.offset - rb.offset;
      // 同一位置开始的父串/子串（Long-Horizon World Models vs long-horizon）：长的排前面
      if (a.name.length !== b.name.length) return b.name.length - a.name.length;
      return a.name.localeCompare(b.name);
    });
  }, [doc?.terms, doc?.pages]);

  const activeIndex = active ? sortedTerms.findIndex((t) => t.id === active.term.id) : -1;

  const openTerm = useCallback((term: Term, el: HTMLElement) => {
    setActive({ term, el });
  }, []);

  /**
   * 从术语面板跳到正文：文本视图找 <mark>，PDF 版式视图找覆盖层矩形。
   *
   * 两个坑：
   * 1) PDF 页是懒渲染的，目标页可能还没画出来 —— 滚过去等矩形出现；
   * 2) 短术语常被更长的术语"吃掉"（world models 在标题里属于 Long-Horizon World Models，
   *    长词优先匹配后短词不会单独有高亮），所以要把该术语出现过的每一页都试一遍。
   */
  const jumpToTerm = useCallback(
    async (term: Term, panelAnchor?: HTMLElement) => {
      const selector = `mark[data-term-id="${term.id}"], .pdf-hit[data-term-id="${term.id}"]`;
      const find = () => document.querySelector<HTMLElement>(selector);
      let el = find();

      if (!el && term.highlight !== false) {
        const pages = term.pages?.slice(0, 4) ?? [];
        for (const page of pages) {
          const pageEl = document.querySelector<HTMLElement>(`[data-page="${page}"]`);
          pageEl?.scrollIntoView({ behavior: "smooth", block: "start" });
          for (let i = 0; i < 9 && !el; i += 1) {
            await new Promise((resolve) => setTimeout(resolve, 150));
            el = find();
          }
          if (el) break;
        }
      }

      // 自己没铺高亮时，退一步用"包含它的更长术语"的位置（neural network 之于 recurrent neural network）
      if (!el) {
        const longer = sortedTerms.find(
          (t) =>
            t.id !== term.id &&
            t.name.length > term.name.length &&
            t.name.toLowerCase().includes(term.name.toLowerCase()) &&
            document.querySelector(`mark[data-term-id="${t.id}"], .pdf-hit[data-term-id="${t.id}"]`),
        );
        if (longer) {
          el = document.querySelector<HTMLElement>(
            `mark[data-term-id="${longer.id}"], .pdf-hit[data-term-id="${longer.id}"]`,
          );
        }
      }

      if (el) {
        // 平滑滚动 + 懒渲染可能让位置二次变化，滚两次并留出稳定时间再弹气泡
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        await new Promise((resolve) => setTimeout(resolve, 420));
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        await new Promise((resolve) => setTimeout(resolve, 260));
        el.classList.add("flash");
        window.setTimeout(() => el.classList.remove("flash"), 1200);
        openTerm(term, el as HTMLElement);
        return true;
      }

      // 正文里确实没有铺高亮（低噪词条 / 被长术语完全覆盖）：就地弹出解释，别只报错
      if (panelAnchor) {
        openTerm(term, panelAnchor);
        setToast({ text: `「${term.name}」未在正文铺高亮，解释已就地展开` });
      } else {
        setToast({ text: `正文里没找到「${term.name}」的高亮` });
      }
      return false;
    },
    [openTerm],
  );

  /* --------------------------- 双语对照（逐段翻译） --------------------------- */

  /** 逐段翻译整篇：结果边生成边插入原文下方，同一段只翻译一次 */
  const startTranslate = useCallback(async (documentId: string, force = false) => {
    if (translateAbort.current) return;
    const controller = new AbortController();
    translateAbort.current = controller;
    setTransProgress({ done: 0, total: 0 });
    try {
      await translateBlocksStream(
        documentId,
        undefined,
        (event) => {
          if (event.type === "start") {
            setTransProgress({ done: 0, total: Number(event.total ?? 0) });
          }
          if (event.type === "progress") {
            setTransProgress({
              done: Number(event.done ?? 0),
              total: Number(event.total ?? 0),
            });
          }
          if (event.type === "block") {
            const key = `${Number(event.page)}:${Number(event.index)}`;
            const text = String(event.text ?? "");
            if (text) setBlockTrans((prev) => ({ ...prev, [key]: text }));
          }
          if (event.type === "error") setToast({ text: `翻译失败：${event.message}` });
        },
        controller.signal,
        { force },
      );
    } catch (error) {
      if ((error as Error).name !== "AbortError") {
        setToast({ text: `翻译失败：${(error as Error).message}` });
      }
    } finally {
      translateAbort.current = null;
      setTransProgress(null);
    }
  }, []);

  const toggleBilingual = useCallback(() => {
    const next = !bilingual;
    setBilingual(next);
    // 版式视图不能插入译文，开启时自动切到原文
    if (next && mode === "pdf") setMode("orig");
    if (next && doc && Object.keys(blockTrans).length === 0 && !translateAbort.current) {
      void startTranslate(doc.id);
    }
  }, [bilingual, blockTrans, doc, mode, startTranslate]);

  const switchMode = useCallback((next: View3) => {
    setMode(next);
    setActive(null);
  }, []);

  /* ------------------------------ 导出 ------------------------------ */

  const handleExport = useCallback(async () => {
    if (!doc || exporting) return;
    setExporting(true);
    try {
      const result = await exportDocx(doc.id);
      setToast({ text: `已生成：${result.filename}（${result.terms} 个术语高亮）`, link: result.url });
      const a = document.createElement("a");
      a.href = result.url;
      a.download = result.filename;
      a.click();
    } catch (error) {
      setToast({ text: `导出失败：${(error as Error).message}` });
    } finally {
      setExporting(false);
    }
  }, [doc, exporting]);

  /* ------------------------------ 智能体 ------------------------------ */

  const handleAgentEvent = useCallback((assistantId: string, event: Record<string, unknown>) => {
    const patch = (updater: (msg: ChatMsg) => ChatMsg) =>
      setMessages((prev) => prev.map((m) => (m.id === assistantId ? updater(m) : m)));

    switch (event.type) {
      case "delta":
        patch((m) => ({ ...m, text: m.text + String(event.text ?? "") }));
        break;
      case "tool":
        patch((m) => ({
          ...m,
          tools: [
            ...(m.tools ?? []),
            { id: String(event.id), name: String(event.name), status: "running" as const },
          ],
        }));
        break;
      case "tool_result":
        patch((m) => ({
          ...m,
          tools: (m.tools ?? []).map((t) =>
            t.id === event.id
              ? {
                  ...t,
                  status: event.ok ? ("ok" as const) : ("fail" as const),
                  summary: String(event.summary ?? ""),
                }
              : t,
          ),
        }));
        break;
      case "state": {
        setDoc((prev) =>
          prev
            ? {
                ...prev,
                terms: (event.terms as Term[]) ?? prev.terms,
                details: { ...prev.details, ...((event.details as Record<string, string>) ?? {}) },
                translations: {
                  ...prev.translations,
                  ...((event.translations as Record<string, string>) ?? {}),
                },
              }
            : prev,
        );
        break;
      }
      case "error":
        setAgentError(String(event.message ?? "智能体运行失败"));
        break;
      case "done":
        patch((m) => ({ ...m, text: m.text || String(event.text ?? ""), streaming: false }));
        break;
      default:
        break;
    }
  }, []);

  const send = useCallback(
    async (text: string) => {
      const content = text.trim();
      if (!content || busy) return;
      setAgentError(null);
      setBusy(true);

      const userMsg: ChatMsg = { id: uid(), role: "user", text: content };
      const assistantId = uid();
      const history = [...messages, userMsg]
        .filter((m) => m.text.trim())
        .map((m) => ({ role: m.role, content: m.text }));
      setMessages((prev) => [
        ...prev,
        userMsg,
        { id: assistantId, role: "assistant", text: "", tools: [], streaming: true },
      ]);

      const controller = new AbortController();
      agentAbort.current = controller;
      try {
        await streamChat(
          { documentId: docRef.current?.id ?? null, messages: history },
          (event) => handleAgentEvent(assistantId, event as Record<string, unknown>),
          controller.signal,
        );
      } catch (error) {
        if ((error as Error).name !== "AbortError") setAgentError((error as Error).message);
      } finally {
        agentAbort.current = null;
        setBusy(false);
        setMessages((prev) =>
          prev.map((m) => (m.id === assistantId ? { ...m, streaming: false } : m)),
        );
      }
    },
    [busy, handleAgentEvent, messages],
  );

  const askAgent = useCallback(
    (question: string) => {
      setSheetOpen(true);
      setPanelOpen(false);
      void send(question);
    },
    [send],
  );

  /* ------------------------------ 选段解释 ------------------------------ */

  // 文本视图：浏览器原生选中 → 弹操作条
  useEffect(() => {
    if (view !== "reader") return;
    const onUp = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) return;
      const text = sel.toString().replace(/\s+/g, " ").trim();
      if (text.length < 4) return;
      const range = sel.getRangeAt(0);
      const node = range.commonAncestorContainer;
      const el =
        (node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as HTMLElement)) ?? null;
      if (!el?.closest(".paper")) return; // 只在正文里生效
      const rect = range.getBoundingClientRect();
      const pageEl = el.closest("[data-page]") as HTMLElement | null;
      setSelection({
        text: text.slice(0, 1200),
        page: pageEl?.dataset.page ? Number(pageEl.dataset.page) : undefined,
        x: rect.left + rect.width / 2,
        y: rect.top,
        below: rect.top < 90,
      });
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelection(null);
    };
    document.addEventListener("mouseup", onUp);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mouseup", onUp);
      document.removeEventListener("keydown", onKey);
    };
  }, [view]);

  // PDF 视图：框选，文字与矩形由 PdfReader 算好
  const handleSelectFromPdf = useCallback(
    (text: string, page: number, rect: { left: number; top: number; width: number; height: number }) => {
      setSelection({
        text: text.slice(0, 1200),
        page,
        x: rect.left + rect.width / 2,
        y: rect.top,
        below: rect.top < 90,
      });
    },
    [],
  );

  /**
   * 选段解释：走专用接口 + 服务端缓存（同一段只问一次模型），
   * 结果直接流进智能体抽屉，但不用工具循环，便宜且快。
   */
  const explainSelection = useCallback(
    async (force = false) => {
    if (!selection || !doc) return;
    const { text, page } = selection;
    const where = page ? `（第 ${page} 页）` : "";
    const question = `请解释这一段${where}：\n\n"""${text}"""`;
    setSelection(null);
    window.getSelection()?.removeAllRanges();
    setSheetOpen(true);
    setPanelOpen(false);
    setAgentError(null);

    const cacheKey = `${page ?? 0}|${text}`;
    const cachedText = force ? undefined : passageCache.current.get(cacheKey);
    if (cachedText) {
      // 本地已经解释过：直接回放，不发任何请求
      setMessages((prev) => [
        ...prev,
        { id: uid(), role: "user", text: question },
        { id: uid(), role: "assistant", text: cachedText, tools: [], streaming: false },
      ]);
      setToast({ text: "这一段之前解释过，直接用了本地缓存（Shift+点击可重新生成）" });
      return;
    }
    if (force) passageCache.current.delete(cacheKey);

    setBusy(true);
    const assistantId = uid();
    setMessages((prev) => [
      ...prev,
      { id: uid(), role: "user", text: question },
      { id: assistantId, role: "assistant", text: "", tools: [], streaming: true },
    ]);

    const patch = (fn: (msg: ChatMsg) => ChatMsg) =>
      setMessages((prev) => prev.map((m) => (m.id === assistantId ? fn(m) : m)));

    const controller = new AbortController();
    agentAbort.current = controller;
    try {
      await explainPassageStream(
        doc.id,
        { text, page, force },
        (event) => {
          if (event.type === "delta") {
            patch((m) => ({ ...m, text: m.text + String(event.text ?? "") }));
          }
          if (event.type === "done") {
            const finalText = String(event.text ?? "");
            patch((m) => ({ ...m, text: m.text || finalText }));
            if (finalText) passageCache.current.set(cacheKey, finalText);
            if (event.cached) setToast({ text: "这一段之前解释过，服务端直接回了缓存" });
          }
          if (event.type === "error") setAgentError(String(event.message ?? "选段解释失败"));
        },
        controller.signal,
      );
    } catch (error) {
      if ((error as Error).name !== "AbortError") setAgentError((error as Error).message);
    } finally {
      agentAbort.current = null;
      setBusy(false);
      patch((m) => ({ ...m, streaming: false }));
    }
    },
    [doc, selection],
  );

  const translateSelection = useCallback(() => {
    if (!selection) return;
    askAgent(`把下面这段话翻译成中文（术语保留英文原名）：\n\n"""${selection.text}"""`);
    setSelection(null);
    window.getSelection()?.removeAllRanges();
  }, [askAgent, selection]);

  /* ------------------------------ 渲染 ------------------------------ */

  const modelPill = config
    ? config.provider === "mock"
      ? "离线演示"
      : config.model
    : "未连接";

  return (
    <div className={`app-root ${sheetOpen ? "sheet-open" : ""}`} style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <header className="head">
        <div className="brand" onClick={() => setView("home")}>
          <div className="brand-mark">透</div>
          <div className="brand-text">
            <div className="brand-title">术语透视</div>
            <div className="brand-sub">不替你读论文，只让你读得更懂</div>
          </div>
        </div>

        {doc && view === "reader" ? (
          <div className="head-doc">
            <strong title={doc.filename}>{doc.title}</strong>
            <span className="meta">
              {doc.pageCount} 页 · {doc.terms.length} 术语
            </span>
          </div>
        ) : null}

        <div className="spacer" />

        {doc && view === "reader" ? (
          <>
            <div className="seg">
              {doc.kind === "pdf" && doc.hasFile ? (
                <button className={mode === "pdf" ? "on" : ""} onClick={() => switchMode("pdf")}>
                  版式
                </button>
              ) : null}
              <button className={mode === "orig" ? "on" : ""} onClick={() => switchMode("orig")}>
                原文
              </button>
            </div>
            <button
              className={`btn ${bilingual ? "on" : ""}`}
              onClick={toggleBilingual}
              title="在原文每段下面插入对应的中文译文"
            >
              {bilingual ? "双语对照 · 开" : "双语对照"}
            </button>
            <button
              className="btn"
              onClick={() => {
                if (mode === "pdf") {
                  switchMode("orig");
                  setToast({ text: "版式视图暂不支持全文检索，已切到文本视图" });
                }
                setFindOpen(true);
              }}
            >
              论文内搜索
            </button>
            <button className="btn" onClick={() => askAgent("给我整篇论文的三点总结")}>
              让智能体总结
            </button>
            <button className="btn primary" onClick={handleExport} disabled={exporting}>
              {exporting ? "导出中…" : "导出高亮 Word"}
            </button>
          </>
        ) : (
          <span className="brand-sub" style={{ fontSize: 11 }}>
            模型 {modelPill}
          </span>
        )}
      </header>

      {view === "home" || !doc ? (
        <main
          className="home"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const file = e.dataTransfer.files?.[0];
            if (file) void loadFile(file);
          }}
        >
          <div className="hero">
            <div className="hero-copy">
              <div className="eyebrow">AI 阅读层 · 术语透视</div>
              <h1>
                把论文交给 <em>一层透视</em>
              </h1>
              <p className="tagline">
                原文完整保留，术语标黄。点一下就着地解释，右侧悬浮球收着全文术语 ——
                读完还停在原文里，不用跳出去查。
              </p>

              <label className="dropzone">
                <input
                  type="file"
                  accept=".pdf,.docx,.txt,.md"
                  hidden
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void loadFile(file);
                    e.target.value = "";
                  }}
                />
                <div className="dz-icon">↑</div>
                <strong>{uploading ? "正在解析…" : "点击上传，或把文件拖到这里"}</strong>
                <small>支持 PDF / DOCX / TXT / MD，单文件 ≤ 60MB</small>
              </label>

              <div className="home-actions">
                <button className="btn" onClick={() => setPasteOpen(true)}>
                  没有文件？粘贴正文
                </button>
                <span style={{ fontSize: 11, color: "var(--muted)" }}>
                  {config?.provider === "mock" ? "离线演示模式" : `模型 ${modelPill}`}
                </span>
              </div>

              <div className="settings-card">
                <div className="settings-row">
                  <span className="settings-label">模型</span>
                  {config?.managed ? (
                    <>
                      <span className="settings-status ok">由 DeepSeek Harness 提供</span>
                      <span className="settings-status">{config.model}</span>
                    </>
                  ) : config?.hasKey ? (
                    <span className="settings-status ok">已配置 {config.keyMask}</span>
                  ) : (
                    <span className="settings-status warn">未配置 · 离线演示</span>
                  )}
                  {config?.managed ? null : (
                    <button className="mini" onClick={() => setKeyEditing((v) => !v)}>
                      {keyEditing ? "收起" : config?.hasKey ? "更换" : "填写"}
                    </button>
                  )}
                  {config?.managed ? null : config?.hasKey ? (
                    <button className="mini" onClick={handleClearKey} disabled={savingKey}>
                      清除
                    </button>
                  ) : null}
                </div>
                {keyEditing && !config?.managed ? (
                  <div className="settings-edit">
                    <input
                      type="password"
                      autoFocus
                      value={keyInput}
                      placeholder={config?.hasKey ? "输入新的 Key 覆盖当前的…" : "sk-..."}
                      onChange={(e) => setKeyInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void handleSaveKey();
                        if (e.key === "Escape") setKeyEditing(false);
                      }}
                    />
                    <button
                      className="mini primary"
                      onClick={handleSaveKey}
                      disabled={savingKey || !keyInput.trim()}
                    >
                      {savingKey ? "保存中…" : "保存"}
                    </button>
                  </div>
                ) : null}
                <div className="settings-hint">
                  {config?.managed
                    ? "模型调用直接走 Harness 里已经配好的模型，这里不需要填 Key。"
                    : "保存后写入本机 .env，下次打开仍记得；留空清除则回到离线演示模式。"}
                </div>
              </div>

              <ul className="hero-points">
                <li>
                  <i>◆</i>
                  <span>
                    <b>原文不动</b>　只加一层高亮与解释，不改写、不摘要
                  </span>
                </li>
                <li>
                  <i>◆</i>
                  <span>
                    <b>点了就懂</b>　贴着这段话的上下文解释，300 字内
                  </span>
                </li>
                <li>
                  <i>◆</i>
                  <span>
                    <b>随时回收</b>　悬浮球收着全文术语，点一下跳回原句
                  </span>
                </li>
              </ul>
            </div>

            <div className="preview" aria-hidden="true">
              <div className="preview-card">
                <div className="p-title">
                  SkyJEPA: Learning Long-Horizon World Models for Zero-Shot Sim-to-Real Control of
                  Quadrotors
                </div>
                <div className="p-authors">Rao · Zhang · Balestriero · LeCun · Loianno</div>
                <p>
                  Accurate dynamics models are critical for informed decision-making in robotic
                  systems. Neural network dynamics models are attractive, but existing predictive
                  approaches struggle with long-horizon forecasting because their{" "}
                  <mark className="term" style={{ cursor: "default" }}>
                    autoregressive rollout
                  </mark>{" "}
                  mechanism amplifies errors over time.
                </p>
                <p>
                  <mark className="term" style={{ cursor: "default" }}>
                    Joint Embedding Predictive Architectures
                  </mark>{" "}
                  offer a compelling alternative by modeling dynamics in latent space, yet prior
                  methods have been studied primarily for kinematic-level planning.
                </p>
              </div>
              <div className="preview-ball">
                <b>57</b>术语
              </div>
              <div className="preview-pop">
                <div>
                  <span className="name">autoregressive rollout</span>
                  <span className="zh">自回归展开</span>
                </div>
                <div className="label">上下文释义</div>
                <p className="text">
                  把上一步的预测当作下一步输入，反复外推。误差随步数累积放大 ——
                  这正是本文要替换掉的长程预测方式。
                </p>
              </div>
              <div className="preview-note">点高亮词 → 就地解释（示意）</div>
            </div>
          </div>
        </main>
      ) : mode === "pdf" && doc.kind === "pdf" && doc.hasFile ? (
        <PdfReader
          docId={doc.id}
          terms={doc.terms}
          analyzing={analyzing}
          onTermClick={openTerm}
          onFallback={() => switchMode("orig")}
          onSelectText={handleSelectFromPdf}
        />
      ) : (
        <Reader
          doc={doc}
          bilingual={bilingual}
          blockTrans={blockTrans}
          transProgress={transProgress}
          activeTermId={active?.term.id ?? null}
          onTermClick={openTerm}
          onHome={() => {
            setView("home");
            setActive(null);
          }}
          onExport={handleExport}
          exporting={exporting}
          analyzing={analyzing}
          onOpenAgent={() => setSheetOpen(true)}
        />
      )}

      {doc && view === "reader" ? (
        <>
          <TermBall count={doc.terms.length} open={panelOpen} onClick={() => setPanelOpen(true)} />
          <TermPanel
            open={panelOpen}
            terms={sortedTerms}
            activeTermId={active?.term.id ?? null}
            analyzing={analyzing}
            onClose={() => setPanelOpen(false)}
            onSelect={async (term, el) => {
              const found = await jumpToTerm(term, el);
              if (found) setPanelOpen(false);
            }}
            onRefresh={() => runAnalyze(doc.id)}
            onAdd={handleAddTerm}
            onDelete={(term) => void handleDeleteTerm(term)}
          />
          {active ? (
            <TermPopover
              key={active.term.id}
              doc={doc}
              term={active.term}
              index={activeIndex}
              anchor={active.el}
              rightBound={panelOpen ? window.innerWidth - 404 : undefined}
              cachedDetail={
                doc.details?.[active.term.id] ??
                doc.details?.[active.term.name] ??
                undefined
              }
              onClose={() => setActive(null)}
              onAskAgent={askAgent}
              onExplainDone={(key, text) =>
                setDoc((prev) =>
                  prev ? { ...prev, details: { ...prev.details, [key]: text } } : prev,
                )
              }
            />
          ) : null}
        </>
      ) : null}

      <button
        className={`fab ${sheetOpen ? "hidden" : ""}`}
        onClick={() => setSheetOpen(true)}
        title="打开智能体"
      >
        ✦
      </button>

      {findOpen && view === "reader" ? <FindBar onClose={() => setFindOpen(false)} /> : null}

      <AgentSheet
        open={sheetOpen}
        doc={doc}
        messages={messages}
        busy={busy}
        error={agentError}
        onClose={() => setSheetOpen(false)}
        onSend={(text) => void send(text)}
        onStop={() => {
          agentAbort.current?.abort();
          agentAbort.current = null;
          setBusy(false);
        }}
      />

      {selection ? (
        <div
          className="sel-bar"
          style={{
            left: Math.max(12, Math.min(selection.x - 150, window.innerWidth - 392)),
            top: selection.below ? selection.y + 14 : Math.max(12, selection.y - 46),
          }}
          onMouseDown={(e) => e.preventDefault()}
        >
          <button onClick={(e) => void explainSelection(e.shiftKey)} title="按住 Shift 点击可强制重新生成">
            解释选段
          </button>
          <button onClick={translateSelection}>翻译</button>
          <button
            onClick={() => {
              navigator.clipboard?.writeText(selection.text);
              setToast({ text: "已复制选段" });
              setSelection(null);
            }}
          >
            复制
          </button>
          <span className="sel-hint">
            {selection.page ? `第 ${selection.page} 页 · ` : ""}
            {selection.text.length} 字
          </span>
        </div>
      ) : null}

      {toast ? (
        <div className="toast">
          {toast.text}
          {toast.link ? (
            <>
              {" "}
              <a href={toast.link} download>
                下载
              </a>
            </>
          ) : null}
        </div>
      ) : null}

      {pasteOpen ? (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(14,42,56,0.42)",
            display: "grid",
            placeItems: "center",
            zIndex: 90,
            padding: 20,
          }}
          onClick={() => setPasteOpen(false)}
        >
          <div
            style={{
              width: "min(680px, 100%)",
              background: "#fff",
              borderRadius: 14,
              padding: 18,
              display: "flex",
              flexDirection: "column",
              gap: 12,
              boxShadow: "var(--shadow-lg)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="brand-title" style={{ fontSize: 15 }}>
              粘贴论文正文
            </div>
            <textarea
              autoFocus
              value={pasteValue}
              onChange={(e) => setPasteValue(e.target.value)}
              placeholder="把论文正文粘贴到这里，按空行分段…"
              style={{
                minHeight: 240,
                resize: "vertical",
                border: "1px solid var(--line-strong)",
                borderRadius: 10,
                padding: 12,
                font: "inherit",
                fontSize: 13,
                lineHeight: 1.7,
                color: "var(--ink)",
                outline: "none",
              }}
            />
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button className="btn" onClick={() => setPasteOpen(false)}>
                取消
              </button>
              <button className="btn primary" onClick={loadPaste} disabled={!pasteValue.trim()}>
                解析并识别术语
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
