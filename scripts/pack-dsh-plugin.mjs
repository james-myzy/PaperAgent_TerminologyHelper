/**
 * 打包可分发的 DSH 插件 zip（不含 node_modules / data，装机时由 pnpm 安装依赖）。
 * 产物：D:\dsh_program\paper-agent-dsh-plugin.zip
 */
import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { createWriteStream, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC = resolve(process.argv[2] ?? "D:/dsh-plugins/dsh-paper-agent");
const STAGE = join(ROOT, ".dsh-plugin-stage", "dsh-paper-agent");
const ZIP = resolve(ROOT, "..", "paper-agent-dsh-plugin.zip");

await rm(join(ROOT, ".dsh-plugin-stage"), { recursive: true, force: true });
await mkdir(STAGE, { recursive: true });

const SKIP = new Set(["node_modules", "data", ".git"]);

async function copyTree(from, to) {
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const src = join(from, entry.name);
    const dst = join(to, entry.name);
    if (entry.isDirectory()) {
      await mkdir(dst, { recursive: true });
      await copyTree(src, dst);
    } else {
      await cp(src, dst);
    }
  }
}

await copyTree(SRC, STAGE);

if (existsSync(ZIP)) await rm(ZIP, { force: true });
const staged = join(ROOT, ".dsh-plugin-stage");
const result = spawnSync("tar.exe", ["-a", "-c", "-f", ZIP, "dsh-paper-agent"], {
  cwd: staged,
  stdio: "inherit",
});
if (result.status !== 0) {
  console.error("tar 打包失败");
  process.exit(1);
}
await rm(staged, { recursive: true, force: true });
console.log(`完成：${ZIP}`);
