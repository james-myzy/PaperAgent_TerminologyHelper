/**
 * 选段解释检查：
 * 1) 文本视图：选中一段 → 操作条 → 解释选段 → 智能体抽屉在左侧打开，消息里带着选段
 * 2) PDF 视图：框选一段 → 操作条 → 解释选段
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { chromium } from "playwright-core";

const BASE = "http://127.0.0.1:8787";
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const here = dirname(fileURLToPath(import.meta.url));

const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox", "--disable-gpu"] });
const page = await browser.newPage({ viewport: { width: 1520, height: 960 } });
const errs = [];
page.on("pageerror", (e) => errs.push(e.message));
page.on("console", (m) => {
  if (m.type() === "error") errs.push(m.text().slice(0, 200));
});

/* ---------- 1. 文本视图：三击选中一段 ---------- */
await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
await page.setInputFiles('input[type="file"]', join(here, "..", "fixtures", "sample-paper.txt"));
await page.locator(".paper h1").waitFor({ timeout: 60000 });
await page.locator(".ball .badge").waitFor({ timeout: 120000 });
await page.waitForTimeout(500);

const para = page.locator(".block-p").nth(1);
await para.click({ clickCount: 3 });
await page.waitForTimeout(400);
const barVisible = await page.locator(".sel-bar").count();
const barText = barVisible ? (await page.locator(".sel-bar").innerText()).replace(/\s+/g, " ") : "";
console.log(`文本视图选中后操作条：${barVisible ? "有" : "无"} · ${barText}`);
await page.screenshot({ path: join(here, "..", "shots", "23-select-bar-text.png") });

if (barVisible) {
  await page.locator(".sel-bar button", { hasText: "解释选段" }).click();
  await page.locator(".sheet.open").waitFor({ timeout: 10000 });
  await page.waitForTimeout(600);
  const sheetBox = await page.locator(".sheet.open").boundingBox();
  const userMsg = await page.locator(".msg.user .bubble").last().innerText();
  console.log(`抽屉位置 x=${Math.round(sheetBox.x)}（左侧应为 0）`);
  console.log(`用户消息前 60 字：${userMsg.replace(/\s+/g, " ").slice(0, 60)}…`);
  console.log(`消息里含选段：${userMsg.includes('"""') ? "是" : "否"}`);
  await page.locator(".send-btn:not(.stop)").waitFor({ timeout: 240000 });
  await page.waitForTimeout(500);
  const answer = await page.locator(".msg.assistant .bubble").last().innerText();
  console.log(`回答长度：${answer.length} 字`);
  await page.screenshot({ path: join(here, "..", "shots", "24-select-explain-text.png") });
}

/* ---------- 2. PDF 视图：框选 ---------- */
const buf = await readFile(join(here, "..", "fixtures", "SkyJEPA.pdf"));
const doc = await (
  await fetch(`${BASE}/api/documents`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream", "X-Filename": encodeURIComponent("SkyJEPA.pdf") },
    body: buf,
  })
).json();
await fetch(`${BASE}/api/documents/${doc.id}/terms`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: "{}",
});

await page.goto(`${BASE}/?doc=${doc.id}`, { waitUntil: "networkidle" });
await page.locator("canvas").first().waitFor({ timeout: 60000 });
await page.waitForTimeout(2200);

const wrap = await page.locator(".pdf-canvas-wrap").first().boundingBox();
const x1 = wrap.x + wrap.width * 0.22;
const x2 = wrap.x + wrap.width * 0.47;
const y1 = wrap.y + wrap.height * 0.42;
const y2 = wrap.y + wrap.height * 0.55;
await page.mouse.move(x1, y1);
await page.mouse.down();
await page.mouse.move(x2, y2, { steps: 12 });
await page.mouse.up();
await page.waitForTimeout(500);

const pdfBar = await page.locator(".sel-bar").count();
const pdfBarText = pdfBar ? (await page.locator(".sel-bar").innerText()).replace(/\s+/g, " ") : "";
console.log(`PDF 框选后操作条：${pdfBar ? "有" : "无"} · ${pdfBarText}`);
await page.screenshot({ path: join(here, "..", "shots", "25-select-bar-pdf.png") });

if (pdfBar) {
  await page.locator(".sel-bar button", { hasText: "解释选段" }).click();
  await page.locator(".sheet.open").waitFor({ timeout: 10000 });
  await page.waitForTimeout(500);
  const userMsg = await page.locator(".msg.user .bubble").last().innerText();
  console.log(`PDF 选段消息前 60 字：${userMsg.replace(/\s+/g, " ").slice(0, 60)}…`);
  await page.locator(".send-btn:not(.stop)").waitFor({ timeout: 240000 });
  await page.waitForTimeout(500);
  const answer = await page.locator(".msg.assistant .bubble").last().innerText();
  console.log(`PDF 回答长度：${answer.length} 字`);
  await page.screenshot({ path: join(here, "..", "shots", "26-select-explain-pdf.png") });
}

await browser.close();
console.log(errs.length ? `页面问题：${errs.slice(0, 5).join(" | ")}` : "无页面错误 ✅");
