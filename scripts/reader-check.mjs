/**
 * 阅读器回归：上传 → 自动识别术语 → 点术语出气泡 → 悬浮球术语面板 → 译文 → 智能体抽屉
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright-core";

const BASE = process.env.BASE ?? "http://127.0.0.1:8787";
const CHROME = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "shots");
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox", "--disable-gpu"] });
const page = await browser.newPage({ viewport: { width: 1520, height: 960 } });
const problems = [];
page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error") problems.push(`console: ${m.text()}`);
});

await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
await page.screenshot({ path: join(out, "01-home.png") });
console.log("截图 01-home.png");

// 上传样例论文
await page.setInputFiles('input[type="file"]', join(here, "..", "fixtures", "sample-paper.txt"));
await page.locator(".paper h1").waitFor({ timeout: 120000 });
await page.locator(".ball .badge").waitFor({ timeout: 240000 });
const termCount = await page.locator(".ball .badge").innerText();
console.log(`术语识别完成：${termCount} 个`);
await page.waitForTimeout(600);
await page.screenshot({ path: join(out, "02-reader.png") });
console.log("截图 02-reader.png");

// 点正文高亮 → 气泡
const mark = page.locator("mark.term").nth(2);
const termName = await mark.innerText();
await mark.click();
await page.locator(".popover").waitFor({ timeout: 30000 });
await page.locator(".pop-section").first().waitFor({ timeout: 120000 });
await page.waitForTimeout(1200);
const popText = (await page.locator(".popover").innerText()).replace(/\s+/g, " ");
console.log(`气泡（${termName}）：${popText.slice(0, 90)}…`);
await page.screenshot({ path: join(out, "03-popover.png") });
console.log("截图 03-popover.png");

await page.keyboard.press("Escape");
await page.waitForTimeout(200);

// 论文内搜索（Ctrl+F）
await page.keyboard.press("Control+f");
await page.locator('input[placeholder="在论文中查找…"]').waitFor({ timeout: 5000 });
await page.fill('input[placeholder="在论文中查找…"]', "attention");
await page.waitForTimeout(400);
const findCount = await page.locator("text=/\\d+ \\/ \\d+/").first().innerText().catch(() => "");
console.log(`论文内搜索命中：${findCount}`);
await page.screenshot({ path: join(out, "09-find.png") });
await page.keyboard.press("Escape");

// 术语面板（上传后会自动展开，没开就点悬浮球）
if (!(await page.locator(".panel.open").count())) {
  await page.locator(".ball").click();
}
await page.locator(".panel.open").waitFor({ timeout: 5000 });
await page.waitForTimeout(400);
await page.screenshot({ path: join(out, "04-terms.png") });
console.log("截图 04-terms.png");

// 面板里点条目 → 跳回正文并弹解释
await page.locator(".term-item").nth(1).click();
await page.waitForTimeout(900);
const hasPopover = await page.locator(".popover").count();
console.log(`面板跳转后气泡数量：${hasPopover}`);

// 双语对照：原文一段 + 译文一段
await page.keyboard.press("Escape");
await page.waitForTimeout(300);
await page.getByRole("button", { name: "双语对照" }).click();
await page.locator(".block-trans:not(.pending)").first().waitFor({ timeout: 180000 });
await page.waitForTimeout(2500);
const transCount = await page.locator(".block-trans:not(.pending)").count();
const pairOrder = await page.evaluate(() => {
  const pair = document.querySelector(".block-pair");
  return pair ? [...pair.children].map((el) => el.className) : [];
});
console.log(`双语对照：已译 ${transCount} 段，首组顺序 ${pairOrder.join(" → ")}`);
await page.screenshot({ path: join(out, "05-bilingual.png") });
console.log("截图 05-bilingual.png");

// 智能体抽屉
await page.locator(".fab").click();
await page.locator(".sheet.open").waitFor({ timeout: 5000 });
await page.fill(".composer-row textarea", "这篇论文的三点贡献是什么？");
await page.locator(".send-btn:not(.stop)").first().click();
await page.locator(".send-btn:not(.stop)").waitFor({ timeout: 240000 });
await page.waitForTimeout(600);
await page.screenshot({ path: join(out, "06-agent.png") });
console.log("截图 06-agent.png");

await browser.close();
console.log(problems.length ? `\n前端问题：\n${problems.slice(0, 8).join("\n")}` : "\n无 console / page 错误 ✅");
