# 工作区分类图标

> 已实现，2026-10-20。关联：[工作区管理](workspaces.md)、[会话头像](chat-message-avatar.md)。

## 行为与范围

新建和编辑工作区共用 36 个扁平透明分类图标，包含 24 个软件类别和 12 个游戏类别；通用游戏使用手柄。表单缺省选择「开发」，展开头像区即可更换，选中态、顶部预览与保存草稿一致。用户要求移除工作区 emoji 网格、自定义输入和采用按钮；上传图片继续支持。原有头像折叠、保存锁、取消草稿和文件夹管理保持原合同。

已有工作区的 emoji 和上传图片继续显示，不在升级时批量覆盖；重新选分类图标后转为内置 ID。图标名称是类别标签，不参与工作区名称或 AI 人格。完整目录以 `src/shared/workspaceIcons.ts` 为准。

## 数据与入口

`WorkspaceInfo.avatar` 沿用字符串，内置项保存 `builtin-workspace:<id>`，例如 `builtin-workspace:news`、`builtin-workspace:gamepad`。不写入打包后 URL、文件绝对路径或图片副本。`workspaces.open/update`、Store 与 ConfigManager 沿原字符串链路保存，旧主进程也能原样回传，避免新增用户头像类型时出现过的版本混用问题。

- `src/shared/workspaceIcons.ts`：36 个 ID/类别、缺省值、编码和白名单解析；未知 ID 不允许由选择器编码。
- `src/renderer/src/workspaceIcons.ts`：静态导入 36 张 WebP，统一解析已知 ID、上传 URL 与旧数据。带内置前缀但 ID 无效时显示开发图标，避免把协议串绘成文字；不把任意路径当作内置资源。
- `components/CreateWorkspaceModal.tsx` → `AvatarPicker.tsx`：新建与编辑均传本地图标预设、当前 ID 和 `allowEmoji=false`。保存字段仍为 avatar，上传仍使用原文件入口；折叠沿用 usePresence/acc。
- `panels/AgentFloat.tsx`：左栏工作区堆叠及调度面板标题使用同一解析器。
- `panels/SchedulerReplyBubble.tsx`：左栏未读调度回复气泡复用工作区身份位置；全局看板不再渲染调度入口。
- `mobile/pages/WorkspaceListPage.tsx`：手机列表读取同一元数据及静态资源。
- `components/ChatMessageView.tsx` / `shared/userAvatar.ts`：调度注入的工作区图标解析为 `workspaceBuiltinAvatarUrl`，使用透明 symbol 头像槽。
- `avatarAccent.ts`：内置 ID 先解析成图片再走原 32px 画布取色，保持「跟随头像」主题色合同；失败仍按既有逻辑回落。
- `styles/float.css`、`styles/left.css`：停靠列表的 14px 头像图案与会话图标居中对齐，按钮命中区为 24px。内联浮层用 32px 的独立头像按钮，图片在边框内四周留 2px。历史 emoji 分别使用 `--font-control` 和 `--font-ui`。展开和折叠共用各自布局的尺寸。

## 资源与平台

用户批准的 1254×1254、6×6 原图、裁切坐标及重建脚本在 [设计来源](../prototypes/workspace-icons/README.md)。36 张为 256×256 透明 WebP，主体等比放入 208px，四边 24px 留白；合计 373940 字节。仅运行时单张图标进入本地资源包，设计总图不随应用加载。

Windows/macOS/Linux 共用 ID、静态资源和既有保存接口，没有新增平台 API 或远程依赖。手机和浏览器也使用构建资源，不读取桌面文件路径。

## 验证

- `test/workspace-icons.mjs`：目录唯一性、白名单/默认值、稳定字符串往返，36 张透明 WebP 的格式和尺寸。
- `test/unit/workspace-icons.spec.tsx`：36 项逐个点选保存、新建默认值、通用手柄、重新编辑选中态、上传/旧数据解析及调度符号。
- `create-workspace-accent.spec.tsx` / `task-workspace-simplification.spec.tsx`：保存头像色缓存、折叠草稿保留及既有交互；工作区表单不覆盖主题作用域。
- `test/e2e/workspace-icons.spec.ts`：独立沙箱，受控系统目录选择器，触发既有新建按钮打开表单后，以实际点击验证图标/保存、右键菜单编辑、完整重启、左栏/看板显示、旧 emoji 保留及取色缓存。Windows 原生悬浮按钮状态不稳定，入口直接调用按钮 click；该用例不证明悬浮行为。
- 本机视觉产物 `.tmp/ui-captures/workspace-icons/`：生产新建/编辑组件、看板/调度/手机组件，深浅主题和 780/390px；资源 80/28px 对照在 `.tmp/workspace-icons/`。字体 CDN 故障时使用产品既有回退字体，不能据此宣称 OPPO 字体加载成功。

本轮结果：相关离线 5 文件、组件 6 文件共 107 项、Windows Electron 专项 1 项及构建通过。Node/Web 类型检查通过；测试类型检查仍受未改动的 `selection-menu-host.spec.tsx:130/131` 两处 `Element.style` 错误阻塞。

跨平台代码共用不等于三平台真机验收；macOS/Linux 真机另行验证。

## 设计初衷（2026-10-26 与用户定稿）

> 依据 campaign-intent-drafts/D08-D00.md 草案定稿（用户 2026-10-26「不抽查直接定稿」）；歧义点处置：22 项卡片决策＋长尾按草案推荐，明细见专项账本「意图定稿决策」节。

- 为谁/什么场景：36 个扁平分类图标（24 软件+12 游戏）供新建/编辑工作区表单选择；左栏堆叠、调度面板标题、未读回复气泡、调度注入头像、手机列表共用同一解析。
- 为什么这样设计：avatar 字段沿用字符串+`builtin-workspace:<id>` 白名单（不写打包 URL/绝对路径/图片副本，沿原链路保存防版本混用——旧主进程也能原样回传）；未知内置 ID 落开发图标（不把协议串绘成文字）；旧 emoji 与上传图片继续显示、不升级时批量覆盖；取色先解析成图片再走原 32px 画布（保持「跟随头像」主题色合同）；资源静态导入进构建、设计总图不随应用加载。
- 明确不做：emoji 网格/自定义输入/采用按钮不恢复（用户明示要求移除）；图标名不参与工作区名称或 AI 人格；三平台共用资源无新增平台 API——macOS/Linux 真机未实测（归 X6 横切）。
- 歧义点：无真决策（移除 emoji 入口是用户明示要求属已定稿；图标集扩充、圆形容器裁切等均为实现细节，不改变 review 判定）。
