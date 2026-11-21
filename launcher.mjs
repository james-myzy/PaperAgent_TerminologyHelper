/**
 * 一键启动器（便携版入口）：不需要用户装 Node.js / npm。
 *
 * 做的事：
 *   1. 首次运行时从 .env.example 生成 .env（没有 Key 就是离线演示模式）
 *   2. 挑一个空闲端口（默认 8787，被占用就往后找）
 *   3. 启动服务，等它真正能响应
 *   4. 自动打开浏览器
 *
 * 用法：runtime\node.exe app\launcher.mjs [--no-open]
 */
import { createServer } from "node:net";
import { existsSync, copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { exec } from "node:child_process";
import { get } from "node:http";

const APP_DIR = dirname(fileURLToPath(import.meta.url));
const OPEN_BROWSER =
  !process.argv.includes("--no-open") && !process.env.PAPER_AGENT_NO_OPEN;

function log(message) {
  console.log(message);
}

/* 1. 首次运行生成 .env */
const envFile = join(APP_DIR, ".env");
const envSample = join(APP_DIR, ".env.example");
if (!existsSync(envFile) && existsSync(envSample)) {
  copyFileSync(envSample, envFile);
  log("· 已从 .env.example 生成 .env（可在首页填写 API Key）");
}
mkdirSync(join(APP_DIR, "data"), { recursive: true });

/* 2. 选端口 */
function isFree(port) {
  return new Promise((resolve) => {
    const tester = createServer();
    tester.once("error", () => resolve(false));
    tester.once("listening", () => tester.close(() => resolve(true)));
    tester.listen(port, "127.0.0.1");
  });
}

let port = 0;
for (let candidate = 8787; candidate <= 8805; candidate += 1) {
  // eslint-disable-next-line no-await-in-loop
  if (await isFree(candidate)) {
    port = candidate;
    break;
  }
}
if (!port) {
  console.error("端口 8787-8805 都被占用了，请先关掉占用程序再试。");
  process.exit(1);
}
process.env.PORT = String(port);
writeFileSync(join(APP_DIR, "data", "last-port.txt"), String(port), "utf8");

/* 3. 启动服务（同进程）：显式调用 startServer，不能只 import —— 那样只是加载模块不会监听 */
const paper = await import("./server/index.mjs");
paper.startServer({ port });

/* 4. 等端口可响应，再开浏览器 */
function waitReady(url, tries = 60) {
  return new Promise((resolve) => {
    const attempt = (left) => {
      const req = get(url, (res) => {
        res.resume();
        resolve(true);
      });
      req.on("error", () => {
        if (left <= 0) return resolve(false);
        setTimeout(() => attempt(left - 1), 250);
      });
      req.setTimeout(1000, () => req.destroy());
    };
    attempt(tries);
  });
}

const url = `http://127.0.0.1:${port}`;
const ready = await waitReady(`${url}/api/health`);
if (!ready) {
  console.error(`\n服务没有在预期时间内就绪，请把上面的报错发给我。地址：${url}\n`);
  process.exit(1);
}

log("");
log("==============================================");
log("  术语透视 已启动");
log(`  地址：${url}`);
log("  关闭：直接关掉这个窗口，或按 Ctrl+C");
log("==============================================");
log("");

if (OPEN_BROWSER) {
  exec(`start "" "${url}"`, { shell: "cmd.exe" }, () => {
    /* 浏览器打不开也不影响使用，用户可手动复制地址 */
  });
}
