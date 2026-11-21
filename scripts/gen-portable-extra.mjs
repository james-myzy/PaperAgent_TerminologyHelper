/**
 * 生成便携版里的启动脚本与说明（UTF-8 安全）。
 * 用法：node scripts/gen-portable-extra.mjs <stage目录>
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const stage = process.argv[2];
if (!stage) {
  console.error("需要传入 stage 目录");
  process.exit(1);
}

const START_BAT = `@echo off
setlocal
cd /d "%~dp0"
title Paper Agent
if not exist "runtime\\node.exe" (
  echo [ERROR] runtime\\node.exe not found. Please re-extract the zip.
  pause
  exit /b 1
)
echo Starting Paper Agent, please wait...
"runtime\\node.exe" "app\\launcher.mjs"
if errorlevel 1 (
  echo.
  echo Startup failed. Copy the messages above when asking for help.
  pause
)
`;

const NOTE = `术语透视 · 论文术语分析助手（便携版）
============================================

【怎么启动】
1. 把压缩包解压到任意目录（路径别太深，中文路径也可以）
2. 双击  "启动.bat"
3. 等 1-3 秒，浏览器会自动打开；如果没打开，手动访问窗口里显示的地址
   默认是 http://127.0.0.1:8787 （被占用会自动换端口，以窗口提示为准）
4. 关闭：直接关掉那个黑色窗口，或按 Ctrl+C

【第一次使用】
- 打开页面后，左下角有「模型 API Key」，点「填写」把 Key 粘进去保存。
  保存后会记住，下次不用再填。
- 不填 Key 也能用界面（离线演示模式），但回答内容是脚本化的。

【数据存在哪】
- 上传的文档、术语、译文、导出的 Word 都在 app\\data 目录里。
- 想彻底重置：删掉 app\\data 目录即可。
- 换电脑/备份：整个文件夹拷走就行，data 一起带走。

【常见问题】
1) 双击后窗口一闪而过
   说明启动失败。右键 启动.bat → 以管理员身份运行试试；
   或打开 cmd，把 启动.bat 拖进去回车，能看到具体报错。
2) Windows 提示"已保护你的电脑"
   点「更多信息」→「仍要运行」。这是因为 exe 没有数字签名，不是病毒。
3) 端口 8787 被占用
   启动器会自动往后找 8788、8789… 窗口里会打印实际地址。
4) 杀毒软件报警/删除 node.exe
   把整个文件夹加入白名单（内置的是官方 Node.js 运行时）。
5) 页面能打开但 AI 不回答
   检查首页「模型 API Key」是否已配置；或看窗口里的报错信息。

【这是什么】
内置了 Node.js 运行时（runtime\\node.exe），所以电脑上不需要安装 Node/npm。
仅支持 Windows 10/11 64 位系统。
`;

const LICENSE = `This package bundles the Node.js runtime (runtime/node.exe).
Node.js is licensed under the MIT license.
Copyright Node.js contributors. All rights reserved.
See https://nodejs.org/en/about/previous-releases for details.
`;

writeFileSync(join(stage, "启动.bat"), START_BAT, "utf8");
writeFileSync(join(stage, "start.bat"), START_BAT, "utf8");
writeFileSync(join(stage, "使用说明.txt"), NOTE, "utf8");
mkdirSync(join(stage, "runtime"), { recursive: true });
writeFileSync(join(stage, "runtime", "LICENSE-node.txt"), LICENSE, "utf8");
console.log("启动脚本与说明已生成");
