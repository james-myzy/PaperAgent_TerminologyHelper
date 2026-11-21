# 「术语透视」DSH 插件：实现说明与验证记录

> 目标：把独立运行的论文术语分析助手（paper-agent）完整搬进 DeepSeek Harness（下称 DSH），
> 在 Harness 界面里直接查看高亮论文、点术语看解释、追问智能体，并且**不要求用户再配置 API Key**。

---

## 一、为什么这样做（方案选择）

DSH 的插件体系是 Cordis 插件 + 两种半边：

- **宿主半边**（Node）：可以注册工具（`ctx.tools.register`）、挂 HTTP 路由（`webServer.register({ kind: 'prefix' })`）、
  使用 `ctx.llm` 调模型；
- **浏览器半边**（`dsh.client` + `lib/client.js`）：可以往侧边栏 `sidebar.panellist` 注册入口、
  往主区域 `main` keyed slot 注册页面组件。

由此有三条路：

| 方案 | 工作量 | 风险 | 结论 |
| --- | --- | --- | --- |
| A. 用 React 重写整套阅读界面 | 很大 | 版式保真、PDF 覆盖层、选区交互都要重做，容易出现两套实现不一致 | 否 |
| B. 宿主挂载原应用 + 浏览器半边 iframe 承载 | 中 | 同源、同端口，几乎没有兼容问题 | **采用** |
| C. 只做工具、不做界面 | 小 | 用户看不到高亮原文，达不到“在 Harness 里读论文” | 否 |

选 B。做法是：

1. 把 paper-agent 的服务端与前端构建产物一起打进插件包；
2. 宿主把整个应用挂在 DSH Web 服务的 `/paper-agent` 前缀上（同源、同端口、同登录态）；
3. 浏览器半边在侧边栏加「术语透视」入口，主面板用 iframe 承载该页面；
4. 额外注册 7 个 `paper_*` 工具，让 Harness 的智能体也能直接读这份文档。

这样阅读页里的所有功能（高亮、气泡、术语面板增删、选段解释、译文、检索、导出、智能体抽屉、三层缓存）
都是同一份代码，不存在“插件版少几个功能”的问题。

---

## 二、关键技术点

### 2.1 同一进程内复用 paper-agent

`server/index.mjs` 原本在模块加载时直接 `createServer().listen()`。为了能被插件复用，做了最小改造：

```js
export function createRequestHandler({ base = "", webDist = WEB_DIST } = {}) { ... }
```

- 插件传入 `{ base: "/paper-agent", webDist: <插件>/web }`；
- 独立运行仍然走 `isEntryPoint` 分支，行为不变；
- 请求进来先剥掉 `/paper-agent` 前缀，之后的路由、静态文件、SSE 全部照旧。

前端也做了同样的前缀适配：`api.ts` 里所有请求都过 `apiUrl()`，前缀来自 Vite 的 `BASE_URL`；
`vite.config.ts` 支持 `PAPER_BASE` / `PAPER_OUT` 两个环境变量，于是同一份源码可以产出两个构建：

| 构建 | 命令 | 产物 | 用途 |
| --- | --- | --- | --- |
| 独立版 | `vite build` | `web/dist` | `npm start`，监听 8787 |
| 插件版 | `PAPER_BASE=/paper-agent/ PAPER_OUT=web/dist-paper vite build` | `web/dist-paper` | 挂在 DSH 的 `/paper-agent/` |

### 2.2 模型桥：把 OpenAI 风格调用接到 `ctx.llm`

paper-agent 的全部模型调用都收敛在 `llm` 对象上（`streamChat` / `completeChat`）。新增一个可注入的
transport 层（`server/llm-transport.mjs`）：

```js
llm.streamChat(args)  →  transport ? transport.streamChat(args) : 直连 OpenAI 兼容接口
```

插件注入的 transport 在 `lib/dsh-llm.js` 里，负责两件事：

1. **消息转换**：把 `{role:'system'|'user'|'assistant'|'tool'}` 转成 DSH 的消息结构
   （assistant 的 `tool_calls` → `tool-call` 内容块；tool 消息 → 带 `toolCallId` 的 tool 角色消息）；
2. **流式回收**：把 `text-delta` / `tool-call-delta` 拼回 `{ text, toolCalls, finishReason }`。

实测（在测试 profile 里用探针插件验证）：
- 单轮文本调用正常；
- 工具调用两轮往返正常（模型发起 `get_weather` → 回灌结果 → 模型基于结果回答）。

因此术语抽取、术语解释、选段解释、翻译、智能体工具循环都走 DSH 的模型与配额，
**插件里不需要 API Key**。前端首页也从「模型 API Key」变成「由 DeepSeek Harness 提供」。

### 2.3 浏览器半边

`lib/client.js` 用 Harness 的 lazy-CJS 模块格式（`window.__ModuleLoader__.load({ id, factory })`），
只依赖运行时模块表里的 `react`，不需要额外构建步骤：

```js
ctx.slots.inject("main", () => ctx.slots.register({ name: "main", key: "paper-agent" }, Page));
ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({ name: "sidebar.panellist", id: "paper-agent", order: 1, label: "术语透视" }, Icon));
```

页面组件先读 `/paper-agent/_meta.json` 拿到真实挂载路径（避免写死），再渲染工具栏（刷新、新窗口）+ iframe。

### 2.4 7 个宿主工具

| 工具 | 作用 |
| --- | --- |
| `paper_list` | 列出已导入论文（标题/页数/字数/术语数） |
| `paper_open` | 给出阅读页链接（可带文档 id） |
| `paper_terms` | 列出术语（可按名字过滤） |
| `paper_explain` | 解释术语，命中缓存则不调模型 |
| `paper_ask` | 就当前论文提问，走 paper 的智能体循环（精读/检索/术语工具） |
| `paper_analyze` | 重新识别术语并写回高亮 |
| `paper_import` | 从本机路径导入 PDF/DOCX/TXT/MD 并识别术语 |

这些工具直接操作 paper 的 `store` / `terms` / `loop`，与网页共享同一份文档状态与缓存。

### 2.5 顺带修掉的两个问题

1. **标题误判**：Attention 那篇 PDF 的首行是 Google 的授权声明，旧逻辑把整段版权声明当标题。
   现在会在前 14 行里找「多词、Title Case/全大写、非法律声明、非机构行」的一行作为标题，
   实测标题恢复为 `Attention Is All You Need`。
2. **重启丢文档**：`store` 之前只在内存里维护文档表，进程重启后磁盘上的文档不再列出。
   现在启动时从 `data/docs/*.json` 恢复（`hydrateDocuments()`），重启后旧论文仍在。

---

## 三、验证记录

测试环境：Windows 11 / Node 24.21 / DSH 0.2.1-rc.5 / `deepseek-official` + `deepseek-flash`。

用一个**独立的测试 profile**（`papertest`，端口 3099）验证，避免影响正在使用的 `web` profile：

| 步骤 | 结果 |
| --- | --- |
| 启动测试实例并加载插件 | 左侧栏出现「术语透视」入口 |
| 点入口 | 主面板出现工具栏 + 阅读页，iframe 正常加载 |
| 拖入 `attentionisallyouneed.pdf` | 解析 1.6 秒；15 页 / 39,628 字 |
| 自动识别术语（走 `ctx.llm`） | 42 秒识别 66–90 个术语（每次识别随机波动） |
| 版式视图 | 首屏 19 处覆盖高亮；缩放正常 |
| 切「原文」 | 248 个 `mark` 元素，正文高亮正常 |
| 点术语 | 气泡流式输出三段式解释（真实模型） |
| 「让智能体总结」 | 自动调用 document_overview / extract_terms / read_document ×5 / search_document ×2，输出三点总结 |
| 导出高亮 Word | 下载 `Attention Is All You Need_术语高亮_2026-11-20.docx` |
| 装进正在使用的 `web` profile | 热加载成功：`/api/health` 返回 `provider: dsh, managed: true` |
| 在 Harness 会话里调用 `paper_import` | 导入同一篇 PDF，识别 64 个术语，返回 `?doc=` 链接 |

截图：`shots/dsh-3-reader.png`（版式视图）、`dsh-4-text.png`（原文高亮）、`dsh-5-popover.png`（气泡）、
`dsh-6-agent.png`（智能体三点总结）。

---

## 四、交付物与安装

插件目录：`D:\dsh-plugins\dsh-paper-agent`
源码与构建脚本：`paper-agent/dsh-plugin/` + `paper-agent/scripts/build-dsh-plugin.mjs`

重新构建：

```powershell
cd D:\dsh_program\paper-agent
$env:PAPER_BASE='/paper-agent/'; $env:PAPER_OUT='web/dist-paper'
node node_modules\vite\bin\vite.js build --config web/vite.config.ts
node scripts\build-dsh-plugin.mjs
```

安装到某个 DSH profile（以 `web` 为例）：

```powershell
cd $env:USERPROFILE\.dsh\profiles\web
pnpm add "file:D:/dsh-plugins/dsh-paper-agent"
# 再把 dsh-paper-agent 追加到 package.json 的 dsh.profile.bundles
```

或直接在 Harness 的「插件 → 添加插件」里填本地路径。

---

## 五、限制与后续

- 阅读页以 iframe 承载，Harness 的主题切换不会传进去（阅读页有自己的浅色主题，这是刻意的阅读配色）；
- 插件升级目前靠「卸载再装」或重新 `pnpm add`，还没做版本号自更新；
- 扫描件仍需 OCR；导出 Word 不含表格/公式的结构化还原；
- 后续可以把 `paper_*` 工具扩展成「批注」「对比阅读」「术语本导出」。

---

## 六、分发与版本

- 可分发包：`D:\dsh_program\paper-agent-dsh-plugin.zip`（约 0.64 MB，不含 node_modules；对方 `pnpm install` 一次即可）
- 解压后目录名保持 `dsh-paper-agent`；在 Harness「插件 → 添加插件 → 安装第三方插件」里填这个绝对路径即可。
- 当前版本：1.0.1（1.0.0 → 1.0.1：修掉插件污染宿主 `process.env` 导致独立版误判模型的问题；标题识别与文档恢复也在这一版）
