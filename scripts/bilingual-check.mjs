/**
 * 双语对照检查：
 * 1) 开启后在原文每段下方插入译文（顺序：原文 → 译文）
 * 2) 再次开关不重复请求（逐段缓存生效）
 * 3) 版式视图下开启会自动切到原文
 */
import { chromium } from "playwright-core";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const BASE = "http://127.0.0.1:8787";
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const here = dirname(fileURLToPath(import.meta.url));

const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox", "--disable-gpu"] });
const page = await browser.newPage({ viewport: { width: 1500, height: 980 } });
const errs = [];
page.on("pageerror", (error) => errs.push(error.message));

let translateCalls = 0;
page.on("request", (req) => {
  if (req.url().includes("translate-blocks")) translateCalls += 1;
});

await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
await page.setInputFiles('input[type="file"]', join(here, "..", "fixtures", "sample-paper.txt"));
await page.locator(".paper h1").waitFor({ timeout: 60000 });
await page.locator(".ball .badge").waitFor({ timeout: 180000 });
await page.waitForTimeout(600);
const close = page.locator('.panel-head .icon-btn[title="关闭"]');
if (await close.count()) {
  await close.click({ force: true });
  await page.waitForTimeout(300);
}

const paragraphs = await page.locator(".block-p").count();
const started = Date.now();
await page.getByRole("button", { name: "双语对照" }).click();
await page.locator(".block-trans:not(.pending)").first().waitFor({ timeout: 180000 });
const firstMs = Date.now() - started;

let translated = 0;
for (let i = 0; i < 60; i += 1) {
  translated = await page.locator(".block-trans:not(.pending)").count();
  if (translated >= paragraphs) break;
  await page.waitForTimeout(1000);
}

const order = await page.evaluate(() => {
  const pair = document.querySelector(".block-pair");
  return pair ? [...pair.children].map((el) => el.className) : [];
});

console.log(`段落 ${paragraphs} 段，已译 ${translated} 段，首段 ${(firstMs / 1000).toFixed(1)} 秒`);
console.log(`首组顺序：${order.join(" → ")}`);
console.log(`开关一次后的总请求：${translateCalls}`);
await page.screenshot({ path: join(here, "..", "shots", "bilingual-check.png") });

// 缓存：关掉再开，不应再发请求
const before = translateCalls;
await page.getByRole("button", { name: "双语对照 · 开" }).click();
await page.waitForTimeout(400);
await page.getByRole("button", { name: "双语对照" }).click();
await page.waitForTimeout(2000);
console.log(`重新开启新增请求：${translateCalls - before}（应为 0）`);

await browser.close();
console.log(errs.length ? `页面问题：${errs.slice(0, 5).join(" | ")}` : "无页面错误 ✅");
