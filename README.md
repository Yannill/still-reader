# 静读 · Still Reader

作为本次C++小组大作业
原生 HTML、CSS 和 JavaScript 开发的 PDF 阅读器，提供收纳盒式书架、玻璃专注框、自动步进、标注与评论、笔记汇总和可配置的 AI 辅助阅读。

## 本地使用

Windows 下双击 `启动阅读器.bat`，或在项目根目录执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\serve.ps1
```

在浏览器打开 `http://localhost:8080/`。不需要安装 npm 依赖或运行构建。

当前阅读器提供逐行阅读和可拖动、缩放的自由玻璃窗。历史版本的交付记录见 [V17_AUDIT_AND_DELIVERY.md](V17_AUDIT_AND_DELIVERY.md)。检查当前版本可在项目根目录运行以下命令，浏览器检查使用独立的临时 Chrome 资料。

```powershell
node tools/v17-core-check.cjs
node tools/v17-browser-check.mjs
node tools/v18-import-check.mjs
```

若当前系统不能使用 PowerShell HttpListener，但已安装 Node，可在项目根目录运行 `node tools/serve.mjs 8080`。

V1.8 的[字体对照 Demo](web/design-preview/typography/index.html)可直接用浏览器打开。[视觉交付记录](V18_VISUAL_DELIVERY.md)包含四套字体比较、前后截图及导入回归结果。

## 网站文件

- `web/index.html`：网页入口。
- `web/css/`、`web/js/`：样式和业务代码。
- `web/vendor/`：本地 PDF.js 4.2.67、pdf-lib 和字体资源；部署时应一并保留，字体许可证位于 `web/vendor/fonts/`。
- `web/samples/sample.pdf`：项目自带测试样例。
- `tools/`：可重复运行的浏览器检查与样例工具；生成的截图不提交。

## 数据与 API 配置

导入的 PDF、阅读位置、标注和会话保存在浏览器 IndexedDB，设置保存在 localStorage。它们不会自动进入 Git 仓库。不同域名或浏览器之间不会自动同步书库。

AI Key 由使用者在网页设置中填写，源码中不包含真实 Key。导入时在本机提取标题。使用 AI 翻译或问答时，会按功能发送文字片段或页面图像至配置的服务。当前项目不包含 AI 代理后端。

不要将真实 Key、密码或凭据写入源码或提交到 Git。`.gitignore` 已排除环境变量文件、常见私钥、机器环境、生成结果及个人 PDF；项目自带的样例 PDF 为明确例外。

## 后续部署

这是无需构建的静态网页，实际发布目录为 `web`。后续连接托管平台时，应将该目录设为网站根目录，保留其相对资源路径。

本次 Git 准备不包含部署操作。有关现有实现和验证范围，见 `CODEX_PROJECT_AUDIT.md` 与 `CODEX_PHASE2_DELIVERY.md`。
