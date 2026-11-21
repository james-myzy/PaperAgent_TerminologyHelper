/**
 * 回归测试：走「界面上传文件 → 自动提问」这条真实路径，
 * 验证刚上传就发消息时 documentId 不会丢（曾经的 bug：docRef 尚未重渲染）。
 */
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { chromium } from "playwright-core";

const BASE = "http://127.0.0.1:8787";
const CHROME = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const here = dirname(fileURLToPath(import.meta.url));
const fixture = process.env.UPLOAD_FIXTURE ?? join(here, "..", "fixtures", "sample-paper.txt");
mkdirSync(join(here, "..", "shots"), { recursive: true });

const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox", "--disable-gpu"] });
const page = await browser.newPage({ viewport: { width: 1520, height: 960 } });
const problems = [];
page.on("pageerror", (e) => problems.push(e.message));

await page.goto(`${BASE}/`, { waitUntil: "networkidle" });

// 用真实的文件选择器上传，而不是 ?doc= 深链
await page.setInputFiles('input[type="file"]', fixture);
await page.locator(".send-btn:not(.stop)").waitFor({ timeout: 240000 });
await page.waitForTimeout(800);

const failed = await page.locator(".tool-state.fail").count();
const toolNames = await page.locator(".tool-name").allInnerTexts();
const termTab = await page.locator(".tab", { hasText: "术语" }).innerText();
const docChip = await page.locator(".doc-chip").innerText().catch(() => "(无)");

console.log(`工具链：${toolNames.join(" → ")}`);
console.log(`失败工具数：${failed}`);
console.log(`术语页签：${termTab.replace(/\s+/g, " ")}`);
console.log(`文档标识：${docChip.replace(/\s+/g, " ")}`);

await page.screenshot({ path: join(here, "..", "shots", "08-upload-flow.png") });
await browser.close();

if (failed > 0) {
  console.log("\n❌ 有工具执行失败，上传后 documentId 可能仍然丢失");
  process.exit(1);
}
if (/术语\s*0/.test(termTab)) {
  console.log("\n❌ 术语数为 0，术语识别没跑通");
  process.exit(1);
}
console.log(problems.length ? `\n页面错误：${problems.join("; ")}` : "\n上传 → 自动分析 链路正常 ✅");
