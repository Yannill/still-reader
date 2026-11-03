# 第二阶段交付：静读 · Still Reader

日期：2026-11-03。依据 `CODEX_PHASE2_PLAN.md`，在原项目上增量开发，沿用原生 JS / `R.*` / 本地 PDF.js 与 pdf-lib；没有新增框架、JS 依赖或构建步骤，没有发布网站。

## 已完成的主要改造

- 纸、墨、硫酸纸与金属的暖色体系；西文衬线与等宽字体以两份拉丁 woff2 本地加载，合计约 40KB，附 OFL 许可。中文使用系统衬线回退。背景纹理不覆盖 PDF。
- 收纳盒式书架：层板、立柱、磨砂盒前板、取物孔、标签、封面/书脊、页数驱动宽度、进度丝带、固定展签。空盒收敛成标签。
- 多选和拖放导入；盒子增删改；书籍菜单、重命名、拖动/菜单移动、带明确说明的删除确认；搜索原位淡化；列表与排序；视图、筛选、搜索和滚动位置本地保存。
- 取书预览与 PDF 并行准备；预览继续/从头读；双击或 Shift+Enter/继续读可直接阅读；View Transitions 与 Web Animations 回退；减少动态、快速点击锁和首轮帧时间降级。预览不调用阅读器单例渲染页面。
- 阅读器书脊栏、页码输入/前后翻页、目录/缩略页、适宽/整页、默认原色和可选暖纸/灰纸、整段专注、Aa 统一设置；保留专注框、步进、番茄钟、停车场和扫描行检测。
- 标注与翻译换肤、自由框选、页边评论墨点；保留 PDF 写回及 Markdown 笔记导出。AI 面板采用记录式排版，增加重试与发送范围说明。
- 跨书笔记及分类筛选、点击定位、停车场汇总；今日统计、近 14 天细条图和继续阅读的专注页。
- 1440 / 1024 / 390px 布局、窄屏底部抽屉、书籍按钮和方向键导航；标注工具补充触控 Pointer Events。

## 数据与稳定性

IndexedDB `adhd-reader` 从 v1 增量升级到 v2，只新增 `boxes`，不删除或清空已有 store。旧文档读取时补默认分类，新封面与主色按需补算。重命名保留原 `name`，删除盒子将书移至“未归档”。导入文件/元数据和删除关联记录使用跨 store 原子事务。

修复了审计中的快速回首页漏存进度、切书漏存标注、继续阅读排序、AI 异步响应跨书污染；补充防重复打开、适宽状态保持、容器尺寸监听和失败反馈。自动标题写回检查当前文档是否存在、是否已被用户改名。

所有迁移和删除验收均在独立临时 Chrome 配置中执行，没有清理或测试用户正常浏览器的书库。

## 验证结果与截图

完整隔离回归脚本：`tools/phase2-check.mjs`。交付用结果与截图在 `tools/phase2-delivery/`，包括迁移、多文件导入、搜索位置不变、盒子管理、拖放与菜单移动、书籍删除、重命名、刷新恢复、方向键、十次快速预览、减少动态、整段导航、保存、导出回读和移动布局。

- 25 项检查通过；其中整段导航样例一次跨 4 行。
- v1 样本升级后，原 PDF、中文评论、会话和停车场仍在；旧文档默认进入“未归档”。
- 快速回首页保存页/行位置；切书前新增标注被保存；导出 PDF 回读数量一致。
- 390px 模拟下文档宽度为 390px，打开 AI 抽屉后阅读区仍为 348px，不再挤为 0。
- 全部 16 个业务 JS 通过 `node --check`；PowerShell 工具通过语法解析；HTML 无重复 id。
- 业务 UI 的 JS/CSS/HTML 中未检出计划禁用的三个蓝紫色值或 `linear-gradient(135deg`。第三方 PDF 库与历史审计/计划文档不因配色要求改写。

按计划使用项目原有 `tools/cdp.ps1` 在 **1440×900 / 1024×768** 生成阶段截图：

- `tools/phase2-qa-1440/shot1.png` 至 `shot7.png`
- `tools/phase2-qa-1024/shot1.png` 至 `shot7.png`

最终阅读器专项回归及截图：

- `tools/phase2-reader-final1440/`、`tools/phase2-reader-final1024/`
- Aa 中缩放/适宽、滚轮逐行、H/U/C、中文评论、矩形框选、撤销、PDF 导出回读、mock 翻译存评论、受控失败后 AI 重试、Shift+Enter 进入与返回书架均通过。
- 控制台只有已知的可选 `wasm/reader_core.js` 404，以及样例 PDF 的索引修复提示；未捕获新的未处理 JavaScript 异常。

截图中的书与记录来自测试样本，不是向正式书库注入的演示内容。

## 修改与新增文件

已有文件修改（15 个）：

```text
serve.ps1                         增加 woff2 MIME
web/index.html                    导航、页面、预览、管理与阅读设置外壳
web/css/style.css                 设计变量、换肤、书架、响应式
web/js/util.js                    可 flush 的 debounce、确认浮层、动态偏好
web/js/db.js                      v2 迁移、事务、版本连接管理
web/js/library.js                 文档默认字段、缩略图/色调、原子导入、稳定元数据
web/js/app.js                     路由、保存边界、打开互斥、阅读状态
web/js/viewer.js                  复用预加载 PDF、整页适配、纸张层、锚点
web/js/focus.js                   状态清理、整段步进、保持原行导航
web/js/annotate.js                文档快照保存、框选、触控、评论标记
web/js/translate.js               翻译样式、旧文档卡片操作保护
web/js/chat.js                    请求归属、重试、说明、记录排版
web/js/adhd.js                    避免统计读取覆盖未保存增量
web/js/settings.js                如实说明代理与 AI 起标题外发行为
tools/cdp.ps1                     隐藏启动、精确视窗、断言失败返回错误
```

新增：`web/js/study.js`、`web/js/reader.js`；`web/vendor/fonts/` 两个 woff2 和两个许可证；`tools/phase2-check.mjs`、`tools/phase2-cdp-steps.js`、`tools/phase2-reader-check.js`、`tools/phase2-rename-check.js`；验收截图/结果和本说明。

`core.js`、`ai.js`、`pdfsave.js`、原始样例和已打包 PDF 库均保持原文件内容，保留既有核心算法与 PDF 输出实现。

## 与计划的细节差异及未验收项

- 阶段 8 双语阅读是可选项，本次未加入，也没有显示无功能入口。
- 收纳盒名称通过标签打开轻量管理浮层编辑；新增入口位于书架末尾，而非每层都重复一个。未实现标签原位输入。
- 书架采用每层最多两个盒子的稳定排列，盒内可滚动；尚未按内容动态计算盒子的整行宽度。长西文标题依然依赖竖排省略和展签查看。
- 目录点击可定位与选中；尚未实现滚动时自动追踪 PDF 章节标题。
- 动画兼容路径已在本机 Chrome 验证，低帧率降级的真实低端硬件效果、其它浏览器的回退仍需设备验收。移动端是模拟视窗和事件验证，不等于真实 iOS/Android 的长按选词验收。
- 真实 AI、免费翻译、图片识别未联网验收；测试使用 mock 与受控失败。未假设 `/api/ai/chat` 存在，未读取用户 Key。加密/超大/复杂原注释 PDF 与其它 PDF 阅读器兼容仍需专项验收。

## 查看与复验

双击根目录 `启动阅读器.bat` 即可使用；也可运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\serve.ps1
```

保持使用原来的 `http://localhost:8080/` 地址，确保进入原来的浏览器存储空间。首次加载会执行无清库的 v2 升级。

在本地服务运行且已安装 Chrome / Node 的环境中可复验：

```powershell
node tools/phase2-check.mjs tools/phase2-local-check
powershell -NoProfile -ExecutionPolicy Bypass -File tools/cdp.ps1 -Url 'http://localhost:8080/?open=samples/sample.pdf' -StepsFile tools/phase2-cdp-steps.js -Out tools/phase2-local-shots -Width 1440 -Height 900
```
