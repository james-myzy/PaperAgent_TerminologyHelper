/**
 * 术语解释缓存检查：
 * 1) 第一次点术语 → 请求 /explain
 * 2) 关掉再点同一个 → 不再请求（前端缓存）
 * 3) 刷新页面后再点 → 仍不请求（服务端 details 缓存）
 * 4) 点另一个术语 → 照常请求
 * 5) 直接打接口第二次，服务端回 cached:true
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

let explainCalls = 0;
page.on("request", (req) => {
  if (req.url().includes("/explain")) explainCalls += 1;
});

await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
await page.setInputFiles('input[type="file"]', join(here, "..", "fixtures", "sample-paper.txt"));
await page.locator(".paper h1").waitFor({ timeout: 60000 });
await page.locator(".ball .badge").waitFor({ timeout: 180000 });
await page.waitForTimeout(500);
// 上传后会自动展开面板，先关掉免得挡住正文
if (await page.locator(".panel.open").count()) {
  await page.locator('.panel-head .icon-btn[title="关闭"]').click({ force: true });
  await page.waitForTimeout(300);
}

const docId = (await (await fetch(`${BASE}/api/documents`)).json()).documents[0].id;
const marks = page.locator("mark.term");
const firstName = await marks.nth(2).innerText();

// 1) 第一次点（等流式结束，确认缓存已写入）
await marks.nth(2).click();
await page.locator(".pop-section").first().waitFor({ timeout: 120000 });
await page.waitForFunction(() => !document.querySelector(".popover .typing"), { timeout: 120000 });
await page.waitForTimeout(600);
const afterFirst = explainCalls;
console.log(`第一次点「${firstName}」→ 请求数 ${afterFirst}`);
await page.screenshot({ path: join(here, "..", "shots", "32-explain-first.png") });

// 2) 关掉再点同一个
await page.keyboard.press("Escape");
await page.waitForTimeout(300);
await marks.nth(2).click();
await page.locator(".pop-section").first().waitFor({ timeout: 20000 });
await page.waitForTimeout(800);
const afterSecond = explainCalls;
const badge = await page.locator(".pop-cache").count();
console.log(`第二次点同一个 → 请求数 ${afterSecond}（应等于 ${afterFirst}），缓存标记=${badge > 0 ? "有" : "无"}`);
await page.screenshot({ path: join(here, "..", "shots", "33-explain-cached.png") });

// 3) 刷新后再点
await page.goto(`${BASE}/?doc=${docId}`, { waitUntil: "networkidle" });
await page.locator(".paper h1").waitFor({ timeout: 60000 });
await page.waitForTimeout(1200);
const beforeReloadClick = explainCalls;
await page.locator("mark.term").nth(2).click();
await page.locator(".pop-section").first().waitFor({ timeout: 30000 });
await page.waitForTimeout(800);
console.log(`刷新后再点 → 请求数 ${explainCalls}（刷新前 ${beforeReloadClick}，应不变）`);

// 4) 点另一个术语
await page.keyboard.press("Escape");
await page.waitForTimeout(200);
const other = page.locator("mark.term").nth(20);
await other.click();
await page.locator(".pop-section").first().waitFor({ timeout: 120000 });
await page.waitForTimeout(800);
console.log(`点另一个术语 → 请求数 ${explainCalls}（应 +1）`);

// 5) 直接打接口两次
const doc = await (await fetch(`${BASE}/api/documents/${docId}`)).json();
const term = doc.terms[3];
const readSse = async () => {
  const res = await fetch(`${BASE}/api/documents/${docId}/explain`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ term: term.name }),
  });
  const text = await res.text();
  const cached = text.includes('"cached":true');
  return { cached, events: text.split("\n\n").length };
};
const firstCall = await readSse();
const secondCall = await readSse();
console.log(`接口调用：「${term.name}」第一次 cached=${firstCall.cached}，第二次 cached=${secondCall.cached}`);

await browser.close();
console.log(errs.length ? `页面问题：${errs.slice(0, 5).join(" | ")}` : "无页面错误 ✅");
