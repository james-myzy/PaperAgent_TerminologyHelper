/**
 * 运行配置：从环境变量 / .env 读取。
 * 所有 AI 能力都收敛到本机这一层：直连 OpenAI 兼容接口，
 * 不需要任何第三方云服务或托管平台。
 */
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hasLlmTransport } from "./llm-transport.mjs";

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
/** 数据目录：插件里通过 PAPER_DATA_DIR 指到插件自己的 data，独立运行时仍在项目下 */
export const DATA_DIR = process.env.PAPER_DATA_DIR?.trim()
  ? join(process.env.PAPER_DATA_DIR.trim())
  : join(ROOT, "data");
/** 前端构建产物目录：插件内置一份以 /paper-agent/ 为 base 的构建 */
export const WEB_DIST = process.env.PAPER_WEB_DIST?.trim()
  ? join(process.env.PAPER_WEB_DIST.trim())
  : join(ROOT, "web", "dist");

/** 极简 .env 解析（不引入 dotenv，保持零运行时依赖） */
function loadEnvFile() {
  const file = join(ROOT, ".env");
  if (!existsSync(file)) return;
  const text = readFileSync(file, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile();

const env = (key, fallback = "") => (process.env[key] ?? fallback).trim();

export const config = {
  port: Number(env("PORT", "8787")),
  /** deepseek = 真实模型；mock = 离线演示模式（无需 API Key，用脚本化响应验证链路） */
  provider: env("LLM_PROVIDER", env("LLM_API_KEY", env("DEEPSEEK_API_KEY")) ? "deepseek" : "mock"),
  baseUrl: env("LLM_BASE_URL", "https://api.deepseek.com/v1"),
  apiKey: env("LLM_API_KEY", env("DEEPSEEK_API_KEY")),
  model: env("LLM_MODEL", "deepseek-chat"),
  /** 单轮对话里允许的最大「模型思考 + 工具调用」步数 */
  maxSteps: Number(env("AGENT_MAX_STEPS", "6")),
  /** 术语抽取时每次送给模型的最大字符数与分块上限（控制成本） */
  termChunkChars: Number(env("TERM_CHUNK_CHARS", "2600")),
  termMaxChunks: Number(env("TERM_MAX_CHUNKS", "8")),
  requestTimeoutMs: Number(env("LLM_TIMEOUT_MS", "120000")),
};

export function publicConfig() {
  return {
    provider: config.provider,
    model: config.model,
    baseUrl: config.baseUrl,
    hasKey: Boolean(config.apiKey),
    /** 只回显尾部，前端用来显示"已配置"状态 */
    keyMask: config.apiKey ? `sk-…${config.apiKey.slice(-4)}` : "",
    /** true = 模型由 DeepSeek Harness 统一提供（插件模式），前端不再要求填 Key */
    managed: hasLlmTransport(),
    maxSteps: config.maxSteps,
  };
}

/**
 * 把 .env 里的几个键写成新值（保留其他行与注释）。
 * 前端"设置 API Key"就落到这里，重启后仍然生效。
 */
function persistEnvFile(entries) {
  const file = join(ROOT, ".env");
  const template = existsSync(file) ? readFileSync(file, "utf8") : readFileSync(join(ROOT, ".env.example"), "utf8");
  const lines = template.split(/\r?\n/);
  const keys = Object.keys(entries);
  const seen = new Set();

  const next = lines.map((line) => {
    const match = /^\s*([A-Z0-9_]+)\s*=/.exec(line);
    if (!match) return line;
    const key = match[1];
    if (!keys.includes(key)) return line;
    seen.add(key);
    return `${key}=${entries[key]}`;
  });

  for (const key of keys) {
    if (!seen.has(key)) next.push(`${key}=${entries[key]}`);
  }

  writeFileSync(file, next.join("\n").replace(/\n{3,}/g, "\n\n"), "utf8");
}

/** 运行时更新模型配置（API Key / Base URL / 模型名），并写回 .env */
export function updateRuntimeConfig(patch = {}) {
  const entries = {};

  if (typeof patch.apiKey === "string") {
    config.apiKey = patch.apiKey.trim();
    process.env.LLM_API_KEY = config.apiKey;
    entries.LLM_API_KEY = config.apiKey;
  }
  if (typeof patch.baseUrl === "string" && patch.baseUrl.trim()) {
    config.baseUrl = patch.baseUrl.trim().replace(/\/+$/, "");
    process.env.LLM_BASE_URL = config.baseUrl;
    entries.LLM_BASE_URL = config.baseUrl;
  }
  if (typeof patch.model === "string" && patch.model.trim()) {
    config.model = patch.model.trim();
    process.env.LLM_MODEL = config.model;
    entries.LLM_MODEL = config.model;
  }

  // 有 Key 就走真实模型，没 Key 自动退回离线演示
  config.provider = config.apiKey ? "deepseek" : "mock";
  process.env.LLM_PROVIDER = config.provider;

  if (Object.keys(entries).length) persistEnvFile(entries);
  return publicConfig();
}
