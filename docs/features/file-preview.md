# 文件预览（全格式分层）

## 功能职责

FilesPanel 的 FileEditor 按**扩展名分类**把文件分流到五种预览形态，覆盖主流格式；GUI 聊天里的文件链接（`ws-file-link`）按类型自动配**类型图标**。分类唯一依据是 `src/shared/filePreview.ts`（纯扩展名，无 Node 依赖）。

Markdown 预览的 `onMdLink` 保持稳定，点击时从 `jumpCtxRef` 读取当前文件路径和导航回调，再解析相对目标并进入既有 FilesPanel 闸口；切屏/回调换引用不触发正文重解析，切文件后的点击仍使用新目录。`MarkdownBody` 的样式外层与解析内层独立 memo，正文/真实抑制路径变化仍更新。回归见 `test/unit/file-editor-markdown-memo.spec.tsx`，真机证据见 [performance.md](performance.md) §18。

编辑与预览滚动条共用 8px 自定义轨道；文件区域局部将标准 `scrollbar-width` / `scrollbar-color` 置为 `auto`，避免标准滚动条覆盖 Chromium 的 `::-webkit-scrollbar` 样式、出现系统箭头和不同轨道尺寸。CodeMirror 的 `.cm-scroller` 用 `flex:1 1 0`、`height:auto` 与零最小尺寸约束在宿主内，避免横向滚动条超出裁剪边界。回归见 `test/unit/file-editor-scrollbars.spec.ts`；真实 FileEditor 浏览器夹具为 `test/fixtures/file-editor-scrollbars.tsx` 与对应 scenario，运行 capture-component 时加 `--show-scrollbars`，否则无头浏览器默认隐藏滚动条，截图无法验收其绘制。

设置页 `capability-management.css` 的输入框必须用 `textarea.cm-editor` 限定元素类型：CodeMirror 也使用 `.cm-editor`，裸类规则会将设置文本框的 12px padding、16px margin-top 和 300px min-height 泄漏到代码编辑器，导致纵轨内缩、横轨超出宿主底部。滚动夹具同时加载该设置样式以拦截跨模块污染；2026-10-15 已在运行中的 Electron 窗口读取确认，修复后 CodeMirror margin/padding 为 0，滚动区域右边/底边与宿主相同。

文件监听触发的文本回读先按 CodeMirror 的换行规则比较正文，然后用一笔事务替换变化区间，保留共同前后缀对应的选区、装饰和渲染节点。文件冲突仍走原有提示，程序化回读沿用自动保存抑制。后台布局配置标签的回归见 `test/unit/file-editor-roots.spec.tsx`。

## 预览形态与支持矩阵

Markdown 的静止阅读清晰度依赖整条祖先链：正文取消 paint 隔离和合成提示之外，`App.tsx` 的横向条带使用 2D `translateX`，`.h-strip.vs-axis` 不常驻 `will-change:transform`，`.ws-rail-idle` 显式恢复 `will-change:auto`。避免常驻 GPU 合成使 Windows 下文字失去次像素抗锯齿而发虚；保留原 transform transition 和移动中的工作区合成提示。回归见 `test/unit/reading-compositing.spec.ts`。2026-10-19 在 Windows Electron 同一可见文档上临时样式对照确认边缘绘制差异，macOS/Linux 未真机验证。

宿主正文、编辑器与预览工具共用 `ResolvedAppearance` 的画布/工具/输入角色；普通文本不再通过局部覆盖 `--bg-canvas` 切换皮肤。文件种类图标采用主题的内容色和前景角色，避免固定 hex 在深浅模式失配。HTML、Office 作者样式、媒体像素、视频黑底与文档纸面仍属于文件自身内容；不通过滤镜或工作区色覆盖重染。

| PreviewKind | 扩展名 | 形态 | 实现 |
|---|---|---|---|
| `text` | 其余全部（ts/py/json/log/无扩展名…） | CM6 只读预览，可切编辑 | 既有链路（2MB 上限、二进制拒绝） |
| `markdown` | md/mdx/markdown | MarkdownBody 渲染（mermaid/相对链接解析；CJK 强调兼容见 [markdown-cjk-emphasis.md](markdown-cjk-emphasis.md)） | 既有链路 |
| `html` | html/htm | sandbox iframe（srcDoc），按来源文件解析相对资源 | HtmlFilePreview（桌面根协议 / Web 只读预览地址） |
| `image` | png/jpg/jpeg/gif/webp/bmp/svg/ico/avif | `<img>` | FileMediaPreview（muster-ws:// / muster-ext://） |
| `audio` | mp3/wav/ogg/oga/m4a/aac/flac/opus/weba | `<audio controls>` | 同上 |
| `video` | mp4/webm/ogv/mov/m4v/mkv | `<video controls>` | 同上（mkv/mov 编码支持随 Chromium，最佳努力） |
| `pdf` | pdf | iframe（Chromium PDF viewer） | 同上 |
| `word` | docx | 版式渲染（白底页、标题/正文样式） | FileDocPreview + **docx-preview**（懒加载） |
| `sheet` | xlsx/xls/csv | 单行可滚动页签 + 支持横滚的表格（首行高亮，5000 行截断提示） | FileDocPreview + **SheetJS(xlsx)**（懒加载）；CSV 显式按 UTF-8 解码（type:'string'，array 通道会按码页猜出乱码） |
| `slides` | pptx | 大纲卡（序号 + 首段为题 + 其余文本段） | FileDocPreview + `shared/pptxOutline`（自研：zip → slideN.xml → `<a:t>`） |
| `archive` | zip/tar/gz/tgz | 条目清单表（名称/大小/修改时间，目录排前） | FileDocPreview + `shared/archiveZip`（EOCD/zip64 中央目录，自研零依赖）+ `shared/archiveTar`（ustar/GNU L/PAX path；gz 走 DecompressionStream） |
| `unsupported` | exe/dll/doc/ppt/7z/rar/psd/ttf…（已知解码不了的格式） | 「暂不支持预览此格式」卡片：类型徽标 + 文件名 + 大小 + 「在资源管理器中显示」 | FileEditor 直出，不读字节试错 |

- 无扩展名/未知扩展名按 `text` 走；真二进制在读取通道被 `looksBinary` 拒绝 → 错误卡片（同款「无法预览此文件」+ 资源管理器按钮）。
- **office/归档族有解析上限**（`DOC_PREVIEW_CAP`）：word/slides 64MB、sheet 32MB、archive 128MB，超限出「文件过大」卡片而不是卡死渲染进程。
- 解压/解析库按需动态 import（`import('docx-preview')` / `import('xlsx')` / `import('fflate')`），不进主 bundle。
- `shared/archiveZip.readZipEntry(buf, entry, inflate)` 的 inflate 由调用方注入（渲染层传 fflate 的 `inflateSync`）——shared 解析器保持零依赖，`test/renderer-safe-shared.mjs` 的 VM 沙箱才加载得动。

工作簿按 SheetJS 的格式化值生成 React 文本节点及合并行列，仅将 HTTP、HTTPS 和 mailto 目标显示为外链。文件内的富文本单元格以文字呈现。键盘 Tab 进入选中页签，方向键或 Home / End 移动焦点，Enter / Space 切换工作表。Tab 到工作表后可横向滚动。首行高亮沿用原工作簿视觉习惯，首行仍按数据行呈现。

Word 预览关闭 `docx-preview` 的 `renderAltChunks`。常规 Word 内容继续按版式渲染，作为备用部件嵌入的 HTML 需在原文档应用查看。

预览关闭、文件身份或界面语言变化时，`FileDocPreview` 取消在途读取。每次 Word 渲染使用挂在预览区内的独立容器。退出该次渲染时立即移除容器，库异步完成的旧版式只能写入已移除的节点。取消信号不能中断已经开始的同步解压和工作簿解析。组件回归见 `test/unit/file-doc-preview.spec.tsx`。

## 文件身份与工作区媒体协议

文件后端使用 `WorkspaceFileRef { workspaceId, rootId, relativePath }`。`fs.listDirRef/readTextRef/writeTextRef/removeRef/statRef` 经过 `workspaceFileAccess.ts` 接入现有 IPC；目录项附带完整 FileRef。显式无效工作区或已移除根不会回退到活动区。旧单根位置参数仍有效，多根下未指定源根的相对路径会拒绝歧义；完整路径按已登记根中更具体的根定位。

`buildWorkspaceFileUrl(ref)` 生成 `muster-ws://workspace/<编码相对路径>?v=2&workspaceId=<ID>&rootId=<ID>`；固定 host 避免工作区 ID 大小写与 Unicode 被 URL authority 改写。主进程统一解析身份并检查 realpath，根内 Junction 不能越界读取；Web `/media/ws/workspace/…` 保留版本与根查询参数，Range/206 仍由同一文件服务处理。旧单根 URL 保留；旧扩展 URL 固定指向管理根，不随默认 cwd 改变。SDK 静态资源仍单独分流。

HTML 由 `HtmlFilePreview` 在正文加载并进入预览后挂载，编辑/离开时卸载脚本与资源；桌面沿用 `sandbox="allow-scripts"`，手机显式禁用脚本，两者均不开放同源权限。默认 `<base>` 指向当前文件所在目录，已有相对/外部 base 保持其语义。桌面使用 `muster-root://r<UTF-8十六进制身份>/<路径>`，将工作区/根 ID 放在 authority 中，CSS、模块脚本等普通相对 URL 不会丢掉身份。主进程复用 FileRef、realpath 与根版本校验，CORS 允许沙箱资源加载。

Web 沙箱无法依赖父页的 SameSite Cookie，故通过 `fs.createPreview(ref)` 获得 `/media/preview/<随机地址>/<路径>`：仅支持 GET/HEAD、限定一个登记源根的只读资源，不包含网关 Token，也不授权 IPC。`workspacePreview.ts` 每次请求检查根版本、realpath 与目录身份；关闭/编辑/切根/根版本变化后释放旧地址，晚到的创建结果也会释放。每应用最多 64 个地址，固定有效期 1 小时，过期后需重新打开预览；已开始传输的响应不承诺即时撤销。媒体与 Office/归档组件的 Web 地址通过 `filePreviewUrl.ts` 转为现有 HTTP 路由，保留 rootId 和编码。

后端会在异步操作前后核对源根版本，删除目录前检查是否包含任何已登记源根或管理根。该保护不等同操作系统沙箱。文件树、编辑器、Markdown 相对内链、历史与批注回跳已贯穿 FileRef；媒体与 Office/归档 URL 携 rootId，按文件身份重建预览，避免旧 Word 渲染写入新文件的宿主。文本外改已由多根 watcher 按根/版本刷新并保护脏编辑，多根查询后端、@ 与 QuickOpen 也已接通。手机文件页已支持选根、Ref 导航和媒体/HTML 来源资源，Office/归档保留电脑端预览提示。普通多根创建/编辑入口已开放，全部格式的多根真 app 验证仍待完成；代码索引跨根跳转已通过独立 Electron 验收。

## 工作区外文件（外部只读预览的媒体/文档通道）

`fs:readExternal` 是文本通道（二进制即拒），媒体/office/归档的外部文件走**协议通道**：

- 新增特权协议 `muster-ext://f/<encodeURIComponent(绝对路径)>`（`shared/filePreview.buildExternalFileUrl`；`f` 是哑 host，避免盘符进 hostname 被改写；UNC 同样整体编码）。主进程 `workspaceFsProtocol.ts` 注册，handler 只接受绝对路径，经 `serveWorkspaceFile`（stat isFile 校验、Range/206 支持）只读服务。安全姿态与 `fs:readExternal` 一致：渲染层发起的绝对路径预览，无任何写路径。
- FileMediaPreview / FileDocPreview 接 `external` prop：src 换成 muster-ext URL；外部文件 stat 走 `shell.statPaths`（无大小信息，跳过 0 字节检查——传 size=null，不能拿 0 当未知值，曾误杀成「文件为空」）。
- 入口仍是既有闸口：聊天链接/终端扫描 → SideToolsPanel 判定（工作区内 `openPath`；找不到且是完整路径 → 磁盘级 stat → `openExternal`），md 预览里的 file:/// 绝对链接同样可达。
- **信任边界（明示）**：外部只读通道对路径**无工作区范围约束**——除桌面渲染层外，web 网关的 `/media/ext/<任意绝对路径>` 路由复用同一 handler，经 token 鉴权后即可**只读访问磁盘上任意绝对路径文件**。即：持有访问 token 的手机/浏览器客户端拥有与桌面渲染层等同的「全盘只读」面（无写路径）。这是与 `fs:readExternal` 一致的有意信任边界，不是泄漏面；如需收窄，候选方案为 `/media/ext` 只服务本会话经 openExternal 打开过的路径白名单（未实施）。

## 自定义协议的硬前提：默认 UA 必须纯 ASCII

图片/音视频/PDF/HTML 预览都依赖 `muster-ws://`、`muster-root://`、`muster-ext://`、`muster-app://`。这些请求能不能进 handler，取决于**请求头能否转成 WebIDL `Headers`**：Electron 用产品名拼默认 UA（去空格）。事故当时产品名是 `Muster Console · 集序`，UA 成了 `MusterConsole·集序/0.1.34 …`；Electron 43.x 在 `protocol.handle` 里把请求头交给 `new Headers()` 时，非 Latin-1 字符（≥U+0100）在 ByteString 转换处直接抛 `TypeError: Cannot convert argument to a ByteString because the character at index N has a value of 65533 (U+FFFD)`。异常在进入 handler **之前**发生，主进程 `[muster-ws]`/`[muster-ext]` 分支一行都不会打，渲染层只有 `net::ERR_UNEXPECTED`，于是四类自定义协议一起失效：图片点开是「无法预览 / 图片加载失败 / 大小：364.3 KB」（stat 通、`<img>` 挂），HTML/PDF/扩展面板同样白屏。

产品身份现已拆成「身份名 `PRODUCT_NAME` = `Muster Console`（纯 ASCII）」+「展示名 `PRODUCT_NAME_ZH` = 集序（只走界面词条）」，见 [product-identity.md](product-identity.md)。同时 `src/main/index.ts` 在 `configureProductUserDataPath()` 之后仍执行 `app.userAgentFallback = asciiUserAgent(app.userAgentFallback)` 作为兜底（`shared/productIdentity.asciiUserAgent`：剥掉非 ASCII、保留 `MusterConsole/0.1.34` 产品段，产品名整段中文时补 `PRODUCT_EXECUTABLE_NAME` 令牌）。禁给 UA 加任何中文/emoji 段——这不是美观问题，是全类型预览的可用性开关。

定位手法（可复用）：`%APPDATA%/muster-console/logs/main.log` 里成串的 ByteString `TypeError` 与渲染层每个自定义协议请求一一对应；用 CDP 把 `Network.setUserAgentOverride` 换成 ASCII UA 后同一 URL 立刻 `IMG_OK`，即可确认是 UA 而非路径/权限。回归守卫 `test/user-agent-ascii.mjs`（改回原始 UA 或删掉 index.ts 的赋值即转红）。上游修复前该清洗不可省，属跨平台一致行为（Windows/macOS/Linux 同一 UA 路径）。

## FileEditor 分流不变量

- 编辑器在 `fileEditorState.ts` 登记实时读取器，报告文件身份、是否处于编辑态及是否有未确认写盘的改动；防抖期间和本文件在途写入期间均为未保存，卸载时注销。状态从 live ref 读取，不依赖 dirty 状态触发 React 重绘；不同工作区隔离，旧文件迟到写入不标脏新文件。此读取器供面板能力接线使用，不代表 `host.panel` 已开放。
- `previewKindForPath(path)` 是唯一分类源；**工作区外文件也分类**（此前外部媒体走文本通道必报二进制）。
- 文本族（text/markdown/html）独享：编辑/预览切换、autosave、Ctrl+F、划词批注、fs:changed 冲突保护。非文本族一律 `autoSavePath=null`；`workspaceFs.writeText` 的写闸口同步从「媒体扩展名」改为「非文本族全拒」（office/归档/未知二进制不可被覆盖）。
- 结构不变量不变：`.file-editor-main` 容器无条件渲染（CM 挂载期一次性创建），非文本态只 display:none 让位。
- Markdown 渲染预览与普通文本的只读 CM 预览给 `.file-editor-main` 加 `is-reading-surface`，去整幅 L0 嵌卡、直接落在与聊天正文相同的 L1 工作面。普通文本 CM 子树局部改 `--bg-canvas` 并将行高放到 1.7，仍保留等宽字体与行号；Markdown 正文上限 760px、行高 1.7。统一右侧工作面中的编辑态、代码预览与 HTML 页面也改为平面内容区，去掉旧圆角与细环；Markdown 阅读宽度与排版继续保留。该类只随既有预览状态切换，不重挂 CM。整体布局见 [右侧统一多标签](right-workspace-tabs.md)。
- Markdown 预览在正文有标题时提供可开关的右侧目录：目录条目按标题级别缩进，点击后跳回对应标题；目录侧栏沿用 `usePresence`/`mp-panel` 的可打断进出场。编辑/预览互斥切换仍独立于保存，保存按钮位于通用文件工具组，不再与模式切换同组。组件回归见 `test/unit/file-editor-markdown-memo.spec.tsx`，深浅主题与 780/390px 截图见 `.tmp/ui-captures/markdown-toc-final2/`。
- 头部状态文案按 kind 显示（图片/音频/视频/PDF/Word 文档/表格/幻灯片/压缩包 · 只读）。

## 聊天文件链接美化（GUI 会话/调度/文件面板 md 预览共用）

- `shared/filePreview.fileIconKindForPath`：比 PreviewKind 更细（分出 code/config/text/font），驱动 `components/FileTypeIcon.tsx` —— 14px 圆角徽标（类型色 13% 透明底 + 同色字形/缩写），色表在 `markdown.css` 的 `.fti-*`（固定类型色，深浅主题通用；避开 design-lint 旧色板）。
- `MarkdownBody` 的 `muster-file:`、相对/绝对路径和 `file://` 文件链接统一走 `FileLink` 组件：从 href 解析基名（带扩展名才配图标，无扩展名可能是目录/路由），`<FileTypeIcon>` + 标签。文件面板 Markdown 预览保留 localhost URL 的本地映射；会话中的 HTTP(S) URL 则进入内置浏览器，详见 [聊天转写](chat-transcript.md)。
- `ToolVisuals.ToolTitleTarget`：工具卡的可点击路径同样前置图标；`path:line[:col]` 分离出行列传给工作台跳转，系统文件打开只传文件路径。
- `.ws-file-link` 为 inline-flex + 图标间隙；链接一律不加下划线（用户验收，蓝色/图标即示意）。
- 文件链接使用原生 `title` 悬浮展示目标原地址（URI 编码转为可读文字，非法编码保留原样）；自动生成的 `muster-file:` 链接展示原路径与行列号。悬浮地址保留 `/E:/...` 原形态，实际会话打开时由路径解析器兼容为 `E:/...`。组件回归见 `test/unit/markdown-file-links.spec.tsx`。

## 关键文件

```
src/shared/filePreview.ts        预览/图标分类、DOC_PREVIEW_CAP、muster-ext URL
src/shared/archiveZip.ts         zip 中央目录解析（zip64；inflate 注入）
src/shared/archiveTar.ts         tar 遍历（GNU L/PAX）+ gunzip（DecompressionStream）
src/shared/pptxOutline.ts        pptx 大纲提取
src/main/workspaceFileAccess.ts  文件 IPC/媒体共用的 FileRef、旧参数、根版本与源根删除保护
src/main/workspaceFsProtocol.ts  muster-ws / muster-root / muster-ext 协议注册与 handler
src/main/workspacePreview.ts     Web HTML 的只读源根地址、失效/释放/版本与位置检查
src/renderer/src/components/HtmlFilePreview.tsx HTML 来源 base 与预览生命周期
src/renderer/src/filePreviewUrl.ts              桌面/Web 媒体地址转换
src/renderer/src/components/FileDocPreview.tsx   word/sheet/slides/archive 预览
src/renderer/src/components/FileMediaPreview.tsx 媒体预览（+external）
src/renderer/src/components/FileEditor.tsx       分类分流 + unsupported/错误卡片；Markdown 目录与编辑/预览/保存工具栏
src/renderer/src/components/FileTypeIcon.tsx     类型徽标图标
src/renderer/src/components/MarkdownBody.tsx     FileLink（图标链接）
src/renderer/src/components/ToolVisuals.tsx      工具卡路径图标
src/shared/mediaKinds.ts                         MIME 表（补 office/归档条目）
src/shared/productIdentity.ts                    asciiUserAgent：默认 UA 纯 ASCII 守卫（自定义协议前置条件）
```

## 实测与测试

- 桌面 HTML 预览的 iframe 在虚拟屏露条态由宿主手势层覆盖，按预览实际所在的屏触发切换。屏幕激活后，iframe 直接接收鼠标操作并保留页面状态。`test/unit/file-editor-roots.spec.tsx` 覆盖两屏手势路由，`test/e2e/html-preview-paint.spec.ts` 覆盖首次点击切屏及下一次点击操作页面。

- 2026-10-14 旧“HTML DOM 已加载但像素空白”反馈在当前实现未复现。新增 `test/e2e/html-preview-paint.spec.ts` 在独立生产 Electron 的真实文件面板中，检查首次打开、切走后返回和窄窗口的 iframe 内容，并从宿主窗口截图核对两块确定 RGB 像素；三张深浅/窄窗口截图已逐张查看，位于 `.tmp/ui-captures/html-preview-paint/`。原 `test/preview-cdp.mjs` 的 HTML 检查也增加确定背景像素断言，不能再仅凭 srcdoc 属性判通过；本轮未执行这个需要活 dev 的全格式脚本。

- 离线：`test/file-preview.mjs`（分类矩阵/图标分类/ext URL/zip-tar-pptx 解析往返/MIME）；`test/md-preview-crisp.mjs`（预览链无 transform/will-change 残留 + contain:none 覆盖气泡 paint 隔离 + 居中 round）；`test/user-agent-ascii.mjs`（默认 UA 清洗成 ASCII，且 index.ts 启动期确实替换 `app.userAgentFallback`——中文产品名进 UA 会让四类自定义协议整体 ERR_UNEXPECTED，见上节）。
- 多根：`test/workspace-file-access.mjs`（文件身份、歧义、删除/版本/Junction 保护）；`test/media-kinds.mjs`（ID/特殊字符与资源相对 URL 往返）；`test/workspace-preview.mjs`（真实文件、只读范围、准备中撤销、过期/版本/关闭、Junction 重新指向、Range 与并发上限）；`test/unit/html-file-preview.spec.tsx`（base 语义、Web 地址、旧版本/晚到创建释放）；`test/unit/file-editor-roots.spec.tsx`（真实 CM、媒体/Word 与 HTML 加载/编辑生命周期）。
- `test/e2e/workspace-preview-matrix.spec.ts` 在独立生产 Electron 中验证 19 类样例 A→B→A 的 57 次打开，涵盖文本/Markdown/HTML、图片/音视频/PDF、Office 和归档，以及不支持/二进制错误；媒体地址与字节对应实际根，视频实际播放，PDF 等到 Chromium viewer 加载成功，所有源文件哈希不变。Word 页宽超过预览区域时从左边起排，保留横向滚动，防止居中造成左侧不可达；用实际页面边界断言回归。深浅 Word/表格/图片/归档及深色 PDF 截图已查看。测试保留软件渲染：关闭它会产生 PDF 空白，DOM 可见和字节正确不足以证明绘制成功。
- `test/e2e/workspace-file-roots.spec.ts` 使用独立 Electron 沙箱/随机本机端口，验证真实 IPC/WebSocket、媒体/Range、树打开/定位、键盘编辑与磁盘隔离；HTML 第二根的图片、CSS @import、模块脚本与 JSON 均在桌面/Web 加载，浏览器实际图片与 UTF-8 CSV 组件通过。匿名预览 GET/HEAD 可读、POST 拒绝、非法编码返回 400、关闭返回 403，匿名应用入口返回 401；预览地址不包含完整 Token。未覆盖全部二进制格式。HTML 的深浅/常规与 560px 四图已查看；加载前隐藏层挂载导致首次空白已修复，截图前断言实际可见。
- 同一 E2E 还通过真实手机表面的源选择、两根同名文本、图片与 HTML 相对样式，断言手机 HTML 禁脚本和关闭后地址失效；对应 15 项手机组件回归覆盖身份/取消/内链/刷新。源选择与图片详情的深浅主题 390/320px 八图已查看，位置见 [手机端表面](mobile-surface.md)。
- **应用内实测**：`test/preview-cdp.mjs`（EXCLUDE，需 dev + `MUSTER_DEVTOOLS_PORT=9333`）。生成真实字节样例（自研 PNG 编码器/WAV PCM/SheetJS xlsx/fflate docx-pptx-zip/手工 tar/gz/MediaRecorder webm），`workspaces.open` 开进 dev 沙箱，ctrl+shift+\ 开虚拟屏，DOM 点文件树逐格式打开 + 断言 + CDP 截图。25/25 通过，截图存 `.dev-sandbox/preview-shots/`。已知坑：
  - MediaRecorder 产视频：canvas **必须挂载渲染** + `captureStream(0)` 手动 `requestFrame()`，否则只有 110 字节 EBML 头；
  - CSV 用 SheetJS `type:'array'` 会按 1252 码页解出乱码，必须 TextDecoder → `type:'string'`；
  - Files 面板在 Git 虚拟屏页里，DOM 断言不依赖可见性，**截图前必须开虚拟屏**。

## Markdown 预览文字锐度

文件面板 md 预览与会话气泡共用 `MarkdownBody` / `.md-body`。气泡用 `contain: layout paint` 做已完成消息的绘制隔离；整篇预览若沿用，会叠在虚拟屏 `.h-strip` 的 `translate3d` / `will-change: transform` 上，整篇晋升 GPU 合成层，Windows 125%/150% 下文字发虚。

预览链因此显式卸层（`markdown.css` `.md-body.file-editor-md-body` 等：`contain: none; transform: none; will-change: auto`），居中用 `round()` 取整 CSS 像素（避免奇数宽父级 + `margin: auto` 把整篇推到 0.5px）。守卫：`test/md-preview-crisp.mjs`。

## 已知边界

- 旧版二进制 Office（.doc/.ppt）与 7z/rar 等专有压缩明确归 `unsupported`（.xls 可解析所以归 sheet）。
- tiff/heic/psd 等非 Chromium 原生编码的图片：归 image 但解码会失败 → 错误卡片（不静默）。
- mkv/mov 依赖容器内编码是否被 Chromium 支持，属最佳努力。
- 压缩包预览是清单形态，不解压单条目内容；加密 zip 会报「中央目录损坏」类错误。
- sheet 预览单表 5000 行截断（提示），archive/office 解析有内存上限。
- 文本族仍守 2MB 编辑上限（预览-only 大文件通道未做）。
- HTML 预览不启动项目服务器或构建工具；Web 的 `/assets/...` 等从 HTTP origin 根开始的地址不重写为源根路径，需使用文件相对地址/合适的 base。区外 HTML 没有登记源根资源地址；Web 预览地址超过 1 小时需重新打开。

右侧资源栏展开时，分栏拖拽区宽度与文件页底部留白共用 --right-resource-divider-width（4px），使纵向/横向滚动条到可见边界的留白一致；资源栏收起时不加底部留白。留白仅作用于 .right-content-page.files-panel（height:auto + bottom），不修改共用 .right-workspace-content，浏览器/Git 页保持铺满，避免原生浏览器底部露出宿主黑边。

## 操作等待反馈

文档解析、图片 load、音视频 loadedmetadata、PDF load 使用单色品牌加载；解析、媒体或 stat 错误结束动效并显示错误。Diff 内容区使用单一品牌标记替代多行闪动骨架。 组件与场景清单见 [品牌加载动效](brand-loading.md)。

会话附件卡片的文件名也走 handleChatFileLink → 文件面板入口；工作区外的受管附件由已有只读预览处理。视频可在会话内经同一媒体 URL 协议播放，也可点击名称进入文件面板。

## 设计初衷（2026-10-26 与用户定稿）

> 依据 campaign-intent-drafts/D08-D00.md 草案定稿（用户 2026-10-26「不抽查直接定稿」）；歧义点处置：22 项卡片决策＋长尾按草案推荐，明细见专项账本「意图定稿决策」节。

- 为谁/什么场景：FilesPanel 内按扩展名分流的五形态预览（CM 只读/Markdown/HTML sandbox/媒体/PDF/Office/归档/unsupported 卡片），聊天文件链接配类型图标；工作区外文件经 muster-ext 协议同构只读预览。
- 为什么这样设计：分类唯一真源 `shared/filePreview.ts`（纯扩展名、零 Node 依赖，外部文件也分类——修过外部媒体误走文本通道报二进制）；解析库（docx-preview/xlsx/fflate）动态 import 不进主 bundle；DOC_PREVIEW_CAP（word 64MB/sheet 32MB/archive 128MB）出「文件过大」卡片而不是卡死渲染进程；媒体三协议固定 host（防工作区 ID 大小写/Unicode 进 URL authority 被改写）+ realpath/Junction 校验；Web 沙箱用匿名只读预览地址（无 Token、GET/HEAD、1h TTL、64 上限）；md 预览显式卸 GPU 合成层（`contain:none` + round 取整）修 Windows 125%/150% 下文字发虚；unsupported 格式不读字节试错、直出卡片+资源管理器按钮。
- 明确不做：.doc/.ppt/7z/rar/psd/ttf 等专有格式归 unsupported；压缩包只列清单、不解压单条目内容；HTML 预览不启动项目服务器或构建工具、Web 的 /assets 类根相对地址不重写；tiff/heic/psd 等解码失败出错误卡片不静默；文本族守 2MB 上限（预览-only 大文件通道未做）。
- 歧义点：格式矩阵缺口（旧版 Office .doc/.ppt、7z/rar、压缩包条目解压、2MB+ 大文本只读通道）——A=按需驱动（真实需求出现再补；review 不把矩阵缺口当 finding，只看 unsupported 卡片是否给出路）／B=路线图（review 关注扩展点并把缺口记待补）。推荐 A——unsupported 卡片已给「资源管理器显示」逃生门，缺失不阻塞使用；自研 zip/tar/pptx 解析已是按需补的先例。
