# 扩展模型与媒体能力

扩展面板通过当前宿主 SDK 使用 `llm.chat`、`llm.chatStream`、`models.list`、`models.invoke`、`files.pick`、`media.import`、`media.retain`、`exports.create` 和 `exports.reveal`。DomainRuntime worker 通过同一个宿主 broker 调用 `models.list`/`models.invoke` 和 `llm.chatStream`，密钥只在主进程的模型网关中读取，面板和 worker 只拿到模型描述、asset 引用或导出 ID。

`ExtensionModelGateway` 从现有 `llm.providers` 配置解析 provider 和 model。文本走 OpenAI 兼容 chat completions；图片、TTS 和 ASR 走标准 OpenAI 风格端点；视频使用 provider 的 `media.video.submitPath`、`pollPath`、可选 `statusPath` 和 `resultPath` 做提交与轮询。模型能力由 provider/model 的 `modalities` 和 endpoint 配置合并推导，没有声明的能力会被宿主拒绝。模型描述中的 `isDefault` 标记宿主当前选择，扩展的「跟随默认」据此选模型。

声明 models 权限的 DomainRuntime 可使用 worker broker 的 `models.sealImageKey` 封存扩展自己的图片服务密钥，再用 `models.customImage` 调用兼容 /images/generations 的连接。密文绑定扩展实例与生成端点，扩展负责存储密文，宿主使用 Electron safeStorage 加解密。Windows 和 macOS 使用系统安全存储，Linux 需要可用的系统密钥环。试画可直接使用未保存的凭据。此连接不写入宿主模型目录。模型的 multimodal 图片输入标志不授予图片生成能力。

图片、音频和视频结果经 `ExtensionMediaStore` 原子落盘，返回 owner 绑定的 asset ID 与本机 HTTP URL。媒体服务提供 MIME、HEAD、Range 206 和跨实例隔离；面板资源的 CSP 明确允许本机媒体 URL。`media.retain(assetId)` 原子保存 owner 绑定的资产元数据，使其可以跨面板关闭和应用重启恢复。关闭实例撤销旧 URL、删除未 retain 的临时资产并中断请求；显式 `media.release(assetId)` 删除文件及元数据。`media.url` 只在当前 owner 的目录内恢复资产。

本地文件先由宿主文件选择器授权，再由 `media.import` 复制到扩展数据区；扩展不能把任意绝对路径传给媒体导入。`exports.create` 只接受文本或已授权 asset ID，在用户 Documents 下创建带临时目录和原子 rename 的成稿目录；`exports.reveal` 只接受当前实例创建的导出 ID，并调用跨平台 reveal 适配层。

关键入口：

- `src/main/extensions/extensionModelGateway.ts`
- `src/main/extensions/extensionMediaStore.ts`
- `src/main/extensions/mediaServer.ts`
- `src/main/extensions/extensionExportService.ts`
- `src/main/extensions/extensionHost.ts`
- `src/main/extensions/sdk/extension-sdk.js`

worker broker 的第四个参数接收增量回调：`broker('llm.chatStream', [messages, options], context, onDelta)`。宿主验证 `models` 权限与可用 provider/model，在主进程读取凭据，透传增量并响应 worker 的取消。此文字接口目前只支持 OpenAI chat-completions，其他协议明确拒绝。

[dsh-media-desk](dsh-media-desk.md) 使用原版界面和领域逻辑，接入文字流式、生图、文件选择/媒体保留及导出/reveal。网关的视频/TTS/ASR 仍可被其他扩展调用。定向回归包括 `extensions-model-gateway.mjs`、`extensions-media-store.mjs`、`extensions-export.mjs`、`extensions-domain-isolation.mjs` 和 `test/unit/node-main/extension-llm-stream.spec.ts`。真实厂商接口、macOS/Linux Electron 媒体播放和跨平台文件管理器仍需对应平台实机验收。

面板调用 `ma.exports.preview(exportId, fileName)` 时，主进程校验 exports 权限、导出所有者与导出文件清单，在当前工作区右侧打开隔离的浏览器标签。每份 HTML 导出拥有独立来源，可使用本地存储、鼠标和键盘，资源请求仅可读取同一份导出登记过的本地文件。

`ma.exports.thumbnailHtml(html)`（exports 权限）和 `ma.tasks.thumbnail(sessionId, relativePath)`（project.tasks 权限）返回 `{dataUrl}` PNG 首屏缩略图。任务版本复用 tasks.preview 的项目、任务归属和 realpath 校验，仅接受 HTML；旧版 HTML 正文无需创建导出目录。`extensionHtmlThumbnail.ts` 使用无 preload、sandbox、无 Node 的隐藏 Electron 窗口，以 1200×750 页面生成 480×300 图片，禁止权限、弹窗、下载和联网，任务资源只允许读取 HTML 所在目录内的真实文件。依赖 CDN 的样式/字体/脚本在离线缩略图中不可用；右侧交互预览保持原行为。HTML 上限 8 MiB，单资源 16 MiB，截图最多 8 秒，队列最多 32 项、同源相同 HTML 复用在途请求，宿主内存缓存最多 64 项、30 秒失效且按 owner 隔离；正文改变后重新生成。跨平台使用同一 Electron 接口，macOS/Linux 真机效果仍需验证。
