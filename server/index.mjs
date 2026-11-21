/**
 * paper-agent 服务端：静态资源 + 文档解析 API + 智能体对话（SSE 流式）。
 * 一个 node 进程就能跑，不需要 Supabase、不需要额外云服务。
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { createReadStream, existsSync, statSync } from "node:fs";
import { join, extname, normalize } from "node:path";
import { URL, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

import { config, publicConfig, updateRuntimeConfig, ROOT, WEB_DIST as CONFIG_WEB_DIST } from "./config.mjs";
import { parseDocument } from "./parse.mjs";
import {
  createDocument,
  getDocument,
  listDocuments,
  patchDocumentState,
  saveExport,
  saveDocumentFile,
  persistDocument,
  documentFilePath,
  exportsDir,
} from "./store.mjs";
import { runAgent } from "./agent/loop.mjs";
import {
  explainTermStream,
  explainPassageStream,
  translatePages,
  translateBlocks,
  extractTerms,
  buildCustomTerm,
} from "./agent/terms.mjs";
import { buildHighlightedDocx, exportFilename } from "./lib/exportDocx.mjs";
import { termKey } from "./lib/termMatch.mjs";

const WEB_DIST = CONFIG_WEB_DIST;
const MAX_UPLOAD = 60 * 1024 * 1024;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
  });
  res.end(data);
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function documentPayload(doc) {
  return {
    id: doc.id,
    title: doc.title,
    kind: doc.kind,
    filename: doc.filename,
    pageCount: doc.pages.length,
    charCount: doc.charCount,
    language: doc.language,
    hasFile: Boolean(doc.file),
    pages: doc.pages,
    terms: doc.terms,
    details: doc.details,
    translations: doc.translations,
    blockTranslations: doc.blockTranslations ?? {},
  };
}

async function serveStatic(req, res, pathname, webDist = WEB_DIST) {
  const safePath = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  let filePath = join(webDist, safePath);
  if (pathname === "/" || pathname === "") filePath = join(webDist, "index.html");

  try {
    const info = await stat(filePath);
    if (info.isDirectory()) throw new Error("directory");
  } catch {
    // SPA 回退：非静态资源一律给 index.html
    const fallback = join(webDist, "index.html");
    if (!existsSync(fallback)) {
      res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("前端尚未构建：请先运行 npm run build，再执行 npm start。");
      return;
    }
    filePath = fallback;
  }

  const type = MIME[extname(filePath).toLowerCase()] ?? "application/octet-stream";
  res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache" });
  createReadStream(filePath).pipe(res);
}

function sseChannel(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 15000);
  const emit = (payload) => {
    try {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch {
      /* 客户端已断开 */
    }
  };
  const close = () => {
    clearInterval(heartbeat);
    try {
      res.end();
    } catch {
      /* ignore */
    }
  };
  return { emit, close };
}

async function handleApi(req, res, pathname) {
  // ---- 健康检查 / 前端读取的运行配置 ----
  if (pathname === "/api/health" || pathname === "/api/config") {
    return json(res, 200, { ok: true, ...publicConfig() });
  }

  // ---- 模型设置：在首页直接填 / 改 API Key ----
  if (pathname === "/api/settings" && req.method === "POST") {
    let body = {};
    try {
      const raw = await readBody(req, 16 * 1024);
      body = raw.length ? JSON.parse(raw.toString("utf8")) : {};
    } catch {
      return json(res, 400, { error: "请求体不是合法 JSON" });
    }
    const updated = updateRuntimeConfig({
      apiKey: typeof body.apiKey === "string" ? body.apiKey : undefined,
      baseUrl: typeof body.baseUrl === "string" ? body.baseUrl : undefined,
      model: typeof body.model === "string" ? body.model : undefined,
    });
    return json(res, 200, { ok: true, ...updated });
  }

  // ---- 文档 ----
  if (pathname === "/api/documents" && req.method === "GET") {
    return json(res, 200, { documents: listDocuments() });
  }

  if (pathname === "/api/documents" && req.method === "POST") {
    const rawName = req.headers["x-filename"];
    const filename = rawName ? decodeURIComponent(String(rawName)) : "upload.pdf";
    let buffer;
    try {
      buffer = await readBody(req, MAX_UPLOAD);
    } catch (error) {
      return json(res, 413, { error: error.message });
    }
    if (!buffer.length) return json(res, 400, { error: "文件为空" });
    try {
      const parsed = await parseDocument(buffer, filename);
      const doc = createDocument(parsed);
      // 保留原文件，PDF 版式视图要按页重新渲染
      const ext = filename.includes(".") ? `.${filename.split(".").pop().toLowerCase()}` : "";
      doc.file = saveDocumentFile(doc.id, buffer, ext);
      persistDocument(doc);
      return json(res, 200, documentPayload(doc));
    } catch (error) {
      return json(res, 400, { error: error.message });
    }
  }

  // ---- 术语识别（词库扫描 + 模型抽取），供阅读器自动触发 ----
  const termsMatch = pathname.match(/^\/api\/documents\/([\w-]+)\/terms$/);
  if (termsMatch && req.method === "POST") {
    const doc = getDocument(termsMatch[1]);
    if (!doc) return json(res, 404, { error: "文档不存在或已过期" });
    let body = {};
    try {
      const raw = await readBody(req, 64 * 1024);
      body = raw.length ? JSON.parse(raw.toString("utf8")) : {};
    } catch {
      return json(res, 400, { error: "请求体不是合法 JSON" });
    }
    const maxChunks = Math.min(16, Number(body.max_chunks) || config.termMaxChunks);
    try {
      const result = await extractTerms(doc, { maxChunks });
      const removed = new Set(doc.removedKeys ?? []);
      const merged = new Map();
      // 已有术语：读者删掉的不要复活，自己加的原样保留
      for (const term of doc.terms) {
        const key = termKey(term.name);
        if (removed.has(key)) continue;
        merged.set(key, term);
      }
      for (const term of result.terms) {
        const key = termKey(term.name);
        if (removed.has(key)) continue;
        const existing = merged.get(key);
        if (existing && existing.source === "自定义") continue; // 自定义优先
        merged.set(key, term);
      }
      const terms = Array.from(merged.values());
      patchDocumentState(doc.id, { terms });
      return json(res, 200, {
        terms,
        glossaryHits: result.glossaryHits,
        aiLists: result.aiLists,
        scannedChunks: result.scannedChunks,
      });
    } catch (error) {
      return json(res, 500, { error: error.message });
    }
  }

  // ---- 术语自定义：新增 / 删除 ----
  const customMatch = pathname.match(/^\/api\/documents\/([\w-]+)\/terms\/custom$/);
  if (customMatch && req.method === "POST") {
    const doc = getDocument(customMatch[1]);
    if (!doc) return json(res, 404, { error: "文档不存在或已过期" });
    let body = {};
    try {
      const raw = await readBody(req, 16 * 1024);
      body = raw.length ? JSON.parse(raw.toString("utf8")) : {};
    } catch {
      return json(res, 400, { error: "请求体不是合法 JSON" });
    }
    const term = buildCustomTerm(doc, body);
    if (!term) return json(res, 400, { error: "术语名不能为空" });
    const key = termKey(term.name);
    const terms = [...doc.terms.filter((t) => termKey(t.name) !== key), term];
    patchDocumentState(doc.id, { terms });
    return json(res, 200, { terms, added: term });
  }

  const removeMatch = pathname.match(/^\/api\/documents\/([\w-]+)\/terms\/([\w-]+)$/);
  if (removeMatch && req.method === "DELETE") {
    const doc = getDocument(removeMatch[1]);
    if (!doc) return json(res, 404, { error: "文档不存在或已过期" });
    const id = removeMatch[2];
    const target = doc.terms.find((t) => t.id === id);
    if (!target) return json(res, 404, { error: "术语不存在" });
    const removedKeys = Array.from(new Set([...(doc.removedKeys ?? []), termKey(target.name)]));
    const terms = doc.terms.filter((t) => t.id !== id);
    patchDocumentState(doc.id, { terms, removedKeys });
    return json(res, 200, { terms, removed: target });
  }

  // ---- 阅读器动作：术语解释（流式）/ 逐段翻译（流式）/ 导出 ----
  const actionMatch = pathname.match(
    /^\/api\/documents\/([\w-]+)\/(explain|explain-passage|translate-blocks|translate|export)$/,
  );
  if (actionMatch && req.method === "POST") {
    const doc = getDocument(actionMatch[1]);
    if (!doc) return json(res, 404, { error: "文档不存在或已过期" });
    const action = actionMatch[2];

    let body = {};
    try {
      const raw = await readBody(req, 1024 * 1024);
      body = raw.length ? JSON.parse(raw.toString("utf8")) : {};
    } catch {
      return json(res, 400, { error: "请求体不是合法 JSON" });
    }

    if (action === "export") {
      try {
        const buffer = await buildHighlightedDocx(doc);
        const saved = saveExport(buffer, exportFilename(doc.title));
        return json(res, 200, { ...saved, terms: doc.terms.length });
      } catch (error) {
        return json(res, 500, { error: error.message });
      }
    }

    const { emit, close } = sseChannel(res);
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) controller.abort();
    });

    try {
      if (action === "explain") {
        const term = String(body.term ?? "").trim();
        if (!term) {
          emit({ type: "error", message: "缺少术语名称" });
        } else {
          const matched = doc.terms.find(
            (t) => t.name.toLowerCase() === term.toLowerCase() || t.zhName === term,
          );
          const key = matched?.id ?? term;
          const cached = doc.details?.[key];
          const force = Boolean(body.force);

          // 同一个术语问过一次就不再花 token：直接回放缓存（force=true 时强制重新生成）
          if (cached && cached.trim() && !force) {
            emit({ type: "start", term, cached: true });
            emit({ type: "delta", text: cached });
            emit({
              type: "done",
              term,
              key,
              page: matched?.pages?.[0] ?? null,
              text: cached,
              cached: true,
            });
          } else {
            emit({ type: "start", term });
            const { text, page } = await explainTermStream(doc, term, {
              signal: controller.signal,
              onDelta: (delta) => emit({ type: "delta", text: delta }),
            });
            patchDocumentState(doc.id, { details: { [key]: text } });
            emit({ type: "done", term, key, page, text, cached: false });
          }
        }
      } else if (action === "explain-passage") {
        // 选段解释：按「页码 + 选段文字」做缓存，同一段只问一次模型
        const text = String(body.text ?? "").replace(/\s+/g, " ").trim();
        const page = Number(body.page) || null;
        if (!text) {
          emit({ type: "error", message: "选段为空" });
        } else {
          const key = createHash("sha1").update(`${page ?? 0}|${text}`).digest("hex").slice(0, 16);
          const cached = doc.passages?.[key];
          const force = Boolean(body.force);

          if (cached && cached.trim() && !force) {
            emit({ type: "start", page, cached: true });
            emit({ type: "delta", text: cached });
            emit({ type: "done", key, page, text: cached, cached: true });
          } else {
            emit({ type: "start", page });
            const result = await explainPassageStream(
              doc,
              { text, page },
              {
                signal: controller.signal,
                onDelta: (delta) => emit({ type: "delta", text: delta }),
              },
            );
            patchDocumentState(doc.id, { passages: { [key]: result.text } });
            emit({ type: "done", key, page: result.page, text: result.text, cached: false });
          }
        }
      } else if (action === "translate-blocks") {
        // 逐段翻译：给「原文一段 / 译文一段」的双语对照用。
        // 只翻指定页（不传就是全文），每段结果带缓存键，改天再打开同一篇不用重复花钱。
        const requested = Array.isArray(body.pages)
          ? body.pages.map(Number).filter((n) => Number.isFinite(n))
          : doc.pages.map((p) => p.page);
        const targets = doc.pages.filter((p) => requested.includes(p.page));
        const force = Boolean(body.force);
        const total = targets.reduce((sum, page) => sum + (page.blocks ?? []).length, 0);
        emit({ type: "start", total });

        const result = await translateBlocks(doc, {
          pages: requested,
          force,
          signal: controller.signal,
          onProgress: (progress) => emit({ type: "progress", ...progress }),
          onBlock: (block) => emit({ type: "block", ...block }),
        });

        // 每段缓存写入文档状态，前端刷新后直接命中
        patchDocumentState(doc.id, { blockTranslations: result.translations });
        emit({
          type: "done",
          total,
          count: result.count,
          cached: result.cached,
          pages: targets.map((p) => p.page),
        });
      } else {
        // translate：整页翻译（旧接口，保留给脚本/工具调用）
        const requested = Array.isArray(body.pages)
          ? body.pages.map(Number).filter((n) => Number.isFinite(n))
          : doc.pages.map((p) => p.page);
        const targets = doc.pages.filter((p) => requested.includes(p.page));
        const force = Boolean(body.force);
        emit({ type: "start", total: targets.length });
        for (const page of targets) {
          const cached = doc.translations?.[page.page];
          if (cached && !force) {
            emit({ type: "page", page: page.page, text: cached, cached: true });
            continue;
          }
          const translations = await translatePages(doc, [page], { signal: controller.signal });
          patchDocumentState(doc.id, { translations });
          emit({ type: "page", page: page.page, text: translations[page.page] ?? "" });
        }
        emit({ type: "done", pages: targets.map((p) => p.page) });
      }
    } catch (error) {
      emit({ type: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      close();
    }
    return undefined;
  }

  const docMatch = pathname.match(/^\/api\/documents\/([\w-]+)$/);

  // ---- 原始文件（PDF 版式视图按页渲染用） ----
  const fileMatch = pathname.match(/^\/api\/documents\/([\w-]+)\/file$/);
  if (fileMatch && req.method === "GET") {
    const doc = getDocument(fileMatch[1]);
    const file = doc?.file ? documentFilePath(doc.file) : null;
    if (!file) return json(res, 404, { error: "原始文件不存在" });
    const size = statSync(file).size;
    res.writeHead(200, {
      "Content-Type": doc.kind === "pdf" ? "application/pdf" : "application/octet-stream",
      "Content-Length": size,
      "Cache-Control": "private, max-age=3600",
    });
    return createReadStream(file).pipe(res);
  }
  if (docMatch && req.method === "GET") {
    const doc = getDocument(docMatch[1]);
    if (!doc) return json(res, 404, { error: "文档不存在或已过期" });
    return json(res, 200, documentPayload(doc));
  }

  if (docMatch && req.method === "PATCH") {
    const doc = getDocument(docMatch[1]);
    if (!doc) return json(res, 404, { error: "文档不存在或已过期" });
    const body = await readBody(req);
    let patch = {};
    try {
      patch = JSON.parse(body.toString("utf8") || "{}");
    } catch {
      return json(res, 400, { error: "请求体不是合法 JSON" });
    }
    const updated = patchDocumentState(doc.id, patch);
    return json(res, 200, documentPayload(updated));
  }

  // ---- 智能体对话（SSE） ----
  if (pathname === "/api/chat" && req.method === "POST") {
    let body;
    try {
      body = JSON.parse((await readBody(req, 4 * 1024 * 1024)).toString("utf8") || "{}");
    } catch {
      return json(res, 400, { error: "请求体不是合法 JSON" });
    }
    const doc = body.documentId ? getDocument(body.documentId) : null;
    if (body.documentId && !doc) return json(res, 404, { error: "文档不存在或已过期" });

    const history = Array.isArray(body.messages)
      ? body.messages
          .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
          .slice(-20)
          .map((m) => ({ role: m.role, content: m.content }))
      : [];
    if (!history.length) return json(res, 400, { error: "消息为空" });

    const { emit, close } = sseChannel(res);
    const controller = new AbortController();
    // 客户端点「停止」或关页面时中断模型请求；用 res 的 close 判断，
    // req 的 close 在请求体读完时就会触发，会误杀正在运行的智能体。
    res.on("close", () => {
      if (!res.writableEnded) controller.abort();
    });

    try {
      emit({ type: "ready", documentId: doc?.id ?? null, provider: config.provider, model: config.model });
      const result = await runAgent({ doc, history, emit, signal: controller.signal });
      emit({ type: "done", text: result.text, steps: result.steps, tools: result.usedTools });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const friendly = message.includes("401")
        ? "模型接口鉴权失败：请检查 .env 里的 LLM_API_KEY 是否正确。"
        : message.includes("404") && config.provider === "deepseek"
          ? `模型接口 404：请检查 LLM_BASE_URL（当前 ${config.baseUrl}）与 LLM_MODEL（当前 ${config.model}）。`
          : message;
      emit({ type: "error", message: friendly });
    } finally {
      close();
    }
    return undefined;
  }

  // ---- 导出文件下载 ----
  const exportMatch = pathname.match(/^\/api\/exports\/(.+)$/);
  if (exportMatch && req.method === "GET") {
    const name = decodeURIComponent(exportMatch[1]);
    const file = join(exportsDir, name.replace(/[\\/]/g, ""));
    if (!existsSync(file)) return json(res, 404, { error: "文件不存在" });
    res.writeHead(200, {
      "Content-Type": MIME[".docx"],
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
    });
    return createReadStream(file).pipe(res);
  }

  return json(res, 404, { error: `未知接口 ${pathname}` });
}

/**
 * 生成请求处理器：独立运行与 DSH 插件共用。
 * @param {{ base?: string, webDist?: string }} [options]
 *   base —— 挂在别的服务下时的路径前缀（如 "/paper-agent"），进来先剥掉；
 *   webDist —— 前端构建产物目录。
 */
export function createRequestHandler(options = {}) {
  const prefix = String(options.base ?? "").replace(/\/+$/, "");
  const webDist = options.webDist ?? WEB_DIST;

  return async function handle(req, res) {
    if (prefix && req.url?.startsWith(prefix)) {
      req.url = req.url.slice(prefix.length) || "/";
    }
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    const pathname = decodeURIComponent(url.pathname);
    try {
      if (pathname.startsWith("/api/")) {
        await handleApi(req, res, pathname);
        return;
      }
      await serveStatic(req, res, pathname, webDist);
    } catch (error) {
      if (!res.headersSent) json(res, 500, { error: error.message });
      else res.end();
    }
  };
}

const isEntryPoint =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;

/**
 * 真正监听端口。独立入口与便携版启动器都走这里。
 * @param {{ port?: number, host?: string }} [options]
 * @returns {import("node:http").Server}
 */
export function startServer(options = {}) {
  const port = Number(options.port ?? config.port);
  const host = options.host ?? "127.0.0.1";
  const server = createServer(createRequestHandler());
  server.listen(port, host, () => {
    const mode = config.provider === "mock" ? "离线演示（mock）" : `${config.model} @ ${config.baseUrl}`;
    console.log(`\n  论文术语分析智能体 已启动`);
    console.log(`  地址：http://${host}:${port}`);
    console.log(`  模型：${mode}`);
    if (config.provider === "mock") {
      console.log(`  提示：在 .env 里填 LLM_API_KEY 即可切换到真实模型。`);
    }
    console.log("");
  });
  return server;
}

if (isEntryPoint) {
  startServer();
}
