/**
 * 为整合发布包生成 MANIFEST.json 与 SHA256SUMS.txt。
 * 用法：node scripts/make-suite-manifest.mjs <suite目录>
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.argv[2];
if (!root) {
  console.error("需要传入整合包目录");
  process.exit(1);
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name !== "MANIFEST.json" && entry.name !== "SHA256SUMS.txt") out.push(full);
  }
  return out;
}

const files = walk(root).sort();
const entries = [];
const lines = [];

for (const file of files) {
  const rel = relative(root, file).replaceAll("\\", "/");
  const buffer = readFileSync(file);
  const hash = createHash("sha256").update(buffer).digest("hex");
  entries.push({
    path: rel,
    bytes: buffer.length,
    sha256: hash,
  });
  lines.push(`${hash}  ${rel}`);
}

const manifest = {
  name: "论文术语分析助手（术语透视）整合发布包",
  version: "1.0.0",
  builtAt: new Date().toISOString(),
  contents: entries,
};
writeFileSync(join(root, "MANIFEST.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
writeFileSync(join(root, "SHA256SUMS.txt"), lines.join("\n") + "\n", "utf8");

const total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
console.log(`已生成清单：${entries.length} 个文件，合计 ${(total / 1024 / 1024).toFixed(2)} MB`);
for (const entry of entries) console.log(`  ${entry.path}  ${(entry.bytes / 1024 / 1024).toFixed(2)} MB  ${entry.sha256.slice(0, 12)}…`);
