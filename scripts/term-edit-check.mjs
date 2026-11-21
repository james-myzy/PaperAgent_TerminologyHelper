/**
 * 术语自定义：删除 / 添加 / 重新识别后仍生效
 * UI 走一遍，最终以接口返回的数据为准做断言。
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
page.on("console", (m) => {
  if (m.type() === "error") errs.push(m.text().slice(0, 160));
});

await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
await page.setInputFiles('input[type="file"]', join(here, "..", "fixtures", "sample-paper.txt"));
await page.locator(".paper h1").waitFor({ timeout: 60000 });
await page.locator(".ball .badge").waitFor({ timeout: 120000 });
await page.waitForTimeout(600);

await page.locator(".ball").click();
await page.locator(".panel.open").waitFor();
await page.waitForTimeout(400);

const list = await (await fetch(`${BASE}/api/documents`)).json();
const docId = list.documents[0].id;
const getDoc = async () => await (await fetch(`${BASE}/api/documents/${docId}`)).json();

const beforeDoc = await getDoc();
const before = beforeDoc.terms.length;

// 1) 删除当前列表里的第一条（UI 按阅读顺序排，和接口顺序不同，所以名字从行里读）
const firstRow = page.locator(".term-item").first();
const firstName = (await firstRow.locator(".term-name").innerText()).split("\n")[0].trim();
await firstRow.locator(".term-del").click();
await page.waitForTimeout(900);
const afterDeleteDoc = await getDoc();
const stillHas = afterDeleteDoc.terms.some((t) => t.name === firstName);
console.log(`删除「${firstName}」：${before} → ${afterDeleteDoc.terms.length}，接口里还有：${stillHas}`);
await page.screenshot({ path: join(here, "..", "shots", "27-term-delete.png") });

// 2) 添加自定义术语
await page.locator('.panel-head .icon-btn[title="添加自定义术语"]').click();
await page.locator(".term-add-input").first().fill("BLEU");
await page.locator(".term-add-input").nth(1).fill("BLEU 分数");
await page.locator(".term-add-input").nth(2).fill("机器翻译常用的 n-gram 重合度指标");
await page.locator(".mini.primary", { hasText: "添加" }).click();
await page.waitForTimeout(900);

const afterAddDoc = await getDoc();
const custom = afterAddDoc.terms.find((t) => t.name === "BLEU");
console.log(
  `添加「BLEU」：${afterDeleteDoc.terms.length} → ${afterAddDoc.terms.length}，自定义字段=${JSON.stringify({
    zh: custom?.zhName,
    source: custom?.source,
    pages: custom?.pages,
    highlight: custom?.highlight,
  })}`,
);
const marks = await page.locator('mark[data-term-id^="custom-"]').count();
console.log(`正文高亮处数：${marks}`);
await page.screenshot({ path: join(here, "..", "shots", "28-term-add.png") });

// 3) 重新识别：删掉的不能复活，自定义要保留
await page.locator('.panel-head .icon-btn[title="重新识别术语"]').click();
await page.waitForTimeout(1500);
await page.locator('.panel-head .icon-btn[title="重新识别术语"]:not([disabled])').waitFor({ timeout: 180000 });
await page.waitForTimeout(600);

const afterRefresh = await getDoc();
const revived = afterRefresh.terms.some((t) => t.name === firstName);
const customKept = afterRefresh.terms.some((t) => t.name === "BLEU" && t.source === "自定义");
console.log(`重新识别后：${afterRefresh.terms.length} 个；被删的复活=${revived}；自定义保留=${customKept}`);
await page.screenshot({ path: join(here, "..", "shots", "29-term-refresh.png") });

await browser.close();
console.log(errs.length ? `页面问题：${errs.slice(0, 5).join(" | ")}` : "无页面错误 ✅");
