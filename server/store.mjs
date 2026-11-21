/**
 * 文档与导出文件的内存/磁盘存储。
 * 原应用的文档状态全在浏览器里，智能体要跨轮次记住「这份论文识别出了哪些术语」，
 * 所以把状态放到服务端，按 documentId 归档。
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DATA_DIR } from "./config.mjs";

const DOC_DIR = join(DATA_DIR, "docs");
const EXPORT_DIR = join(DATA_DIR, "exports");
const UPLOAD_DIR = join(DATA_DIR, "uploads");
mkdirSync(DOC_DIR, { recursive: true });
mkdirSync(EXPORT_DIR, { recursive: true });
mkdirSync(UPLOAD_DIR, { recursive: true });

/** 原始文件留在本地：PDF 版式视图要用它重新渲染整页 */
export function saveDocumentFile(id, buffer, ext) {
  const safeExt = String(ext || "").replace(/[^a-z0-9.]/gi, "").slice(0, 8) || ".bin";
  const name = `${id}${safeExt}`;
  writeFileSync(join(UPLOAD_DIR, name), buffer);
  return name;
}

export function documentFilePath(name) {
  if (!name) return null;
  const safe = String(name).replace(/[\\/]/g, "");
  const file = join(UPLOAD_DIR, safe);
  return existsSync(file) ? file : null;
}

/** @type {Map<string, any>} */
const documents = new Map();

/**
 * 启动时从 data/docs 恢复已有文档：进程重启（或装成 DSH 插件后重开 Harness）
 * 不应该让之前导入的论文「消失」——磁盘上有就还在。
 */
function hydrateDocuments() {
  let files = [];
  try {
    files = readdirSync(DOC_DIR).filter((name) => name.endsWith(".json"));
  } catch {
    return;
  }
  for (const name of files) {
    try {
      const doc = JSON.parse(readFileSync(join(DOC_DIR, name), "utf8"));
      if (doc?.id && Array.isArray(doc.pages)) documents.set(doc.id, doc);
    } catch {
      // 单个文件损坏不影响其它文档
    }
  }
}

hydrateDocuments();

export function createDocument(doc) {
  const id = randomUUID();
  const record = {
    id,
    createdAt: new Date().toISOString(),
    terms: [],
    details: {},
    passages: {},
    translations: {},
    blockTranslations: {},
    removedKeys: [],
    ...doc,
  };
  documents.set(id, record);
  try {
    writeFileSync(join(DOC_DIR, `${id}.json`), JSON.stringify({ ...record, buffer: undefined }));
  } catch {
    // 落盘失败不影响内存使用
  }
  return record;
}

export function getDocument(id) {
  if (!id) return null;
  if (documents.has(id)) return documents.get(id);
  const file = join(DOC_DIR, `${id}.json`);
  if (!existsSync(file)) return null;
  try {
    const record = JSON.parse(readFileSync(file, "utf8"));
    documents.set(id, record);
    return record;
  } catch {
    return null;
  }
}

export function listDocuments() {
  return Array.from(documents.values())
    .map((d) => ({ id: d.id, title: d.title, kind: d.kind, pageCount: d.pages.length, createdAt: d.createdAt }))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/** 把文档记录重新写盘（补字段后用） */
export function persistDocument(doc) {
  try {
    writeFileSync(join(DOC_DIR, `${doc.id}.json`), JSON.stringify({ ...doc, buffer: undefined }));
  } catch {
    /* 落盘失败不影响内存使用 */
  }
  return doc;
}

/** 文档状态补丁：terms / details / translations 都是「合并」语义 */
export function patchDocumentState(id, patch) {
  const doc = getDocument(id);
  if (!doc) return null;
  if (patch.terms) doc.terms = patch.terms;
  if (patch.removedKeys) {
    doc.removedKeys = Array.from(new Set([...(doc.removedKeys ?? []), ...patch.removedKeys]));
  }
  if (patch.details) doc.details = { ...doc.details, ...patch.details };
  if (patch.passages) doc.passages = { ...(doc.passages ?? {}), ...patch.passages };
  if (patch.translations) doc.translations = { ...doc.translations, ...patch.translations };
  if (patch.blockTranslations) {
    doc.blockTranslations = { ...(doc.blockTranslations ?? {}), ...patch.blockTranslations };
  }
  persistDocument(doc); // 术语增删也要落盘，重启/换进程不能丢
  return doc;
}

export function saveExport(buffer, filename) {
  const safe = filename.replace(/[\\/:*?"<>|]/g, "_");
  writeFileSync(join(EXPORT_DIR, safe), buffer);
  return { filename: safe, url: `/api/exports/${encodeURIComponent(safe)}` };
}

export const exportsDir = EXPORT_DIR;

export function listExports() {
  try {
    return readdirSync(EXPORT_DIR);
  } catch {
    return [];
  }
}
