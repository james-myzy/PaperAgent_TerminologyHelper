/**
 * PDF 版式视图检查：上传真实论文 → 页面按原版式渲染 → 覆盖术语高亮层 → 点高亮出气泡
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { chromium } from "playwright-core";

const BASE = process.env.BASE ?? "http://127.0.0.1:8787";
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const here = dirname(fileURLToPath(import.meta.url));
const pdfPath = process.env.PDF_PATH ?? join(here, "..", "fixtures", "SkyJEPA.pdf");

const buf = await readFile(pdfPath);
const t0 = Date.now();
const up = await fetch(`${BASE}/api/documents`, {
  method: "POST",
  headers: {
    "Content-Type": "application/octet-stream",
    "X-Filename": encodeURIComponent(pdfPath.split(/[\\/]/).pop()),
  },
  body: buf,
});
const doc = await up.json();
if (!up.ok) throw new Error(JSON.stringify(doc));
console.log(`上传：${doc.title.slice(0, 46)}… · ${doc.pages.length} 页 · ${doc.charCount} 字 · hasFile=${doc.hasFile} · ${((Date.now() - t0) / 1000).toFixed(1)}s`);

const t1 = Date.now();
const terms = await (
  await fetch(`${BASE}/api/documents/${doc.id}/terms`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  })
).json();
console.log(`术语：${terms.terms.length} 个 · ${((Date.now() - t1) / 1000).toFixed(1)}s`);

const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox", "--disable-gpu"] });
const page = await browser.newPage({ viewport: { width: 1520, height: 960 } });
const errs = [];
page.on("pageerror", (e) => errs.push(`pageerror: ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error") errs.push(`console: ${m.text().slice(0, 200)}`);
});

await page.goto(`${BASE}/?doc=${doc.id}`, { waitUntil: "networkidle" });
await page.locator("canvas").first().waitFor({ timeout: 60000 });
await page.waitForTimeout(2500);

const canvasSize = await page.locator("canvas").first().evaluate((c) => ({ w: c.width, h: c.height, cw: c.clientWidth }));
const hitCount = await page.locator(".pdf-hit").count();
const pageCount = await page.locator(".pdf-page").count();
console.log(`渲染：${pageCount} 页容器 · 首页 canvas ${canvasSize.w}×${canvasSize.h}（显示宽 ${canvasSize.cw}）· 首页高亮 ${hitCount} 处`);
await page.screenshot({ path: join(here, "..", "shots", "10-pdf-layout.png") });

// 点第一个高亮
if (hitCount > 0) {
  const hit = page.locator(".pdf-hit").first();
  const termId = await hit.getAttribute("data-term-id");
  await hit.click();
  await page.locator(".popover").waitFor({ timeout: 20000 });
  await page.locator(".pop-section").first().waitFor({ timeout: 120000 });
  await page.waitForTimeout(1200);
  const text = (await page.locator(".popover").innerText()).replace(/\s+/g, " ");
  console.log(`气泡（${termId}）：${text.slice(0, 90)}…`);
  await page.screenshot({ path: join(here, "..", "shots", "11-pdf-popover.png") });
}

// 滚到第 3 页看懒渲染
await page.evaluate(() => {
  const pages = document.querySelectorAll(".pdf-page");
  pages[2]?.scrollIntoView({ behavior: "instant", block: "start" });
});
await page.waitForTimeout(3000);
const rendered = await page.locator("canvas").count();
console.log(`懒渲染后的 canvas 数：${rendered}`);
await page.screenshot({ path: join(here, "..", "shots", "12-pdf-page3.png") });

await browser.close();
console.log(errs.length ? `页面问题：\n${errs.slice(0, 6).join("\n")}` : "无 console / page 错误 ✅");
