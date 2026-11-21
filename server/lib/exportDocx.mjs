/**
 * 带术语高亮的 Word 导出（对应原应用「导出带黄色高亮 Word」能力）。
 *
 * 原应用基于 MinerU 解析包在客户端重建带排版、表格、图片的 docx；
 * 本机版以解析出的正文为基础重建段落结构，并把命中的术语就地打上
 * w:highlight=yellow，保证「正文 + 术语注释 + 术语表」三件套完整。
 */
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
} from "docx";
import { segmentText } from "./termMatch.mjs";

function pageParagraphs(page, terms) {
  const blocks = [];
  for (const rawLine of page.text.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const segments = segmentText(line, terms);
    blocks.push(
      new Paragraph({
        spacing: { after: 120, line: 320 },
        children: segments.map(
          (seg) =>
            new TextRun({
              text: seg.text,
              highlight: seg.term ? "yellow" : undefined,
            }),
        ),
      }),
    );
  }
  return blocks;
}

export async function buildHighlightedDocx(doc) {
  const terms = doc.terms ?? [];
  const stamp = new Date().toISOString().slice(0, 10);
  const children = [
    new Paragraph({
      text: doc.title || "未命名文档",
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 240 },
      children: [
        new TextRun({
          text: `术语高亮版 · 共 ${doc.pages.length} 段 · 标注 ${terms.length} 个术语 · ${stamp}`,
          size: 18,
          color: "666666",
        }),
      ],
    }),
  ];

  for (const page of doc.pages) {
    children.push(
      new Paragraph({
        text: `第 ${page.page} 部分`,
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 240, after: 120 },
      }),
    );
    children.push(...pageParagraphs(page, terms));
  }

  if (terms.length) {
    children.push(
      new Paragraph({
        text: "附录：术语表",
        heading: HeadingLevel.HEADING_1,
        spacing: { before: 360, after: 180 },
      }),
    );
    for (const term of terms) {
      const label = term.zhName ? `${term.name}（${term.zhName}）` : term.name;
      children.push(
        new Paragraph({
          spacing: { after: 100 },
          children: [
            new TextRun({ text: `${label}：`, bold: true, highlight: "yellow" }),
            new TextRun({ text: term.brief || "" }),
          ],
        }),
      );
    }
  }

  const document = new Document({
    creator: "paper-agent",
    title: doc.title,
    description: "由论文术语分析智能体导出的术语高亮版本",
    styles: {
      default: {
        document: {
          run: { font: "Times New Roman", size: 22 },
        },
      },
    },
    sections: [{ children }],
  });

  return Packer.toBuffer(document);
}

export function exportFilename(title) {
  const safe = String(title || "论文")
    .replace(/[\\/:*?"<>|\n\r\t]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 36) || "论文";
  const stamp = new Date().toISOString().slice(0, 10);
  return `${safe}_术语高亮_${stamp}.docx`;
}
