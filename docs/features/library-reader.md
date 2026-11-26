---
doc_type: feature
---

# 书房阅读器

源码与扩展级回归位于 [muster-extension-library](https://github.com/zhanghexie/muster-extension-library)。扩展目录为 `library/`。

## 范围与决定

扩展 `library` 导航仍名为「图书馆」，面板为「书房」。用户明确不默认内置本地书城，并允许没有可靠在线源时改成本地阅读器。开源古籍仓库虽有目录/许可信息，实际正文域名、CDN 与 API 在本环境多次超时，故移除零散远程下载/发现入口，不用不可验证链接凑书城。产品不随包默认内置书籍正文，书籍由用户主动导入。

支持文字版 EPUB、TXT、Markdown。入口是系统文件选择器；保留书架、封面/列表、书名作者筛选、阅读状态、置顶、移出书架、继续阅读、可搜索目录、正文、书签和排版设置。

## 关键文件与数据流

- `library/client/importer.js`：从授权媒体 URL 读取文件；TXT 支持 UTF-8、UTF-16 BOM 和 GB18030 回退，按章标题拆分；Markdown 保留块/围栏；EPUB 按 container→OPF→spine 读取顺序，并用 nav/NCX 命名目录。正文提取为文本，脚本和外部资源不执行。
- `client/App.jsx`：书架、目录、阅读器、书签和排版；Markdown 使用现有 react-markdown，不执行原始 HTML，远程图片不自动加载。
- `client/reading-position.js`：段落锚点测量与恢复、串行进度写入和失败重试；延迟写捕获当时的 bookId/章节，旧失败不得覆盖新位置。
- `domain.mjs`：统一查询/命令，状态仅在写入成功后发布；内容哈希去重、合法章节/段落校验；导入失败不把半本书上架。
- `extension.json` / `agent.md`：当前领域工具 schema 与 Agent 行为说明；没有网络书城或读取任意路径的工具。

文件选择 → `ma.media.import` → 浏览器 HTTP 读取/解析 → `book.import` 传规范化文本 → worker 通用 data broker。原始媒体复制完成解析后 release，不把二进制塞进领域 IPC。解析结果按章持久化，最后写书架索引；重复导入同内容保留原进度。

## 数据与进度

宿主管理的工作区数据区：

- `library/index.json`：书目、阅读位置、状态和排版。
- `library/books/<内容哈希>/meta.json`：章节标题、字数和层级。
- `library/books/<内容哈希>/chapter-<index>.json`：规范化正文。
- `library/books/<内容哈希>/bookmarks.json`：段落书签。

不写源码包，跨实例重启可恢复。位置保存 chapterIndex、paragraphIndex、段内 offset 和章内 percent；全书百分比按章节字数加权，不用章节号直接乘 100。正文滚动合并写入，换章、返回书架、可见性变更会先 flush；字号/行距/版心变化按段落锚点恢复。保存错误显示「保存失败」和重试，保留待保存记录，阻止失败情况下悄悄换章。损坏数据显式报错，不当作空书架覆盖。

`book.remove` 表示移出书架，宿主按 dangerous 确认；不会删除磁盘原书。已导入章节数据保留在宿主数据区，不宣称回收了磁盘空间。

## 资源边界

每文件 20MB，规范化正文最多 200 万字/800 个章节片段；长章自动拆分且不删字。每章不超过 6 万字以满足宿主数据文件界限。最多 300 本、每本 200 个书签。EPUB 解压前按目录声明限制单文件/总展开量，跳过图片/字体等非正文资源；DRM 加密、PDF、扫描版和漫画型 EPUB 不在此文字阅读器范围内。

强退或断电仍可能丢失最后约 400ms 尚未发出的滚动位置；正常换章/返回会等待保存。EPUB 的复杂原页排版和插图不保留；本功能提供重新排版的文字阅读体验。

书架与阅读设置使用 SDK 面板、控件和选中态，书架和目录搜索聚焦时强调整个输入边框。书封配色与暖纸、夜读正文主题由阅读器保留。

## 验证

独立仓库的 `test/domain.mjs` 验证导入/去重、书签、检索、重开、进度校验、保存失败回滚与损坏数据；`test/panel.spec.tsx` 验证 EPUB 顺序与脚本剔除、TXT 分章、延迟保存顺序和实际 React 交互。Chromium 夹具验证滚动→返回→重开、字号变化保留段落、深浅/窄布局。Electron E2E 只模拟操作系统选中文件，实际媒体导入、HTTP、EPUB 解析、worker 和数据存储均真实执行。

截图样书为测试夹具生成的文本，不是产品内置书源。macOS/Linux 尚无真机验收，最终外观由用户验收。
