import { useMemo, useState } from "react";
import type { Term } from "../api";

export function TermBall({
  count,
  open,
  onClick,
}: {
  count: number;
  open: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`ball ${open ? "hidden" : ""}`}
      onClick={onClick}
      aria-label="打开术语汇总"
    >
      <span className="icon">✦</span>
      <span className="label">术语</span>
      {count > 0 ? <span className="badge">{count > 99 ? "99+" : count}</span> : null}
    </button>
  );
}

interface PanelProps {
  open: boolean;
  terms: Term[];
  activeTermId?: string | null;
  analyzing: boolean;
  onClose: () => void;
  onSelect: (term: Term, el: HTMLElement) => void;
  onRefresh: () => void;
  onAdd: (payload: { name: string; zhName?: string; brief?: string }) => Promise<boolean>;
  onDelete: (term: Term) => void;
}

export function TermPanel({
  open,
  terms,
  activeTermId,
  analyzing,
  onClose,
  onSelect,
  onRefresh,
  onAdd,
  onDelete,
}: PanelProps) {
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ name: "", zhName: "", brief: "" });

  // 顺序由上层按「文章出现顺序」排好，这里不再重排，保证编号与全文顺序一致
  const ordered = terms;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return ordered;
    return ordered.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        (t.zhName ?? "").includes(query.trim()) ||
        t.brief.toLowerCase().includes(q),
    );
  }, [ordered, query]);

  const submit = async () => {
    const name = form.name.trim();
    if (!name || saving) return;
    setSaving(true);
    const ok = await onAdd({
      name,
      zhName: form.zhName.trim() || undefined,
      brief: form.brief.trim() || undefined,
    });
    setSaving(false);
    if (ok) {
      setForm({ name: "", zhName: "", brief: "" });
      setAdding(false);
    }
  };

  return (
    <aside className={`panel ${open ? "open" : ""}`} aria-hidden={!open}>
      <div className="panel-head">
        <span className="panel-title">术语汇总</span>
        <span className="panel-count">{terms.length}</span>
        <div className="spacer" />
        <button
          className="icon-btn"
          onClick={() => setAdding((v) => !v)}
          title="添加自定义术语"
          aria-label="添加术语"
        >
          ＋
        </button>
        <button className="icon-btn" onClick={onRefresh} disabled={analyzing} title="重新识别术语">
          {analyzing ? <span className="spinner" /> : "⟳"}
        </button>
        <button className="icon-btn" onClick={onClose} title="关闭">
          ✕
        </button>
      </div>

      <div className="panel-search">
        <div className="search-box">
          <span style={{ color: "var(--muted)", fontSize: 13 }}>⌕</span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索术语 / 中文名 / 释义…"
            autoFocus={open}
          />
          {query ? (
            <button className="icon-btn" onClick={() => setQuery("")} title="清空">
              ✕
            </button>
          ) : null}
        </div>
      </div>

      {adding ? (
        <div className="term-add">
          <input
            autoFocus
            className="term-add-input"
            placeholder="术语，必填（如 attention mechanism）"
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
              if (e.key === "Escape") setAdding(false);
            }}
          />
          <input
            className="term-add-input"
            placeholder="中文名，可选"
            value={form.zhName}
            onChange={(e) => setForm((f) => ({ ...f, zhName: e.target.value }))}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
            }}
          />
          <input
            className="term-add-input"
            placeholder="一句话解释，可选（留空会自动生成）"
            value={form.brief}
            onChange={(e) => setForm((f) => ({ ...f, brief: e.target.value }))}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
            }}
          />
          <div className="term-add-actions">
            <span className="term-add-hint">加完会在正文里立刻高亮</span>
            <button className="mini" onClick={() => setAdding(false)}>
              取消
            </button>
            <button className="mini primary" onClick={submit} disabled={!form.name.trim() || saving}>
              {saving ? "添加中…" : "添加"}
            </button>
          </div>
        </div>
      ) : null}

      <div className="panel-body">
        {analyzing && terms.length === 0 ? (
          <div style={{ padding: "36px 16px", textAlign: "center", color: "var(--muted)", fontSize: 12.5 }}>
            <span className="spinner" style={{ display: "inline-block", marginBottom: 8 }} />
            <div>正在识别术语：词库扫描 + 语义抽取…</div>
          </div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: "36px 16px", textAlign: "center", color: "var(--muted)", fontSize: 12.5 }}>
            {terms.length === 0 ? "这篇文档还没有识别到术语" : "没有匹配的术语"}
          </div>
        ) : (
          filtered.map((term) => {
            const index = ordered.findIndex((t) => t.id === term.id);
            return (
              <div
                key={term.id}
                className={`term-item ${activeTermId === term.id ? "active" : ""}`}
                onClick={(e) => onSelect(term, e.currentTarget)}
              >
                <span className="term-no">N° {String(index + 1).padStart(2, "0")}</span>
                <span className="term-main">
                  <span className="term-name">
                    {term.name}
                    {term.source === "自定义" ? (
                      <span className="term-tag custom">自定义</span>
                    ) : term.highlight === false ? (
                      <span
                        className="term-tag"
                        title="代码/配置类词条，保留在术语表但不铺满正文高亮"
                      >
                        低噪
                      </span>
                    ) : null}
                  </span>
                  {term.zhName ? <span className="term-zh">　{term.zhName}</span> : null}
                  <div className="term-brief">{term.brief}</div>
                </span>
                <span className="term-side">
                  {term.pages?.length ? `${term.pages[0]} 页` : "文内无"}
                </span>
                <button
                  className="term-del"
                  title="从术语表移除"
                  aria-label={`删除 ${term.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(term);
                  }}
                >
                  ×
                </button>
              </div>
            );
          })
        )}
      </div>

      <div className="panel-foot">
        <div style={{ fontSize: 10.5, color: "var(--muted)", lineHeight: 1.7 }}>
          点条目跳到正文首个出现处 · 右上「＋」添加自己的术语 · 行尾「×」移除
        </div>
      </div>
    </aside>
  );
}
