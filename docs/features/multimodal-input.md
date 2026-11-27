# 多模态输入与会话附件

## 职责与处理顺序

调度 Agent、GUI Worker 和 CLI 悬浮输入区的 Composer 接受文件选择、粘贴和拖入。沿用 `images` 字段保持草稿/队列兼容，但入口中的 `ChatImageAttachment` 可以是任意文件；主进程受理前统一转换，传给图片 driver 的数组仍只有真正图片。CLI 走纯文本适配：图片和不可提取的附件只给受管路径及来源元信息，文档可附有界提取文字，不声称图片已被 CLI 模型读取。

桌面新建任务接受纯附件或正文加附件。主进程 `tasks:delegate` 在入队前固定文件内容，队列保存这次提交的字节快照。GUI 首条用户消息和后续会话输入使用同一个 `prepareGuiInput`，CLI 使用目标会话的受管附件路径和可提取文字组装启动输入。看板代办保存自己的附件版本，重开时可预览、移除、继续派活。定时任务编辑使用其定义支持的文本与配置。

附件数量、大小、会话清理和混合媒体限制等主进程错误按当前界面语言返回；附件名和上游诊断内容保留原文。

1. 模型能力与当前协议均支持时，按协议发送原生图片、音频、视频或文档。Core 图片能力依次使用显式覆盖、线上端点规格、同端点 SDK 数据与图片保底。目录公开全部已知输入模态，原生传输还须符合现有适配器的 MIME 与载荷规则。 [端点目录](model-providers.md#core-官方端点思考档位目录)
2. PDF/PPT/PPTX/ODP 在视觉模型上优先转换页面图，保留版式；纯文本模型或渲染失败时提取文字。其他文档提取文字；DOCX/ODT、XLSX/XLS/ODS 和常见文本/代码格式已接入。
3. 视频无法原生发送且模型能看图时，通过 FFmpeg 定间隔抽帧。自动与按需转换共用 videoFrameFilter：显式转换为 full-range yuvj420p 后编码 JPEG，避免 limited-range 输入被 MJPEG 拒绝；fps eof_action=pass 保留短片/尾部不足一个采样间隔的帧。时间标注是采样区间的名义中心，尾帧可能早于该时间。
4. 不可转换或转换失败：保留文件路径，明确标记模型尚未读取内容及失败原因。

元信息默认仅保留 `name/sourcePath/processing`；`originalPath` 仅在确有原始路径时附加。原生图片不带续读工具、MIME、字节数或空字段。转换结果另保留实际页码、截断/采样/音轨缺失等必要边界；只有部分结果或可续读的失败项附 `more: attachments.convert`，不重复源路径、模态列表和通用 instruction。工具用法由工具目录提供。提取内容以 JSON 字符串作为不可信文件数据携带，不当作宿主指令。GUI 附件注入已登记 `both.turn-prefix.attachments`，CLI 输入区附件和技能的文本适配登记为 `worker.turn-prefix.cli-composer-input`。

## 文件与入口

聊天展示由 `src/shared/attachmentDisplay.ts` 与 `ChatMessageView` 投影：仅识别完整的受管附件元信息后缀，显示用户正文和源文件卡片；图片数组完整保留并正常显示缩略图，不依赖图片 ID 与磁盘文件名匹配（GUI 会重建图片 ID）；提取文字、源路径和续读说明不直接显示。调度 content 与 GUI parts 共用此展示逻辑，兼容旧长路径和 continuation 字段。存储正文和模型请求保持完整，不因展示过滤而丢失附件上下文。

| 文件 | 职责 |
|---|---|
| `components/agentComposer/useComposerImages.ts` | 任意 File 读取、读取中禁发送、失败提示、会话代际隔离、系统文件剪贴板兜底 |
| `ComposerEditable.tsx` / `ComposerAttachBar.tsx` / `useComposerInsertions.ts` | 粘贴、选择、拖入文件；普通文本仍按纯文本净化 |
| `ComposerImageStrip.tsx` | 图片缩略图/灯箱与普通文件卡片，支持移除 |
| `src/shared/attachmentPolicy.ts` | 配置归一、协议与 MIME 能力判定 |
| `src/main/attachments/service.ts` | 源文件保存、四级路由、元信息、限额、抽帧、清理与分叉复制 |
| `src/main/attachments/guiInput.ts` | GUI 新任务和会话发送入口共用的附件预处理。派活入口静态导入此模块和附件服务，按 GUI/CLI 分支处理提交的附件 |
| `src/main/attachments/worker.ts` | 有界后台线程文字提取；构建输出 `out/main/attachments/worker.mjs` |
| `src/main/attachments/document.ts` | PDF.js 页面渲染与按页文字；PPT/PPTX/ODP 经 LibreOffice 导出 PDF；PPTX 文字可直接读取 |
| `src/main/attachments/convert.ts` / `capabilities/{catalog,hosts}/attachments.ts` | `attachments.convert` 按页/字符区间/视频时间续读，只访问调用方会话受管源文件 |
| `src/main/attachments/clipboard.ts` / `macClipboardPlist.ts` | Windows CF_HDROP/FileNameW、macOS 文件列表/属性列表和 Linux X11/Wayland 文件 URI 路径解析；macOS 二进制列表用系统 plutil 转换 |
| `src/main/attachments/piExtension.ts` | Pi `agent.onPayload` 包装：把本会话 manifest 标记还原为原生请求内容块 |
| `src/main/ipc/fs.ts` / `agentSession.ts` / `sessions.ts` / `pty/composerSubmit.ts` | 调度/GUI/CLI 受理前预处理，捕获错误、保留草稿；GUI 复查模型配置，CLI 按 PTY 代次写入 |
| `settings/AttachmentPolicyFields.tsx` / `ModelProviderPane.tsx` | 仅模型原生输入能力编辑 |

## 数据流

```
Composer File / 系统文件剪贴板
  → 通用附件待发条 / 手动队列
  → chat:send 或 agentSession:send
  → prepareAttachments（源文件落盘 + 本地处理）
  → text（元信息/提取内容/原生 manifest 标记）+ images（图片/视频帧）
  → 原有调度/GUI 排队与 driver
  → Pi agent.onPayload 在实际请求里重建原生媒体块
```

非 Pi 引擎继续使用自身 SDK 的图片能力；不具备宿主原生音视频协议时走本地处理/路径。声明的模型能力与已实现协议适配共同决定是否原生发送，不能仅靠勾选开关让 SDK 支持新模态。

CLI 在 `pty:submitComposer` 中复用 `prepareAttachments` 的纯文本分支，元信息与提取文本和用户正文一起提交，长文本或不支持多行粘贴的 runtime 继续使用临时输入文件。仅附件也可提交；源文件读取或快照失败时不写 PTY，保留附件和正文，文字提取失败则注明原因并回退受管路径。CLI 的 `attachments.convert` 按当前 `cli:<sessionId>` 隔离受管源文件；只有已接入该工具的 CLI 才能调用，其他 CLI 可使用自己的文件工具读取路径。远程网页上传通过文件字节提交，不能指定宿主的本地源路径。

Pi SDK 的扩展事件会捕获回调异常后继续发送，因此附件适配直接链式包装公开 `agent.onPayload`，保留原有扩展回调，同时让丢失源文件、无法适配等错误终止请求。历史只存 manifest 标记，重试/续聊重新从本会话目录读取；不依赖进程内缓存。

## 原生协议适配

| 协议 | 实现 |
|---|---|
| 图片 | 沿用现有模型图片声明、driver 图片发送链路 |
| OpenAI Chat Completions | `input_audio`（wav/mp3）、`file`；显式启用的视频走服务商扩展 `video_url` Data URL |
| OpenAI / Azure Responses | `input_file`，内联文件数据 |
| Anthropic Messages | PDF `document` + base64 source |
| Google Generate Content | 支持类型的 `inlineData` 音频/视频/PDF/文本 |

公网 URL 专用的服务商格式、各厂商 Files API 上传/轮询尚未接入；Completions 视频传输 `videoTransport` 默认 `url-only`，本地视频回落抽帧。只有明确选择 `data-url` 且启用原生视频才发送内联视频。输入开关不是远端能力探测，也不代表已对该服务商实测成功。

## 配置

模型 `LlmModelConfig.attachments` 仅保存 `nativeAudio/nativeVideo/nativeFiles`（默认关闭）、`allowMixedMedia`（默认允许）、`mimeTypes`（原生 MIME 白名单）和 `videoTransport`。旧 `multimodal` 仍控制图片，显式 false 会保留。

全局 `AppConfig.attachmentProcessing` 保存 `maxFileMB`（硬接收上限，默认32，1–256）、`maxTextChars`（每消息默认40000，1000–200000）、`videoFrames`（默认8，1–32）、`videoIntervalSeconds`（默认10秒，1–600）及下述自动预览预算。全局 `AppConfig.attachmentTools` 保存 `ffmpegPath/libreOfficePath`；留空使用系统 PATH。

自动预览另设 `autoConvertMB`（默认10 MiB，大文件缩减阈值）、`autoPages`（每消息默认4页，最多16页）、`autoImageMB`（每消息页面图默认2 MiB，最多16 MiB）。超过文件阈值只预览一页或2000字符；未超过也受页数、图片字节及文字总预算约束。原生发送仍优先，不受本地转换预算影响。页面图片最长边1400px，JPEG；不等同原始高分辨率文件。`libreOfficePath` 可指定 PPT 转 PDF 可执行文件，留空使用 PATH 中的 soffice；独立配置目录、隐藏窗口、20秒子进程超时。Office 导出会解析整个文档，页数限制约束渲染/返回范围，不能保证解析成本按页数缩减。

元信息包含 `totalPages/pages/nextPage/partial`、大文件缩减标记和 `attachments.convert` 续读提示。工具通过 Catalog 同时开放给调度与 Worker（actor 身份绑定）；按 `sourcePath` 选择本会话源文件，`mode=images/text/video`，以 `startPage/count`、`offset/maxChars` 或 `startSeconds/intervalSeconds` 选择范围。每次最多16页/帧、6000字符、8 MiB 页面图；文本页内截断返回 `nextPage+nextOffset`。PPTX 按 presentation 关系中的实际幻灯片顺序提取。图片返回受管路径，模型还须用图片读取工具打开；不会仅凭路径宣称已看过图。转换结果也随会话清理，非本会话源路径一律拒绝。

配置经 ConfigManager 归一落盘，统一在「模型与输入」设置页编辑；原生能力在模型高级选项中，全局策略和工具路径在独立区域。`llm.listProviders/upsertProvider` 仅管理模型原生能力。后台转换最多并发2，单次30秒/256MiB堆上限；FFmpeg 45秒超时、隐藏窗口、禁交互。单次最多32个源附件、总源字节256MiB；视频帧共用最多32帧预算。

## 存储与生命周期

所有发送附件均保存原始字节快照到 `userData/conversation-attachments/<scope hash 前20位>/`，文件名为 `<12位随机标识>-<原文件名>`，独占写入避免覆盖同名文件；包括系统临时文件和没有本地路径的浏览器/剪贴板 Blob。已有64位哈希会话目录和附件标识继续兼容，不移动历史文件、不破坏历史引用。原文件不移动、不删除，避免源文件在发送后变化。模型收到受管源路径，有原路径时也保留溯源信息。

GUI scope 为 `gui:<sessionId>`：归档保留；清空/删除随 `GuiSessionStore.delete` 清理；fork 复制到新 scope 并改写来源路径，父会话清理不影响分叉。CLI scope 为 `cli:<sessionId>`，归档保留，永久删除会话时清理，清理失败通知并给出路径。调度 scope 为 `scheduler:<workspaceId>`：清空当前对话、关闭工作区时清理。处理中的清空通过代际复查拒绝迟到结果。元信息中的原路径仅用于溯源；后续读取应使用受管源路径。

系统文件剪贴板仅允许本机 Electron sender 读取；网页远程端使用浏览器文件输入，不读取宿主剪贴板。明确的文件类型/文件 URI 或空粘贴进入原生文件兜底，普通文本不会被当路径读取。Windows 解析 CF_HDROP/FileNameW；Linux X11 与 Wayland 使用 Electron 提供的标准 URI 或 GNOME 文件格式；macOS 支持完整文件列表，二进制属性列表由系统 `/usr/bin/plutil` 转换，失败提示改用拖放/选择。如果 macOS 只暴露单条 `public.file-url` 且没有完整列表，提示改用拖放/选择，避免多选静默丢项。一次或累计超过 32 个附件明确拒绝。

## 已知边界

- PDF 页面图可保留扫描件、图表和版式，但不执行 OCR；文字模式不包含图片/版式。PPT 页面图依赖 LibreOffice，未安装或失败时明确标记并回退文字（PPTX 可直接按页提取）；旧 PPT 缺排版引擎则只保留路径。Office 文本模式不提取图片/嵌入对象，表格使用缓存值不重算公式，最多每表10000行。
- 视频抽帧是有损采样，最多前 `帧数 × 间隔` 秒，不含音轨；提示含近似时间点。FFmpeg 未安装/解码失败时回落源路径并记录原因。
- 音频不能原生发送时目前回落路径，没有内置本地语音识别模型。旧 DOC 等无转换器的格式同样回落。
- 路径引用需要 Agent 的本机文件工具才能继续读取；远端模型仅收到路径文本不会自动获得文件。
- CLI 本身的沙箱和文件工具决定是否允许读取会话附件目录；本功能不扩大 CLI 的可写范围，路径被拒绝时需调整该 CLI 的读取权限或使用其可访问的位置。待发附件在同一渲染进程内保活，重启应用后需重新添加。
- Pi 原生输入模型仍为 text/image，SDK 内部上下文估算不包含钩子新增媒体的完整成本；计费以服务商实际 usage 为准。
- 当前调度附件按工作区当前对话管理，不为不可重开的历史调度档案单独保留副本。

## 验证

`test/attachments.mjs`：原生路由、真实 PDF/Office 提取、源快照、截断、跨会话隔离、fork/清理、请求失败传播、原生剪贴板解析；设置 `ATTACHMENT_FFMPEG_TEST=1` 增加真实 limited-range H.264 视频生成、自动/按需 JPEG 抽帧及 3.3 秒短片默认间隔回归。

`test/attachments-document.mjs`：真实多页 PDF 渲染、预览页数/大文件限制、单页和页内文字续读、PPTX 图片失败后文字降级与幻灯片排序、路径隔离及输出清理。实际 LibreOffice/PPT 图片渲染尚需安装引擎后现场验收。

`test/unit/composer-attachments.spec.tsx` 与 `composer-image-strip.spec.tsx`：非图片粘贴/读取/移除、迟到结果隔离、队列来源保留、独立配置项；`test/llm-thinking-config.mjs` 验证配置往返。

`test/e2e/attachments.spec.ts`：隔离 Electron 与本地模拟服务商，验证文件选择→IPC→后台转换→Pi 实际请求及清空。模拟服务商只证明载荷和接线，不证明付费远端服务商接受能力。组件深浅/窄宽截图见 `.tmp/ui-captures/attachments`；Windows Explorer 原生剪贴板、实际服务商及安装包仍需现场验收。

## 本机转换工具配置

模型与输入设置中的 AttachmentToolsSettings 编辑 AppConfig.attachmentTools，FFmpeg/LibreOffice 路径不属于模型配置。ConfigManager 加载旧配置时优先迁移当前模型路径，再按服务商/模型顺序补齐；全局对象存在时不再读取旧路径，清空即使用系统 PATH。自动转换的两个 IPC 入口通过 tools 传入全局配置，attachments.convert 也直接读取全局配置，因此非 Pi 会话和切换模型后的行为一致。

## 全局预处理策略与 AI 配置

AttachmentProcessingSettings 在模型与输入设置编辑 AppConfig.attachmentProcessing：单文件上限、提取文字预算、大文件阈值、自动预览页数和图片字节预算、视频抽帧数与间隔。自动转换由调度/GUI IPC 传入同一策略，不随模型切换。按需转换继续采用工具调用指定范围及既有硬限制，不受自动预览预算截断。

加载旧配置时在模型字段归一前提取旧预算和路径，当前模型优先，再按配置顺序补齐；显式全局对象优先。模型归一后仅保留原生能力。ConfigManager 的保存白名单包含 attachmentProcessing/attachmentTools，保存重启不会丢失。AI 配置模型的 llm.upsertProvider/listProviders 同步使用能力边界，禁止预算和路径写入模型；部分能力更新保留其它能力，支持 false 关闭和空 MIME 数组恢复协议默认。全局策略通过模型与输入设置管理，本轮未新增 AI 修改全局策略的工具。

## 会话附件的读取权限

GuiSessionStore.withAttachmentReadAccess 在回合与连接捕获目录快照时，将当前 gui 会话的受管附件目录加入 readableDirectories；创建空目录以支持连接建立后再添加附件，兼容旧长哈希目录。主进程验证目录未重定向，工具策略继续检查 realpath，附件子目录的链接逃逸和其他会话目录不会获得权限。writableDirectories 和 SDK additionalDirectories 保持不变。

Pi 原生工具和 Claude canUseTool 回调已由真实文件系统回归覆盖；Cursor、ACP 和通用宿主工具共用目录快照与权限层。Codex SDK 无原生工具宿主审批回调，原生读取由自身沙箱控制；此次未做这些引擎的真实端到端读取验收，不保证外部沙箱一定允许。直接发送的图片内容块不依赖文件路径读取，影响的是按路径续读源文件/转换页图。

## 会话附件预览与导航

ChatAttachmentCard 将视频源文件通过现有 muster-ext 只读协议（Web 网关转 /media/ext）交给原生 video 控件，支持内联播放、进度和全屏，默认仅预取 metadata，不自动播放。播放失败显示提示并保留文件名入口。其他附件和视频文件名通过 onFileLink + buildWorkspaceFileHref 接入已有右侧文件面板，按类型预览；无导航宿主时仅展示名称。图片原有缩略图/灯箱保持不变。原生媒体解码支持取决于 Chromium，未另行转码。

## 设计初衷（2026-10-26 与用户定稿）

> 依据 campaign-intent-drafts/D06.md 草案定稿（用户 2026-10-26「不抽查直接定稿」）；歧义点处置：22 项卡片决策＋长尾按草案推荐，明细见专项账本「意图定稿决策」节。

- 为谁/什么场景：Composer 收任意文件（选择/粘贴/拖入/系统文件剪贴板兜底），主进程受理前统一四级路由：协议原生 → PDF/PPT 视觉模型转页图 → 提取文字 → 保留路径标未读；attachments.convert 按页/字符区间/视频时间续读。
- 为什么这样设计：转换收口在受理前（传图片 driver 的数组只有真图片），协议适配层不是能力探测层（声明开关≠实测）；Pi 经 agent.onPayload 在真实请求重建原生媒体块（历史只存 manifest 标记，重试从会话目录重读，不依赖进程内缓存）；源字节快照落 userData 受管目录（原文件不动）；提取内容按不可信数据携带不当作宿主指令；读取权限只开本会话受管目录（readableDirectories+realpath 逃逸检查）。
- 明确不做：不做 OCR；音频不能原生发送回落路径（无内置语音识别）；公网 URL 服务商格式/Files API 上传未接入；远端模型仅收路径文本不会自动获得文件（需 Agent 本机文件工具）；预算限额不等于完整覆盖保证（超限按文件级警告+禁止自动回退）。
- 歧义点：音频无本地识别回落路径——A=长期边界（STT 引入模型依赖/成本/语言面，等真实需求；review 不把无转写当缺失）／B=排期内置语音识别。推荐 A。
