# 参与开发

## 本地环境

- Node.js 20 以上（开发时用的是 24）
- Windows 10/11（服务端和插件本身跨平台，测试脚本里的浏览器路径目前写的是 Windows Chrome）

```bash
npm install --ignore-scripts   # --ignore-scripts 见 README 说明
cp .env.example .env           # 填 LLM_API_KEY；不填则进入离线演示模式
npm run build                  # 前端构建到 web/dist
npm start                      # http://127.0.0.1:8787
```

## 提交前自查

1. **不要提交 `.env`**：里面是本机的模型 Key。仓库里只保留 `.env.example`。
2. **不要提交 `data/`**：里面有测试时上传的论文和导出文件。
3. 改了前端或服务端，跑一遍回归（需要本机 Chrome，且服务已启动）：

```bash
node scripts/smoke.mjs             # 智能体链路
node scripts/reader-check.mjs      # 阅读器 + 气泡 + 面板 + 双语 + 抽屉
node scripts/bilingual-check.mjs   # 双语对照（逐段翻译 + 缓存）
node scripts/explain-cache-check.mjs
node scripts/passage-cache-check.mjs
node scripts/term-locate-check.mjs
```

4. 改了服务端接口，同步更新 README 的「接口」表。

## 代码约定

- 服务端只用 Node 内置模块 + `docx` / `mammoth` / `pdfjs-dist` 三个依赖，不引入框架；
- 前端不引入 UI 库，样式集中在 `web/src/styles.css`；
- 新增能力优先复用现有缓存层，避免对同一内容重复调用模型；
- 中文注释、中文文案；接口字段用英文。

## 打包

```bash
npm run pack        # 源码包  → ../paper-agent-portable.zip
npm run pack:win    # 便携版  → ../paper-agent-portable-win64.zip
node scripts/build-dsh-plugin.mjs   # DSH 插件 → D:\dsh-plugins\dsh-paper-agent
```

便携版与插件版都需要先构建对应的前端：

```bash
# 便携版（默认 base /）
node node_modules\vite\bin\vite.js build --config web/vite.config.ts

# DSH 插件（base /paper-agent/）
$env:PAPER_BASE='/paper-agent/'; $env:PAPER_OUT='web/dist-paper'
node node_modules\vite\bin\vite.js build --config web/vite.config.ts
```
