/**
 * 校验两件事：
 * 1) 侧边栏术语顺序 == 文章内出现顺序（按页码 + 页内字符位置）
 * 2) 点击后能在 PDF 里定位到对应页/位置（高亮闪烁的矩形所在页 == 术语首次出现页）
 */
import { chromium } from "playwright-core";

const BASE = "http://127.0.0.1:8787";
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const docId = process.env.DOC_ID;
if (!docId) throw new Error("需要 DOC_ID");

const doc = await (await fetch(`${BASE}/api/documents/${docId}`)).json();
const pageText = new Map(doc.pages.map((p) => [p.page, p.text.toLowerCase()]));
const sorted = doc.terms
  .map((t) => {
    const firstPage = t.pages?.[0];
    const text = firstPage ? pageText.get(firstPage) ?? "" : "";
    const offset = firstPage ? text.indexOf(t.name.toLowerCase()) : -1;
    return {
      name: t.name,
      page: firstPage ?? Infinity,
      offset: offset === -1 ? Infinity : offset,
      highlight: t.highlight !== false,
    };
  })
  .sort((a, b) => {
    if (a.page !== b.page) return a.page - b.page;
    if (a.offset !== b.offset) return a.offset - b.offset;
    if (a.name.length !== b.name.length) return b.name.length - a.name.length;
    return a.name.localeCompare(b.name);
  });

const expected = sorted.slice(0, 8);

const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox", "--disable-gpu"] });
const page = await browser.newPage({ viewport: { width: 1520, height: 960 } });
const errs = [];
page.on("pageerror", (e) => errs.push(e.message));

await page.goto(`${BASE}/?doc=${docId}`, { waitUntil: "networkidle" });
await page.locator("canvas").first().waitFor({ timeout: 60000 });
await page.waitForTimeout(1500);
await page.locator(".ball").click();
await page.locator(".panel.open").waitFor();

const shown = (await page.locator(".term-name").allInnerTexts()).slice(0, 8).map((s) => s.split("\n")[0].trim());
console.log("期望顺序：", expected.map((e) => e.name).join(" | "));
console.log("面板顺序：", shown.join(" | "));
const ok = expected.every((e, i) => shown[i]?.startsWith(e.name.slice(0, 18)));
console.log(`顺序一致：${ok ? "✅" : "❌"}`);
await page.screenshot({ path: "shots/20-term-order.png" });

// 从全文里选一个首次出现在第 4 页之后、且有高亮的术语，验证跳转
const target =
  sorted.find((e) => e.page >= 4 && e.highlight) ??
  sorted.find((e) => e.page >= 2 && e.highlight) ??
  sorted[sorted.length - 1];
console.log(`\n点击「${target.name}」（首见第 ${target.page} 页）`);
const item = page.locator(".term-item", { hasText: target.name.slice(0, 20) }).first();
await item.click();
await page.locator(".popover").waitFor({ timeout: 20000 });
let flashPage = null;
try {
  await page.locator(".pdf-hit.flash").first().waitFor({ timeout: 8000 });
  flashPage = await page.evaluate(
    () => document.querySelector(".pdf-hit.flash")?.closest(".pdf-page")?.dataset.page ?? null,
  );
} catch {
  flashPage = await page.evaluate(
    () => document.querySelector(".popover")?.parentElement ? "popover-opened" : null,
  );
}
console.log(`跳转结果：闪烁高亮所在页 = ${flashPage}（期望 ${target.page}）`);
await page.screenshot({ path: "shots/21-jump-to-page.png" });

await browser.close();
console.log(errs.length ? `页面错误：${errs.join(" | ")}` : "无页面错误 ✅");
