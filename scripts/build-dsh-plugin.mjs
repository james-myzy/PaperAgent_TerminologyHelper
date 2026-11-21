/**
 * 把 paper-agent 打包成 DeepSeek Harness 插件包。
 *
 * 产物：D:\dsh-plugins\dsh-paper-agent
 * 结构：
 *   package.json / cordis.patch.yml / icon.svg / README.md
 *   lib/index.js   （宿主：挂路由、注入模型桥、注册工具）
 *   lib/client.js  （浏览器：侧边栏入口 + 主面板）
 *   lib/paper/**   （paper-agent 服务端源码副本，保持相对导入结构）
 *   web/**         （以 /paper-agent/ 为 base 的前端构建产物）
 *
 * 用法：node scripts/build-dsh-plugin.mjs [--out D:\dsh-plugins\dsh-paper-agent]
 */
import { cp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const argOut = process.argv.indexOf("--out");
const OUT = resolve(argOut >= 0 ? process.argv[argOut + 1] : "D:/dsh-plugins/dsh-paper-agent");

const SRC_PLUGIN = join(ROOT, "dsh-plugin");
const SRC_SERVER = join(ROOT, "server");
const SRC_WEB = join(ROOT, "web", "dist-paper");

async function ensureDir(path) {
  await mkdir(path, { recursive: true });
}

async function copyDir(from, to) {
  await cp(from, to, { recursive: true, force: true });
}

async function walk(dir, base = dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full, base)));
    else out.push(full.slice(base.length + 1).replaceAll("\\", "/"));
  }
  return out;
}

if (!existsSync(SRC_WEB)) {
  console.error(`缺少前端构建产物：${SRC_WEB}\n先运行：PAPER_BASE=/paper-agent/ PAPER_OUT=web/dist-paper vite build --config web/vite.config.ts`);
  process.exit(1);
}

console.log(`目标目录：${OUT}`);
await ensureDir(OUT);

// 只清理本脚本产出的内容，保留 node_modules / pnpm-lock.yaml（开发时用 link: 安装需要它们）
for (const name of ["lib", "web", "package.json", "cordis.patch.yml", "icon.svg", "README.md"]) {
  await rm(join(OUT, name), { recursive: true, force: true });
}

// 1) 插件自身文件
await copyDir(SRC_PLUGIN, OUT);

// 2) paper-agent 服务端源码
const paperDir = join(OUT, "lib", "paper");
await ensureDir(paperDir);
await copyDir(SRC_SERVER, paperDir);

// 3) 前端产物
await ensureDir(join(OUT, "web"));
await copyDir(SRC_WEB, join(OUT, "web"));

// 4) 统计
const files = await walk(OUT);
let bytes = 0;
for (const rel of files) {
  const info = await stat(join(OUT, rel));
  bytes += info.size;
}
console.log(`完成：${files.length} 个文件，${(bytes / 1024 / 1024).toFixed(1)} MB`);

// 5) 自检：插件包引用的文件都在
const required = [
  "package.json",
  "cordis.patch.yml",
  "lib/index.js",
  "lib/client.js",
  "lib/dsh-llm.js",
  "lib/tools.js",
  "lib/paper/index.mjs",
  "lib/paper/config.mjs",
  "lib/paper/llm-transport.mjs",
  "web/index.html",
];
const missing = required.filter((rel) => !existsSync(join(OUT, rel)));
if (missing.length) {
  console.error("自检失败，缺少：" + missing.join(", "));
  process.exit(1);
}
console.log("自检通过：入口与依赖文件齐全");
