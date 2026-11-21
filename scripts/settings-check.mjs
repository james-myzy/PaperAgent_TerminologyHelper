/**
 * 设置与自动识别检查：
 * 1) 首页显示已配置的 Key（掩码），可更换
 * 2) 保存 Key 后写回 .env
 * 3) 上传后自动识别并自动展开术语面板
 */
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { chromium } from "playwright-core";

const BASE = "http://127.0.0.1:8787";
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const here = dirname(fileURLToPath(import.meta.url));
const envPath = join(here, "..", ".env");

const envText = await readFile(envPath, "utf8");
const keyMatch = /^LLM_API_KEY=(.*)$/m.exec(envText);
const currentKey = keyMatch ? keyMatch[1].trim() : "";
if (!currentKey) throw new Error(".env 里没有 LLM_API_KEY，先跑一次再测");

const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox", "--disable-gpu"] });
const page = await browser.newPage({ viewport: { width: 1520, height: 960 } });
const errs = [];
page.on("pageerror", (e) => errs.push(e.message));
page.on("console", (m) => {
  if (m.type() === "error") errs.push(m.text().slice(0, 160));
});

await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
await page.waitForTimeout(800);

const status = await page.locator(".settings-status").innerText();
console.log(`首页状态：${status}`);
await page.screenshot({ path: join(here, "..", "shots", "30-home-settings.png") });

// 更换（用同一个 key 覆盖，验证写回 .env）
await page.locator(".settings-row .mini", { hasText: "更换" }).click();
await page.locator(".settings-edit input").fill(currentKey);
await page.locator(".settings-edit .mini.primary").click();
await page.waitForTimeout(1200);
const toast = await page.locator(".toast").innerText().catch(() => "");
console.log(`保存提示：${toast.replace(/\s+/g, " ")}`);

const envAfter = await readFile(envPath, "utf8");
const keyAfter = (/^LLM_API_KEY=(.*)$/m.exec(envAfter) ?? [])[1];
console.log(`.env 里 Key 是否仍为该值：${keyAfter?.trim() === currentKey}`);

// 上传 → 自动识别 → 面板自动展开
await page.setInputFiles('input[type="file"]', join(here, "..", "fixtures", "sample-paper.txt"));
await page.locator(".paper h1").waitFor({ timeout: 60000 });
await page.locator(".panel.open").waitFor({ timeout: 180000 });
await page.waitForTimeout(600);
const count = await page.locator(".panel-count").innerText();
const rows = await page.locator(".term-item").count();
console.log(`上传后自动打开面板：术语 ${count} 个，列表 ${rows} 行`);
await page.screenshot({ path: join(here, "..", "shots", "31-auto-terms.png") });

await browser.close();

// 保险：把 .env 还原成测试前的样子
await writeFile(envPath, envText, "utf8");
console.log(errs.length ? `页面问题：${errs.slice(0, 5).join(" | ")}` : "无页面错误 ✅");
