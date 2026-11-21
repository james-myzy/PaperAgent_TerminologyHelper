import React from "react";

/**
 * 极简 Markdown 渲染：只支持模型实际会用的语法（标题、列表、加粗、行内代码），
 * 用 React 元素拼装，不碰 innerHTML，天然免 XSS。
 */

function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const regex = /(\*\*[^*]+\*\*|`[^`]+`|【[^】]+】)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const token = match[0];
    const key = `${keyPrefix}-${index++}`;
    if (token.startsWith("**")) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("`")) {
      nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else {
      nodes.push(
        <strong key={key} style={{ color: "var(--primary-dark)" }}>
          {token}
        </strong>,
      );
    }
    last = match.index + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

export default function Markdown({ text }: { text: string }) {
  const lines = text.split("\n");
  const blocks: React.ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushList = () => {
    if (!list) return;
    const items = list.items.map((item, i) => <li key={i}>{renderInline(item, `li-${i}`)}</li>);
    blocks.push(
      list.ordered ? (
        <ol key={`ol-${blocks.length}`}>{items}</ol>
      ) : (
        <ul key={`ul-${blocks.length}`}>{items}</ul>
      ),
    );
    list = null;
  };

  lines.forEach((raw, i) => {
    const line = raw.trimEnd();
    if (!line.trim()) {
      flushList();
      return;
    }
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      flushList();
      blocks.push(<h3 key={`h-${i}`}>{renderInline(heading[2], `h-${i}`)}</h3>);
      return;
    }
    const ordered = line.match(/^\s*(\d+)[.、)]\s+(.*)$/);
    if (ordered) {
      if (!list || !list.ordered) {
        flushList();
        list = { ordered: true, items: [] };
      }
      list.items.push(ordered[2]);
      return;
    }
    const bullet = line.match(/^\s*[-*·]\s+(.*)$/);
    if (bullet) {
      if (!list || list.ordered) {
        flushList();
        list = { ordered: false, items: [] };
      }
      list.items.push(bullet[1]);
      return;
    }
    flushList();
    blocks.push(<p key={`p-${i}`}>{renderInline(line, `p-${i}`)}</p>);
  });
  flushList();

  return <>{blocks}</>;
}
