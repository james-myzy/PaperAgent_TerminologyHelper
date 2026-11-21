import { useEffect, useRef, useState } from "react";
import type { DocPayload } from "../api";
import Markdown from "./Markdown";

export interface ToolRun {
  id: string;
  name: string;
  status: "running" | "ok" | "fail";
  summary?: string;
  ms?: number;
}

export interface ChatMsg {
  id: string;
  role: "user" | "assistant";
  text: string;
  tools?: ToolRun[];
  streaming?: boolean;
}

interface Props {
  open: boolean;
  doc: DocPayload | null;
  messages: ChatMsg[];
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSend: (text: string) => void;
  onStop: () => void;
}

const TOOL_LABELS: Record<string, string> = {
  document_overview: "读文档概览",
  read_document: "精读正文",
  search_document: "文中检索",
  extract_terms: "识别术语",
  explain_term: "术语详解",
  translate_document: "翻译",
  export_highlighted_docx: "导出 Word",
  list_terms: "术语表",
};

export default function AgentSheet({
  open,
  doc,
  messages,
  busy,
  error,
  onClose,
  onSend,
  onStop,
}: Props) {
  const [value, setValue] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, busy, open]);

  const submit = () => {
    const text = value.trim();
    if (!text || busy) return;
    setValue("");
    onSend(text);
  };

  const quick = doc
    ? ["整篇讲什么？三点总结", "把方法一节翻成中文", "这篇论文的局限是什么", "导出高亮 Word"]
    : ["先上传一篇论文"];

  return (
    <aside className={`sheet ${open ? "open" : ""}`} aria-hidden={!open}>
      <div className="sheet-head">
        <span style={{ fontSize: 15, color: "var(--primary)" }}>✦</span>
        <div>
          <div className="sheet-title">智能体</div>
          <div className="sheet-sub">会自己读文档、调工具、给结论</div>
        </div>
        <div className="spacer" />
        <button className="icon-btn" onClick={onClose} title="收起">
          ✕
        </button>
      </div>

      <div className="msgs" ref={scrollRef}>
        {messages.length === 0 ? (
          <div style={{ padding: "28px 12px", color: "var(--muted)", fontSize: 12.5, lineHeight: 2 }}>
            问它整篇的贡献、方法细节、某个术语为什么这么理解；
            <br />
            也可以让它翻译某一段、导出带高亮的 Word。
          </div>
        ) : null}

        {messages.map((msg) => (
          <div className={`msg ${msg.role}`} key={msg.id}>
            <div className="avatar">{msg.role === "user" ? "我" : "AI"}</div>
            <div className="bubble">
              {msg.tools?.map((tool) => (
                <div className="tool-row" key={tool.id}>
                  <span className={`tick ${tool.status === "fail" ? "fail" : ""}`}>
                    {tool.status === "running" ? "·" : tool.status === "fail" ? "!" : "✓"}
                  </span>
                  <b>{tool.name}</b>
                  <span>{TOOL_LABELS[tool.name] ?? ""}</span>
                  {tool.status === "running" ? <span className="spinner" /> : null}
                  {tool.ms ? <span className="ms">{(tool.ms / 1000).toFixed(1)}s</span> : null}
                </div>
              ))}
              {msg.text ? <Markdown text={msg.text} /> : null}
              {msg.streaming && !msg.text ? (
                <span className="typing"><i /><i /><i /></span>
              ) : null}
            </div>
          </div>
        ))}
      </div>

      {error ? (
        <div style={{ padding: "8px 14px", color: "var(--warn)", fontSize: 12, background: "#fff5ef" }}>
          {error}
        </div>
      ) : null}

      <div className="sheet-composer">
        <div className="quick-row">
          {quick.map((q) => (
            <button className="quick" key={q} disabled={busy} onClick={() => onSend(q)}>
              {q}
            </button>
          ))}
        </div>
        <div className="composer-row">
          <textarea
            value={value}
            rows={1}
            placeholder={doc ? "继续问这篇论文…" : "先上传论文"}
            onChange={(e) => {
              setValue(e.target.value);
              e.target.style.height = "auto";
              e.target.style.height = `${Math.min(120, e.target.scrollHeight)}px`;
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
          />
          {busy ? (
            <button className="send-btn stop" onClick={onStop}>
              停止
            </button>
          ) : (
            <button className="send-btn" onClick={submit} disabled={!value.trim()}>
              发送
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}
