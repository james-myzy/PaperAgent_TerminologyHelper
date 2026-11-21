/**
 * 真实中文长篇 PDF 的稳健性检查：解析块结构、识别术语、正文高亮、气泡
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { chromium } from "playwright-core";

const BASE = process.env.BASE ?? "http://127.0.0.1:8787";
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const here = dirname(fileURLToPath(import.meta.url));
const pdf = process.env.PDF_PATH ?? "D:/dsh_program/C程序设计第二次作业_预览.pdf";

const buf = await readFile(pdf);
const t0 = Date.now();
const up = await fetch(`${BASE}/api/documents`, {
  method: "POST",
  headers: { "Content-Type": "application/octet-stream", "X-Filename": encodeURIComponent(pdf.split("/").pop()) },
  body: buf,
});
const doc = await up.json();
if (!up.ok) throw new Error(JSON.stringify(doc));
console.log(
  `解析：${doc.title.slice(0, 30)} · ${doc.pages.length} 页 · ${doc.charCount} 字 · ${((Date.now() - t0) / 1000).toFixed(1)}s`,
);
console.log(`首页块结构：${doc.pages[0].blocks.map((b) => b.type).join(",")}`);
console.log(`首块：${doc.pages[0].blocks[0]?.text.slice(0, 60)}`);

const t1 = Date.now();
const terms = await (
  await fetch(`${BASE}/api/documents/${doc.id}/terms`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  })
).json();
console.log(`术语：${terms.terms.length} 个 · ${((Date.now() - t1) / 1000).toFixed(1)}s`);
console.log(`示例：${terms.terms.slice(0, 8).map((t) => t.name).join(" / ")}`);

const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox", "--disable-gpu"] });
const page = await browser.newPage({ viewport: { width: 1520, height: 960 } });
const errs = [];
page.on("pageerror", (e) => errs.push(e.message));
await page.goto(`${BASE}/?doc=${doc.id}`, { waitUntil: "networkidle" });
await page.waitForTimeout(1200);
const marks = await page.locator("mark.term").count();
const blocks = await page.locator(".block-p").count();
console.log(`页面渲染：${blocks} 段 / ${marks} 处高亮`);
await page.screenshot({ path: join(here, "..", "shots", "07-pdf-reader.png") });

if (marks > 0) {
  const mark = page.locator("mark.term").nth(4);
  await mark.click();
  await page.locator(".popover").waitFor({ timeout: 20000 });
  await page.waitForTimeout(2500);
  const txt = (await page.locator(".popover").innerText()).replace(/\s+/g, " ");
  console.log(`气泡：${txt.slice(0, 100)}…`);
  await page.screenshot({ path: join(here, "..", "shots", "08-pdf-popover.png") });
}

await browser.close();
console.log(errs.length ? `页面错误：${errs.join("; ")}` : "无页面错误 ✅");
