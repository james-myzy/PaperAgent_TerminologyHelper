import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * PAPER_BASE：部署前缀。独立运行时留空（"/"）；作为 DSH 插件内置时设为 "/paper-agent/"。
 * PAPER_OUT：产物目录，默认 web/dist；插件构建用 web/dist-paper，互不覆盖。
 */
const base = process.env.PAPER_BASE ?? "/";
const outDir = process.env.PAPER_OUT ? resolve(process.cwd(), process.env.PAPER_OUT) : resolve(here, "dist");

export default defineConfig({
  root: here,
  base,
  plugins: [react()],
  build: {
    outDir,
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8787",
    },
  },
});
