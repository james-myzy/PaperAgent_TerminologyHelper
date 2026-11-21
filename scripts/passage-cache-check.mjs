/**
 * 选段解释缓存检查：同一段只请求一次模型，重复选中直接回放。
 */
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

let passageCalls = 0;
let chatCalls = 0;
page.on("request", (req) => {
  if (req.url().includes("/explain-passage")) passageCalls += 1;
  if (req.url().endsWith("/api/chat")) chatCalls += 1;
});

await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
await page.setInputFiles('input[type="file"]', join(here, "..", "fixtures", "sample-paper.txt"));
await page.locator(".paper h1").waitFor({ timeout: 60000 });
await page.locator(".ball .badge").waitFor({ timeout: 180000 });
await page.waitForTimeout(500);
if (await page.locator(".panel.open").count()) {
  await page.locator('.panel-head .icon-btn[title="关闭"]').click({ force: true });
  await page.waitForTimeout(300);
}

const pickParagraph = async (index) => {
  await page.locator(".block-p").nth(index).click({ clickCount: 3 });
  await page.waitForTimeout(300);
  await page.locator(".sel-bar button", { hasText: "解释选段" }).click();
  await page.locator(".send-btn:not(.stop)").waitFor({ timeout: 180000 });
  await page.waitForTimeout(500);
  return (await page.locator(".msg.assistant .bubble").last().innerText()).replace(/\s+/g, " ");
};

// 1) 第一次选第 1 段
const a1 = await pickParagraph(1);
console.log(`第一次选段 → passage 请求 ${passageCalls}，chat 请求 ${chatCalls}，回答 ${a1.length} 字`);
await page.screenshot({ path: join(here, "..", "shots", "34-passage-first.png") });

// 关掉抽屉，重新选同一段
await page.locator(".sheet-head .icon-btn").click({ force: true });
await page.waitForTimeout(300);
const a2 = await pickParagraph(1);
console.log(`第二次选同一段 → passage 请求 ${passageCalls}（应仍为 1），回答 ${a2.length} 字，与第一次一致=${a1 === a2}`);
const toast = await page.locator(".toast").innerText().catch(() => "");
console.log(`提示：${toast.replace(/\s+/g, " ")}`);
await page.screenshot({ path: join(here, "..", "shots", "35-passage-cached.png") });

// 2) 选另一段
await page.locator(".sheet-head .icon-btn").click({ force: true });
await page.waitForTimeout(300);
await pickParagraph(2);
console.log(`选另一段 → passage 请求 ${passageCalls}（应为 2），chat 请求 ${chatCalls}（应仍为 0）`);

// 3) 双语对照开关不影响选段解释的请求数；再次开启命中缓存不再请求
await page.locator(".sheet-head .icon-btn").click({ force: true });
await page.waitForTimeout(300);
let translateCalls = 0;
page.on("request", (req) => {
  if (req.url().includes("translate-blocks")) translateCalls += 1;
});
const before = passageCalls;
await page.getByRole("button", { name: "双语对照" }).click();
await page.locator(".block-trans:not(.pending)").first().waitFor({ timeout: 180000 });
const firstCalls = translateCalls;
await page.getByRole("button", { name: "双语对照 · 开" }).click();
await page.waitForTimeout(400);
await page.getByRole("button", { name: "双语对照" }).click();
await page.waitForTimeout(2000);
console.log(
  `双语对照：首次请求 ${firstCalls} 次；再开关一次新增 ${translateCalls - firstCalls} 次（应为 0）；选段请求 ${passageCalls}（不受影响）`,
);

await browser.close();
console.log(errs.length ? `页面问题：${errs.slice(0, 5).join(" | ")}` : "无页面错误 ✅");
