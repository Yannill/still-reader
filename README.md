# 静读 · Still Reader

作为本次C++小组大作业
原生 HTML、CSS 和 JavaScript 开发的 PDF 阅读器，提供收纳盒式书架、玻璃专注框、自动步进、标注与评论、笔记汇总和可配置的 AI 辅助阅读。

## 本地使用

Windows 下双击 `启动阅读器.bat`，或在项目根目录执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\serve.ps1
```

在浏览器打开 `https://lucent-pothos-40e0be.netlify.app/`。不需要安装 npm 依赖或运行构建。

## 网站文件

- `web/index.html`：网页入口。
- `web/css/`、`web/js/`：样式和业务代码。
- `web/vendor/`：本地 PDF.js、pdf-lib 和字体资源；部署时应一并保留，字体许可证位于 `web/vendor/fonts/`。
- `web/samples/sample.pdf`：项目自带测试样例。
- `tools/`：可重复运行的浏览器检查与样例工具；生成的截图不提交。

## 数据与 API 配置

导入的 PDF、阅读位置、标注和会话保存在浏览器 IndexedDB，设置保存在 localStorage。它们不会自动进入 Git 仓库。不同域名或浏览器之间不会自动同步书库。

AI Key 由使用者在网页设置中填写，源码中不包含真实 Key。启用 AI 标题、翻译或问答时，会按功能发送文字片段或页面图像至配置的服务。当前项目不包含 AI 代理后端。

不要将真实 Key、密码或凭据写入源码或提交到 Git。`.gitignore` 已排除环境变量文件、常见私钥、机器环境、生成结果及个人 PDF；项目自带的样例 PDF 为明确例外。

## 后续部署

这是无需构建的静态网页，实际发布目录为 `web`。后续连接托管平台时，应将该目录设为网站根目录，保留其相对资源路径。

本次 Git 准备不包含部署操作。有关现有实现和验证范围，见 `CODEX_PROJECT_AUDIT.md` 与 `CODEX_PHASE2_DELIVERY.md`。
