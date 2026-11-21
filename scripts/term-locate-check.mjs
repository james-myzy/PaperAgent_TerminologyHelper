/**
 * 术语「顺序 + 可定位率」检查：
 * 1) 侧边栏顺序 = 文章内出现顺序
 * 2) 点术语能滚到对应位置并闪烁高亮（PDF 版式视图）
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { chromium } from "playwright-core";

const BASE = "http://127.0.0.1:8787";
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const here = dirname(fileURLToPath(import.meta.url));
const pdfPath = process.env.PDF_PATH ?? join(here, "..", "fixtures", "SkyJEPA.pdf");

const buf = await readFile(pdfPath);
const doc = await (
  await fetch(`${BASE}/api/documents`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream", "X-Filename": encodeURIComponent("SkyJEPA.pdf") },
    body: buf,
  })
).json();
const terms = await (
  await fetch(`${BASE}/api/documents/${doc.id}/terms`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  })
).json();
console.log(`文档 ${doc.pages.length} 页 / ${doc.charCount} 字；术语 ${terms.terms.length} 个`);

// 期望顺序：页码 + 页内字符位置（单字母/ASCII 词按词边界，和应用内一致）
function firstOffset(text, name) {
  const lower = text.toLowerCase();
  const needle = name.toLowerCase();
  if (!/^[a-z0-9][a-z0-9\-+.#/]*$/i.test(name)) return lower.indexOf(needle);
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`\\b${escaped}\\b`, "i").exec(text);
  return match ? match.index : -1;
}

const pageText = new Map(doc.pages.map((p) => [p.page, p.text]));
const sorted = terms.terms
  .map((t) => {
    const firstPage = t.pages?.[0];
    const text = firstPage ? pageText.get(firstPage) ?? "" : "";
    const offset = firstPage ? firstOffset(text, t.name) : -1;
    return {
      name: t.name,
      page: firstPage ?? Infinity,
      offset: offset === -1 ? Infinity : offset,
      highlight: t.highlight !== false,
    };
  })
  .sort((a, b) => {
    if (a.page !== b.page) return a.page - b.page;
    if (a.offset !== b.offset) return a.offset - b.offset;
    if (a.name.length !== b.name.length) return b.name.length - a.name.length;
    return a.name.localeCompare(b.name);
  });

const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox", "--disable-gpu"] });
const page = await browser.newPage({ viewport: { width: 1520, height: 960 } });
const errs = [];
page.on("pageerror", (e) => errs.push(e.message));

await page.goto(`${BASE}/?doc=${doc.id}`, { waitUntil: "networkidle" });
await page.locator("canvas").first().waitFor({ timeout: 60000 });
await page.waitForTimeout(1800);

await page.locator(".ball").click({ force: true });
await page.locator(".panel.open").waitFor();
await page.waitForTimeout(500);

const shown = (await page.locator(".term-name").allInnerTexts()).slice(0, 8).map((s) => s.split("\n")[0].trim());
console.log("期望：", sorted.slice(0, 8).map((e) => e.name).join(" | "));
console.log("面板：", shown.join(" | "));
const orderOk = sorted.slice(0, 8).every((e, i) => shown[i]?.startsWith(e.name.slice(0, 16)));
console.log(`顺序一致：${orderOk ? "✅" : "❌"}`);
await page.screenshot({ path: join(here, "..", "shots", "20-term-order.png") });

// 点击前 10 个术语，统计能否定位
const results = [];
for (let i = 0; i < 10; i += 1) {
  if (!(await page.locator(".panel.open").count())) {
    await page.locator(".ball").click({ force: true });
    await page.locator(".panel.open").waitFor({ timeout: 5000 });
    await page.waitForTimeout(350);
  }
  const item = page.locator(".term-item").nth(i);
  const name = (await item.locator(".term-name").innerText()).split("\n")[0].trim();
  await item.click();
  await page.locator(".popover").waitFor({ timeout: 20000 });
  const flashed = await page.locator(".pdf-hit.flash").count();
  results.push({ name, located: flashed > 0 });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
}
console.table(results);
const located = results.filter((r) => r.located).length;
console.log(`可定位：${located} / ${results.length}`);
await page.screenshot({ path: join(here, "..", "shots", "22-locate-coverage.png") });

await browser.close();
console.log(errs.length ? `页面错误：${errs.join(" | ")}` : "无页面错误 ✅");
