---
doc_type: feature
---

# 媒体创作台扩展

源码与扩展级回归位于 [muster-extension-dsh-media-desk](https://github.com/zhanghexie/muster-extension-dsh-media-desk)。扩展目录为 `dsh-media-desk/`。

## 职责与来源

`dsh-media-desk` 把上游 dsh-media-desk 的界面和领域逻辑接入当前 ExtensionHost，不引入另一个扩展运行时。上游基线 `fc237f3388d048f51c3145cfd411dbb80ba2b388`，MIT 许可随包保留。布局、卡片、示例图片和视频直接复用原版；颜色/字体映射宿主主题，进出场使用共享 `usePresence` 与 motion token。

## 关键文件与数据流

- `client/index.jsx` 装配灵感、内容、排期、复盘、风格、Studio、助手及弹窗。`client/host.js` 将原版请求映射为 SDK 调用，恢复 asset URL，处理本地文件和成稿导出。
- `client/mount.jsx` 绑定 SDK 初始化与主题；`client/motion.js` 引用仓库的 motion hooks。
- 独立仓库的 `npm run build` 将 React 和界面代码打成包内 ESM，使用一并维护的 SDK motion 定义快照。
- `domain.mjs` 实现通用 `desk.read` / `desk.write`，不是主进程的业务特例。`lib/ops.js`、`produce.js`、`conversation.js`、`learn.js` 处理原版操作、成稿、聊天与复盘。
- `lib/store.js` 通过 broker `data.read/write` 保存工作区状态，先写入成功再发布内存状态和 `desk.changed`，支持三方撤销。

面板 → SDK `agent.domain.query/command` → ExtensionHost → 同实例隔离 worker。媒体创作台使用内置助手，清单省略 agent。领域 worker 发出 `desk.changed` 后，面板重新读取状态。文字调用通过 worker broker `llm.chatStream` 推送增量；取消从 worker AbortSignal 回到主进程。图片生成通过自定义 API 或已声明图片输出的宿主模型返回 asset，随后 `media.retain` 保持跨重启可读。生产进度沿用原版有界轮询，离开 Studio 停止轮询。

数据位于宿主工作区数据区的 `media-desk/state.json` 和 `settings.json`。资产 ID 保存到领域状态，临时 HTTP URL 不作为永久身份；面板重开时调用 `media.url` 恢复有效 URL。已保留资产在关闭面板时撤销旧 URL，但保留文件；显式 release 删除文件及元数据。

## 交互与边界

原版五页导航、灵感墙、卡片工作室、撤销、设置、内部助手以及本地草稿流程可用。图片/视频通过系统选择器导入；文件拖放尚未接通。文字模型通过宿主选择。生图可在扩展设置中独立配置。无模型时显示结构草稿降级说明。

「内容」表格的标题单元格提供原生按钮，Tab 可定位，Enter 或空格打开卡片工作室。指针也可以点击该行的其他单元格打开详情。表头保留列语义和排序，窄面板在表格容器内滚动；键盘聚焦标题时，容器滚动以显示标题和焦点轮廓。

灵感墙的一次手势由起始指针驱动。正常释放后保存卡片位置，或继续画布的惯性平移。指针取消或离开散落视图时立即移除手势监听，卡片回到拖动前的位置，取消的平移停在当前位置。

Monid 自动账号导入与账号刷新尚未移植；面板显示明确说明，保留手动素材和指标操作。网关本身仍提供视频/TTS/ASR，但该原版界面未增加独立入口。真实厂商模型调用尚未在本次视觉改造中验收。

成稿页的「排期」打开可编辑的发布时间表单。时间按本地时区显示，保存后同步到排期日历，留空保存可取消排期。按钮复用扩展内表单弹窗，避免沙箱 iframe 中调用 `showPicker()` 被浏览器拒绝后看不到任何输入控件。

### 自定义生图 API

设置提供 OpenAI、xAI、火山方舟、智谱、硅基流动和「其他自定义」快捷入口。点选填入接口地址，火山方舟和硅基流动的模型名由用户填写。地址和模型均可编辑，切换服务商会清空尚未保存的密钥。

在设置中填写兼容 OpenAI Images 的 API 基址（含版本前缀）或完整生成端点、模型名、API Key 和尺寸。本地免鉴权服务可留空密钥。没有可用宿主生图模型时，界面直接显示自定义连接。已有宿主配置仍可使用，自动选择优先使用声明图片输出的默认模型。

试画使用当前表单并返回临时预览。保存才会写入当前工作区的扩展配置；已保存密钥不回显，原地址下留空沿用，变更地址需重新输入密钥。全清空地址、模型和密钥后保存可移除连接。成稿封面、配图和分镜使用同一份保存配置，生产资产经 retain 保留。DSH 订阅工具没有迁入。

工作台导航、选中态和控件圆角映射宿主 SDK。内容表格与灵感素材保留原有布局和素材配色，主动作和对话框分别使用配对的主按钮与 overlay 角色。

## 验证入口

- 独立仓库的 `test/domain.mjs`：领域操作、无模型成稿、关闭重开后数据。
- 独立仓库的 `test/panel.spec.tsx`：五页切换、表格键鼠操作与焦点显露、灵感墙指针取消和切页清理、录入/撤销、设置 Escape、Studio、Agent 写入刷新。
- `test/e2e/extensions-media-desk-panel.spec.ts`：当前构建的 Windows Electron、SDK/worker 真链路和页面截图。
- `test/fixtures/dsh-media-desk-capture.mjs`：真实打包界面与 DomainRuntime、模拟 SDK 传输，截图覆盖深浅主题和窄容器；不能替代 Electron 或在线模型验收。
- `test/fixtures/dsh-media-desk-browser-capture.mjs`：在真实 Chromium 中用随包 UI 和模拟 SDK 检查表格，覆盖深浅主题、1024/390px、从末列 Tab 到标题时的完整焦点轮廓，以及 Enter 和空格打开 Studio。带 `--gesture` 检查真实鼠标拖动、注入取消后的复原及正常释放的存盘请求。

Windows Electron 上述主链已通过；四个 TypeScript 项目和定向组件/宿主回归通过。Chromium 夹具记录48张截图，代表状态已人工打开查看。

本地视觉证据在 `.tmp/ui-captures/dsh-media-desk/`，核对记录为其中的 `review.md`。自动化通过与用户最终外观验收分开记录；macOS/Linux 尚无真机验收。
