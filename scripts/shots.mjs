/**
 * UI 验证脚本：用本机 Chrome 打开页面、走一轮真实交互、截图。
 * 需要浏览器进程（沙箱内无法创建管道），因此只在验证时手动运行。
 */
import { readFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { chromium } from "playwright-core";

const BASE = "http://127.0.0.1:8787";
const CHROME = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "shots");
mkdirSync(outDir, { recursive: true });

const text = await readFile(join(here, "..", "fixtures", "sample-paper.txt"), "utf8");
const upload = await fetch(`${BASE}/api/documents`, {
  method: "POST",
  headers: { "Content-Type": "application/octet-stream", "X-Filename": encodeURIComponent("sample-paper.txt") },
  body: text,
});
const doc = await upload.json();
if (!upload.ok) throw new Error(`上传失败：${JSON.stringify(doc)}`);
console.log(`文档：${doc.title} / ${doc.pages.length} 段`);

const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox", "--disable-gpu"] });
const page = await browser.newPage({ viewport: { width: 1520, height: 960 } });

const problems = [];
page.on("console", (msg) => {
  if (msg.type() === "error") problems.push(`console: ${msg.text()}`);
});
page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));

await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
await page.waitForTimeout(600);
await page.screenshot({ path: join(outDir, "01-empty.png") });
console.log("截图 01-empty.png");

await page.goto(`${BASE}/?doc=${doc.id}`, { waitUntil: "networkidle" });
await page.waitForTimeout(600);
await page.locator(".tab", { hasText: "文档" }).click();
await page.screenshot({ path: join(outDir, "02-doc.png") });
console.log("截图 02-doc.png");

await page.fill(".input-row textarea", "这篇论文的主要贡献是什么？用三点说明，然后把正文里的专业术语识别出来。");
await page.click(".send-btn");
await page.locator(".send-btn:not(.stop)").waitFor({ timeout: 240000 });
await page.waitForTimeout(500);
await page.screenshot({ path: join(outDir, "03-chat.png") });
console.log("截图 03-chat.png");

await page.locator(".tab", { hasText: "术语" }).click();
await page.waitForTimeout(400);
await page.screenshot({ path: join(outDir, "04-terms.png") });
console.log("截图 04-terms.png");

const explainBtn = page.locator(".mini-btn", { hasText: "让智能体解释" }).first();
if (await explainBtn.count()) {
  await explainBtn.click();
  await page.locator(".send-btn:not(.stop)").waitFor({ timeout: 240000 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(outDir, "05-explain.png") });
  console.log("截图 05-explain.png");
}

await page.fill(".input-row textarea", "把这一段翻译成中文");
await page.click(".send-btn");
await page.locator(".send-btn:not(.stop)").waitFor({ timeout: 240000 });
await page.waitForTimeout(400);
await page.locator(".tab", { hasText: "译文" }).click();
await page.waitForTimeout(300);
await page.screenshot({ path: join(outDir, "06-translate.png") });
console.log("截图 06-translate.png");

await page.fill(".input-row textarea", "导出术语高亮的 Word 文档");
await page.click(".send-btn");
await page.locator(".send-btn:not(.stop)").waitFor({ timeout: 240000 });
await page.waitForTimeout(600);
await page.locator(".tab", { hasText: "术语" }).click();
await page.screenshot({ path: join(outDir, "07-export.png") });
console.log("截图 07-export.png");

const downloadText = await page.locator(".export-row").innerText().catch(() => "");
console.log(`导出区文本：${downloadText.replace(/\s+/g, " ")}`);

await browser.close();
console.log(problems.length ? `\n发现前端错误：\n${problems.join("\n")}` : "\n前端无 console/page 错误 ✅");
