/**
 * dsh-paper-agent 宿主半边。
 *
 * 做三件事：
 *  1. 把「术语透视」整套应用（前端构建产物 + 本地 API）挂到 DSH 的 Web 服务上，
 *     路径默认 /paper-agent，于是它和 Harness 同源、同一端口、同一条登录态；
 *  2. 注入模型传输层：paper 的模型调用全部改走 Harness 已配置的 ctx.llm；
 *  3. 注册一组 paper_* 工具，让 Harness 的智能体可以直接读这份文档、解释术语、答问。
 */
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export const name = "paper-agent";
export const inject = ["webServer", "tools"];

function normalizeBase(value) {
  const text = String(value ?? "/paper-agent").trim();
  const withSlash = text.startsWith("/") ? text : `/${text}`;
  return withSlash.length > 1 ? withSlash.replace(/\/+$/, "") : withSlash;
}

/**
 * 插件入口。
 * @param {object} ctx - cordis 上下文
 * @param {object} config - cordis.patch.yml 里该行的 config
 */
export async function apply(ctx, config = {}) {
  const basePath = normalizeBase(config.basePath);
  const dataDir = config.dataDir
    ? isAbsolute(config.dataDir)
      ? config.dataDir
      : resolve(ROOT, config.dataDir)
    : join(ROOT, "data");
  const webDir = join(ROOT, "web");
  const provider = String(config.provider ?? "deepseek-official");
  const model = String(config.model ?? "deepseek-flash");
  mkdirSync(dataDir, { recursive: true });

  // 这些环境变量必须在导入 paper 模块之前设置：config.mjs 在导入时就会读它们。
  // 但用完要立刻还原 —— 插件跑在 Harness 主进程里，直接改 process.env 会污染
  // 之后派生的所有子进程（包括智能体的 shell），让独立版也误以为自己跑在插件里。
  const ENV_KEYS = [
    "PAPER_DATA_DIR",
    "PAPER_WEB_DIST",
    "LLM_PROVIDER",
    "LLM_MODEL",
    "LLM_BASE_URL",
    "AGENT_MAX_STEPS",
  ];
  const savedEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

  process.env.PAPER_DATA_DIR = dataDir;
  process.env.PAPER_WEB_DIST = webDir;
  process.env.LLM_PROVIDER = "dsh";
  process.env.LLM_MODEL = model;
  process.env.LLM_BASE_URL = savedEnv.get("LLM_BASE_URL") ?? "http://127.0.0.1:0/dsh";
  process.env.AGENT_MAX_STEPS = String(config.maxSteps ?? 6);

  let paper;
  let llmModule;
  let createDshTransport;
  try {
    paper = await import("./paper/index.mjs");
    llmModule = await import("./paper/llm-transport.mjs");
    ({ createDshTransport } = await import("./dsh-llm.js"));
  } finally {
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  llmModule.setLlmTransport(
    createDshTransport(ctx, {
      provider,
      model,
      maxTokens: Number(config.maxTokens ?? 4096),
    }),
  );

  const paperHandler = paper.createRequestHandler({ base: basePath, webDist: webDir });

  const webServer = ctx.get?.("webServer") ?? ctx.webServer;
  if (!webServer || typeof webServer.register !== "function") {
    ctx.logger?.warn?.("[paper-agent] 当前组合没有 webServer，页面不可用（工具仍然可用）");
  }

  let disposeRoute = () => {};
  if (webServer) {
    const handler = async (req, res) => {
      // 浏览器半边启动时读一次元信息，拿到真实挂载路径
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === `${basePath}/_meta.json` || url.pathname === "/_meta.json") {
        const body = JSON.stringify({ basePath, version: "1.0.0" });
        res.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
          "content-length": Buffer.byteLength(body),
        });
        res.end(body);
        return;
      }
      // 少了结尾斜杠时补一个，否则页面里的相对资源会解析到上一级
      if (url.pathname === basePath) {
        res.writeHead(302, { location: `${basePath}/` });
        res.end();
        return;
      }
      await paperHandler(req, res);
    };
    disposeRoute = webServer.register({ kind: "prefix", path: basePath, handler });
    ctx.logger?.info?.(`[paper-agent] 阅读页已挂载：${basePath}/`);
  }

  const modules = {
    store: await import("./paper/store.mjs"),
    parse: await import("./paper/parse.mjs"),
    terms: await import("./paper/agent/terms.mjs"),
    loop: await import("./paper/agent/loop.mjs"),
  };
  const { createPaperTools } = await import("./tools.js");
  for (const tool of createPaperTools({
    basePath,
    modules,
    maxSteps: Number(config.maxSteps ?? 6),
    maxImportChunks: Number(config.maxImportChunks ?? 3),
  })) {
    ctx.tools.register(tool);
  }

  ctx.logger?.info?.(
    `[paper-agent] 就绪：模型 ${provider}/${model}，数据目录 ${dataDir}`,
  );

  return () => {
    try {
      disposeRoute?.();
    } catch {
      /* 已卸载 */
    }
  };
}
