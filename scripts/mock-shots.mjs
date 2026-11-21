/**
 * 把 mockups/*.html 渲染成截图，用于方案对比。
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright-core";

const CHROME = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const here = dirname(fileURLToPath(import.meta.url));
const mockDir = join(here, "..", "mockups");
const outDir = join(here, "..", "shots");
mkdirSync(outDir, { recursive: true });

const pages = [
  ["a-reader.html", "plan-a-reader.png"],
  ["b-copilot.html", "plan-b-copilot.png"],
  ["c-workbench.html", "plan-c-workbench.png"],
];

const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox", "--disable-gpu"] });
for (const [file, out] of pages) {
  const page = await browser.newPage({ viewport: { width: 1520, height: 960 }, deviceScaleFactor: 1 });
  await page.goto(pathToFileURL(join(mockDir, file)).href, { waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(outDir, out) });
  console.log(`渲染 ${file} → shots/${out}`);
  await page.close();
}
await browser.close();
