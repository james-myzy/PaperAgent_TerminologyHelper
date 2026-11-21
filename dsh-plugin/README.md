# dsh-paper-agent · 术语透视（DeepSeek Harness 插件）

把「术语透视」整页搬进 DeepSeek Harness：左侧栏多一个 **术语透视** 入口，点开就是带高亮的论文阅读界面，
原文、气泡解释、术语面板、选段解释、译文、导出、智能体追问全部与独立版一致 —— 而且**不需要再填 API Key**，
模型调用直接走 Harness 里已经配好的模型。

## 装（三种都行）

### 1. 在 Harness 界面里装（推荐给普通用户）

1. 把本目录放到任意位置，例如 `D:\dsh-plugins\dsh-paper-agent`；
2. 打开 Harness → 左侧 **插件** → **添加插件** → 选择「**安装第三方插件**」；
3. 在包名输入框里填**本地绝对路径**（`D:\dsh-plugins\dsh-paper-agent`），点安装；
4. 安装完成后启用这一项；左侧栏出现「术语透视」即成功（没出现就刷新一下页面）。

### 2. 用命令行装（和界面等价）

```powershell
cd $env:USERPROFILE\.dsh\profiles\web
pnpm add "file:D:/dsh-plugins/dsh-paper-agent"
```

然后把 `dsh-paper-agent` 追加到 `package.json` 的 `dsh.profile.bundles` 数组末尾，重启 `dsh web`。

### 3. 开发模式（改代码即时生效）

```powershell
cd $env:USERPROFILE\.dsh\profiles\web
pnpm add "link:D:/dsh-plugins/dsh-paper-agent"
# 同上，把 dsh-paper-agent 加进 dsh.profile.bundles
```

用 `link:` 装时，插件目录里要有自己的 `node_modules`（`cd D:\dsh-plugins\dsh-paper-agent; pnpm install`），
改完代码重启 Harness 即可看到新版本。

## 用

- 左侧栏 **术语透视** → 主区域整页阅读；
- 拖入 PDF / DOCX / TXT / MD，自动解析并识别术语；
- 点正文里的黄色术语 → 就地气泡（专业定义 / 上下文释义 / 相关引申）；
- 右侧术语面板：搜索、跳到原文、自己加词、删词；
- 划选一段 → 「解释选段」；点顶栏「双语对照」看中文（原文一段、译文一段交替出现，逐段流式生成）；
- 「导出高亮 Word」拿到带黄色高亮的 docx；
- 左上角「让智能体总结」/ 底部输入框 → 智能体自主调用精读、检索、术语等工具回答。

在对话里也可以直接使唤它（Harness 内置了 7 个工具）：

| 你说 | 工具 |
| --- | --- |
| 「术语透视里有哪些论文」 | `paper_list` |
| 「把 D:\xxx\paper.pdf 导进来分析」 | `paper_import` |
| 「打开刚导入那篇」 | `paper_open` |
| 「列一下这篇的术语」 | `paper_terms` |
| 「解释一下 scaled dot-product attention」 | `paper_explain`（解释过就缓存） |
| 「这篇论文的方法有什么局限」 | `paper_ask`（读全文再答） |
| 「重新识别一下术语」 | `paper_analyze` |

## 配置

在 `cordis.patch.yml` 里改（改完重启 Harness）：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `basePath` | `/paper-agent` | 页面挂载路径，改了这个要同步改 `lib/client.js` 里的 `FALLBACK_BASE`（只在取不到元信息时才用） |
| `provider` | `deepseek-official` | 走哪个模型路由 |
| `model` | `deepseek-flash` | 用哪个模型；换 `deepseek-v4-flash` 等都可以 |
| `maxSteps` | `6` | 阅读页智能体的最大工具步数 |
| `maxImportChunks` | `3` | `paper_import` / `paper_analyze` 默认抽取几块文本 |
| `maxTokens` | `4096` | 单次模型调用的输出上限 |
| `dataDir` | `<插件目录>/data` | 文档、导出、缓存落盘位置 |

## 目录结构

```
dsh-paper-agent/
├─ package.json          dsh.bundle（bundle patch）+ dsh.client（浏览器半边）
├─ cordis.patch.yml      插件行：挂载路径、模型、步数
├─ icon.svg
├─ lib/
│  ├─ index.js           宿主：挂路由、注入模型桥、注册工具
│  ├─ client.js          浏览器：侧边栏入口 + 主面板（iframe 承载阅读页）
│  ├─ dsh-llm.js         OpenAI 风格消息 ↔ ctx.llm 的桥
│  ├─ tools.js           7 个 paper_* 工具
│  └─ paper/             paper-agent 服务端源码副本（解析、术语、导出、智能体循环）
├─ web/                  以 /paper-agent/ 为 base 的前端构建产物
└─ data/                 运行期生成：docs / uploads / exports
```

## 它是怎么做到的

1. **同源复用**：宿主插件把阅读页（前端构建产物 + 本地 API）挂到 Harness 的 Web 服务
   `/paper-agent` 前缀上，和 Harness 同一个端口、同一份登录态，所以 iframe 不需要任何跨域配置。
2. **模型桥**：`lib/dsh-llm.js` 把 paper-agent 的 OpenAI 风格 `messages` / `tools` 转成 Harness 的
   `ctx.llm.stream()` 消息结构，再把流式块拼回 `{ text, toolCalls }`。于是术语抽取、解释、翻译、
   智能体工具循环全部复用 Harness 的模型与配额，插件里不需要任何 API Key。
3. **接口层**：`paper_*` 工具直接调用 paper-agent 的 store / terms / loop —— 和网页看到的是同一份数据，
   对话里解释过的术语，网页上再点开就是缓存结果。

## 常见问题

- **左侧没有「术语透视」**：刷新页面；仍没有就确认插件已启用（插件页里这一项是 On 状态）。
- **页面空白 / 一直加载**：打开 `http://127.0.0.1:3080/paper-agent/_meta.json` 看是否返回 JSON；
  没有说明宿主插件没挂上，检查 Harness 启动日志里的 `[paper-agent]` 行。
- **AI 不回答**：确认 Harness 本身的模型可用（新会话能聊）；插件沿用同一个模型。
- **之前导入的论文不见了**：插件在启动时从 `data/docs` 恢复文档；重启 Harness 后就会回来。
- **想换模型**：改 `cordis.patch.yml` 里的 `provider` / `model`，重启。
- **想卸载**：插件页点 Remove，或从 `package.json` 的 `dsh.profile.bundles` 里删掉该项。

## 已知限制

- 阅读页是 iframe，浏览器缩放用的是页面自己的缩放条（60%–260%），不跟随系统缩放；
- 扫描件（无文字层 PDF）仍需先 OCR；
- 导出 Word 保留段落与高亮，不含表格/公式的结构化还原；
- 只有 Windows 验证过（Harness 的 Web 侧本身跨平台，插件代码没有平台相关调用）。
