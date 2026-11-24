# 静读 · Still Reader

> 作为本次 C++ 小组大作业的网页端阅读器实践项目。

原生 HTML、CSS 与 JavaScript 构建的轻量 PDF 专注阅读器，无需构建工具即可本地运行，也支持一键部署到 Cloudflare Workers / Netlify，适配桌面端与 iPad 横竖屏。

- **在线体验（Cloudflare Workers）**：https://still-reader.nilyann404.workers.dev/  
  （`*.workers.dev` 在部分国内网络环境下可能需要代理访问，也可在 Cloudflare 绑定自定义域名实现国内直连。）

---

## 核心功能

### 1. 收纳盒式书库与文档管理
- **拟物收纳盒书架**：白 / 灰 / 烟黑三款半透文件盒，支持新建、重命名、拖拽排序与删除恢复。
- **导入选盒与批量导入**：支持文件选择与桌面拖入 PDF，写入书库前统一选择目标收纳盒（书架发起默认「未归档」，盒内发起预选当前盒），支持批量共用目标盒与取消导入。
- **导入时间与跨盒移动**：「未归档」中的每份 PDF 记录并显示实际导入日期与时间（旧记录缺失时显示「导入时间未知」）；桌面端拖动 PDF 自动高亮可放置收纳盒，iPad 与桌面均支持点击「移动到…」快速跨盒整理。
- **清爽书籍预览**：点击封面可查看阅读进度、修改书名、移动收纳盒，或直接「继续阅读 / 从头读」。

### 2. 专注阅读与玻璃透镜
- **双模式专注玻璃框**：
  - **逐行阅读**：与页面或分栏同宽的通栏玻璃框，滚轮 / 方向键 / 空格精准逐行推进，支持自动步进与步进进度条。
  - **自由玻璃窗**：支持拖动框体与四边/四角自由缩放，拖至边缘自动翻页。
- **左侧独立目录**：桌面端为可折叠左侧栏，iPad 横竖屏从左侧滑出可关闭抽屉；与右侧批注 / AI 面板完全独立操作。
- **标注、笔记与导出**：支持高亮、下划线、评论、自由框选、擦除与撤销；可将标注直接写回 PDF 下载（`pdf-lib`），或导出为 `.md` 笔记；附带笔记汇总页、番茄钟、阅读统计与「杂念停车场（快捷键 `N`）」。

### 3. 内置 AI 助手与就地翻译
- **可折叠快捷提问**：「总结本页」「解释当前句」「出 3 道小测」「这段为什么重要」归入「快捷提问」面板，支持一键收起与展开。
- **清晰的发送内容控制**：在「随问题发送的内容」中独立开关「本页内容」（提取当前页文字，扫描页在模型支持图片时可附页图）与「专注框内文字」（开启专注时附上框内文字），并支持可移除的选中文本引用。
- **内置跨域代理**：支持 OpenAI、DeepSeek、通义千问、Kimi、智谱 GLM、豆包及自定义 OpenAI 兼容接口（亦提供「离线演示」模式）；内置 `/api/ai/chat` 同源流式代理，浏览器直连受 CORS 拦截时自动切换。

### 4. 本地优先 + 可选多端云同步
- **本地优先**：不登录即可离线完整使用，PDF 原件、阅读进度、批注、对话与收纳盒保存在浏览器 IndexedDB，偏好设置与 AI API Key 仅存本机 `localStorage`。
- **Supabase 云同步**：登录后自动双向同步文件夹、阅读进度、批注、AI 对话、统计及单文件 ≤ 25 MB 的 PDF 原件；**AI API Key 始终仅留本机，不上传云端**。

---

## 本地运行

Windows 下直接双击 `启动阅读器.bat`，或在项目根目录运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\serve.ps1
```

在浏览器打开 `http://localhost:8080/` 即可使用（内置静态服务与 `/api/ai/chat` 本地代理，无需安装 npm 依赖或构建）。

---

## 项目结构

```text
.
├── web/                        # 前端静态站点（发布根目录）
│   ├── index.html              # 页面入口
│   ├── css/style.css           # 全局样式（桌面 / iPad 横竖屏适配）
│   ├── js/                     # 模块化前端逻辑（阅读器、专注框、标注、AI、书库、云同步）
│   ├── vendor/                 # 本地 PDF.js 4.2.67、pdf-lib 与字体资源
│   └── samples/sample.pdf      # 内置测试样例 PDF
├── worker/index.js             # Cloudflare Worker 入口（/api/ai/chat 代理 + Static Assets）
├── wrangler.jsonc              # Cloudflare Workers + Workers Static Assets 部署配置
├── netlify/functions/          # Netlify Function 版 /api/ai/chat 代理
├── serve.ps1                   # Windows 零依赖本地静态与 AI 代理服务器
├── 启动阅读器.bat               # Windows 一键启动脚本
└── tools/                      # 自动化检查与调试脚本（含云同步检查与 CDP 测试脚本）
```

---

## 部署方式

### Cloudflare Workers（当前线上方案，免费额度充足）
项目已内置 `wrangler.jsonc` 与 `worker/index.js`（静态资源由 Workers Static Assets 直接托管，不消耗 Worker 请求额度，仅 `/api/ai/chat` 触发 Worker）：

1. 在 [Cloudflare Workers & Pages](https://dash.cloudflare.com/) 创建应用并连接本 GitHub 仓库（分支 `main`）。
2. **Build command** 留空，**Deploy command** 保持默认 `npx wrangler deploy`。
3. 如需在国内免代理直连访问，在 Worker 的 **Settings → Domains & Routes** 免费绑定自定义域名即可。

### Netlify
项目同样保留了 `netlify/functions/ai-proxy.mjs`，将发布目录设为 `web` 即可直接部署。

---

## 安全与测试

- 请勿将真实 API Key、密码或凭据提交到 Git 仓库；`.gitignore` 已忽略环境变量、密钥、构建缓存及个人 PDF（仅保留 `web/samples/sample.pdf` 样例）。
- 若本机已安装 Node.js，可运行 `node tools/cloud-sync-check.cjs` 验证云同步冲突合并与离线恢复逻辑。
- 历史阶段设计记录见 `CODEX_PROJECT_AUDIT.md` 与 `CODEX_PHASE2_DELIVERY.md`。
