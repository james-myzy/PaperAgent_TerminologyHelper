/**
 * 回归：术语面板点击 → 跳转 + 气泡（文本视图 & PDF 版式视图），
 * 以及“正文没有高亮”的词条要就地给解释而不是只报错。
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { chromium } from "playwright-core";

const BASE = "http://127.0.0.1:8787";
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const here = dirname(fileURLToPath(import.meta.url));
const docId = process.env.DOC_ID;
if (!docId) throw new Error("需要 DOC_ID 环境变量");

const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox", "--disable-gpu"] });
const page = await browser.newPage({ viewport: { width: 1520, height: 960 } });
const problems = [];
page.on("pageerror", (e) => problems.push(e.message));
page.on("console", (m) => {
  if (m.type() === "error") problems.push(m.text().slice(0, 160));
});

await page.goto(`${BASE}/?doc=${docId}`, { waitUntil: "networkidle" });
await page.locator("canvas").first().waitFor({ timeout: 60000 });
await page.waitForTimeout(2000);

// 打开术语面板
await page.locator(".ball").click();
await page.locator(".panel.open").waitFor({ timeout: 5000 });
await page.waitForTimeout(300);
const total = await page.locator(".term-item").count();
console.log(`面板术语数：${total}`);

// 点第 6 条（多半在后续页，能验证懒渲染等待逻辑）
const item = page.locator(".term-item").nth(5);
const name = (await item.innerText()).split("\n")[0];
await item.click();
await page.locator(".popover").waitFor({ timeout: 30000 });
await page.locator(".pop-section").first().waitFor({ timeout: 120000 });
await page.waitForTimeout(1500);
const panelOpen = await page.locator(".panel.open").count();
const popText = (await page.locator(".popover").innerText()).replace(/\s+/g, " ").slice(0, 70);
console.log(`点击「${name}」→ 气泡：${popText}…（面板仍开：${panelOpen > 0}）`);
await page.screenshot({ path: join(here, "..", "shots", "17-panel-jump-pdf.png") });

// 找一个“低噪”词条（正文不铺高亮的），验证兜底
await page.keyboard.press("Escape");
await page.locator(".ball").click();
await page.locator(".panel.open").waitFor({ timeout: 5000 });
const lowNoise = page.locator(".term-item", { hasText: "低噪" }).first();
if (await lowNoise.count()) {
  const lname = (await lowNoise.innerText()).split("\n")[0];
  await lowNoise.click();
  await page.locator(".popover").waitFor({ timeout: 20000 });
  await page.waitForTimeout(800);
  const toast = await page.locator(".toast").innerText().catch(() => "");
  console.log(`低噪词条「${lname}」→ 气泡正常，提示：${toast}`);
  await page.screenshot({ path: join(here, "..", "shots", "18-low-noise.png") });
} else {
  console.log("没有低噪词条可测");
}

await browser.close();
console.log(problems.length ? `页面问题：${problems.slice(0, 5).join(" | ")}` : "无 console / page 错误 ✅");
