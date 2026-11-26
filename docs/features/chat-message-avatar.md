# 会话消息头像

> 状态：实现说明 v4（2026-10-25：§3 补 data-sender='scheduler' 的 CSS 限定消费约束——调度面板普通 assistant 行同带该值，裸选择器会误伤）；v3（2026-10-20）
> 代码主入口：`src/shared/userAvatar.ts`、`src/main/userAvatarFile.ts`、`src/renderer/src/userAvatar.ts`、`src/renderer/src/components/AvatarPicker.tsx`、`src/renderer/src/components/ChatMessageAvatar.tsx`、`src/renderer/src/components/settings/UserAvatarSettings.tsx`
> 关联：[chat-surface.md](chat-surface.md)（转写布局）· [theme-system.md](theme-system.md)（外观页即时偏好）

会话流的普通 AI 回复不渲染头像或占位，正文使用完整内容列宽度。用户输入保留右侧头像和气泡；跨会话 Agent 汇报、调度注入与宿主通知的头像和气泡靠左；各来源身份与历史停靠点语义保持独立。子代理使用 [职业角色头像](subagent-characters.md)。

新跨会话通信见 [宿主邮箱](session-mailbox.md)：信件正文不再成为对方用户气泡，只有 host 收信提醒使用宿主方印；旧 source=agent 历史仍保留职业头像。

## 1. 用户可见行为

- **头像位**：用户、`source=agent` / `source=scheduler` 注入和 `host:true` 通知均显示；用户放右侧，其余来源放左侧；圆形 28px（标准控件高），间距 8px，首行顶对齐。普通 AI 回复不挂头像 DOM，间距为零，释放原头像轨的 36px；宿主为方形圆角（`--radius-small`）内嵌「宿主」二字。
- **发送者**：
  - 跨会话汇报（`source=agent`）= 发送者 `sourceAgent.characterId` 对应的 24 个内置职业符号之一，使用透明扁平图，无圆形底盘/描边/圆角裁切，仍占既有 28px 槽；无角色的旧消息回落工程师「铆钉」，不借用接收者、用户或调度头像
  - 调度注入（`source=scheduler`，不论所在表面）= 当前工作区图标（emoji / 图），否则区名首字 / 🤖；调度面板自身的普通 assistant 回复也不显示头像
  - 宿主通知（`host:true`）= 「宿主」方印（优先于 source）
  - 用户（输入框手打，`role=user` 且无 source/host）= 外观设置所选
  - Worker/assistant = 不渲染头像，runtime/会话身份仍保留在上下文，不占正文宽度
- **连续省略**：同发送者、同展示方向且中间没有时间分隔 / 压缩线时，后一条保留对应侧空位不画脸（`.is-omitted` + `.chat-turn-anchor.is-continued` 压紧间距）。省略位无 `title`。跨会话 agent 消息保持逐条头像，避免多个代理混淆；连续 AI 回复仍可压紧间距，但不挂头像占位；调度面板普通 assistant 与调度注入即使 sender 同为 scheduler，也不互相省略或归为连续消息。
- **头像材质**：所有默认文字/emoji 头像共用 resolver 的 `--identity-surface / fg / border` 中性配对，不随项目色染底；调度、Worker 和用户的区别由图案与发送者名表达。图片保持原内容，连续省略仍为透明占位。`ChatMessageAvatar` 的 `data-avatar-face` 区分图片与文字，两个聊天壳不再另设颜色覆盖。
- **悬浮名字**：保留的头像带 `title`（完整发送者名），由全局 `TooltipHost` 接管——350ms 延迟、`.app-tooltip.mp-pop`。跨会话汇报=发送时的会话名（职业），调度注入=「调度 Agent」，宿主=「宿主」，用户=设置里的显示名（空则「我」）。
- **消息时间与操作**：简洁会话中，用户、调度注入与宿主通知共用气泡下方的 `ChatHoverbar`，仅悬浮消息或键盘聚焦消息内控件时显示；宿主不再额外挂常显的顶部时间。非简洁布局保留顶部时间位，也遵循悬浮/聚焦显示规则。
- **外观设置 → 头像**：仅提供 24 个内置职业符号、上传图片（中心裁方、缩到 128、按圆裁切）和显示名；用户已要求移除 emoji 网格、自定义输入与采用按钮。图案沿用 [子代理职业角色](subagent-characters.md)；点选即时保存并更新已挂载消息的用户头像，重启仍选中，用户显示名保持独立。内置符号用透明头像槽，上传图仍按圆形展示。工作区使用独立的软件/游戏分类符号目录，两处都关闭 `allowEmoji`。历史 emoji 配置仍兼容显示，不主动覆盖用户旧选择。

## 2. 数据与落盘

- `AppConfig.userAvatar`：`{ kind: 'emoji', value, displayName? }`、`{ kind: 'builtin', value: characterId, displayName? }` 或 `{ kind: 'image', displayName? }`。`displayName` 最长 32，空则悬浮回落「我」。内置 id 由 `getSubagentCharacter` 白名单校验，无效 id 回落缺省 emoji；配置不保存打包 URL 或图片副本，主进程保存/重启 hydrate 保留 id，渲染层将 id 映射到静态资源。
- 自定义图像素在 `userData/avatars/user.png`；`config.json` 的 image 项不内嵌 data URL。`config.get()` 会 hydrate 成 data URL 给渲染层。
- 从上传图改为内置符号或 emoji 会清除用户上传文件；切回上传仍走原文件持久化路径。`setUserAvatar` 的慢响应守卫和失败回滚同时适用于内置符号，避免陈旧保存结果覆盖新选择。
- **热更新兼容**：旧主进程不认识 `kind=builtin`，会把 `value=scout` 回写为 `kind=emoji`。归一层将这类白名单 id（含旧字符串形式）恢复为 builtin，适用于保存返回、旧配置加载与重启，避免符号闪一下变成 ID 文字；任意 URL 和未知 id 不走该恢复。2026-10-20 用户现场主进程启动时间为 15:45，早于本次类型扩展，新启动 Electron 用例不能独自覆盖这个版本差异。
- 渲染层模块态 `src/renderer/src/userAvatar.ts`（与 locale / panelGlow 同款三段：默认 → `initUserAvatar` 校正 → `setUserAvatar` 立刻改 + `config.update`）。
- 头像图片超出落盘上限或数据无效时，保存失败原因按当前语言提示，已有头像保持不变。
- 子代理 `SessionMeta.subagentCharacterId` 保存创建时角色。投递核从发送者生成 `sourceAgent={sessionId,name,characterId?}`，只允许内置角色 id，经 GUI 注入、排队、历史落盘/恢复、分叉和展示转换保留；旧汇报不随发送者改名/删除换脸。图片由 `src/renderer/src/subagentAvatars.ts` 静态导入，无任意 URL 或正文解析。

## 3. 接线

- `ChatSurfaceView` 从 workspaces / sessions / runtimes 拼 `ChatAvatarContext`，传入 `ChatTranscript`。
- `ChatMessageView` 自己订用户头像模块态（设置一改，已挂载气泡立刻换脸），不经 props 打穿；`hasChatMessageAvatar` 判断显示条件，仅用户使用 `is-right-aligned`，其他带头像来源使用 `is-left-aligned`，`is-avatarless` 去掉 AI 头像轨和间距。
- `ChatMessageView` 将 agent 消息的身份快照解析成角色图片与名字，再交给既有头像 resolver；24 个角色及选择规则以 `shared/subagentCharacters.ts` 为单一目录。调度/宿主优先级与用户即时设置不变。
- 外观页与新建/编辑工作区共用 `AvatarPicker`，两处均为 `allowEmoji=false`。用户头像选 24 个职业符号，工作区选 [36 个软件/游戏分类图标](workspace-icons.md)，各自保留上传；通过 `imagePresets` / `selectedImagePreset` / `onPickImagePreset` 接线。用户图案以 `ChatAvatarContext.userBuiltinAvatarUrl`、工作区图案以 `workspaceBuiltinAvatarUrl` 交给 resolver 生成透明 symbol 头像，避免内置 ID 显示成文字。用户上传仍走 `cropScaleAvatarFile` + `setUserAvatar`。
- 用户气泡右对齐、左侧留白；调度注入、宿主及代理气泡左对齐、右侧留白，均保留无阴影圆角样式；调度不复用用户头像，宿主保留方印、等宽字体和来源 class。该展示不改 `isUser` / `host` / `source`：插话分段 / 贴底仍按「用户回合」（含调度注入）重挂，历史停靠点只收人手打（`isHumanUserMessage`）。
- 调度与跨会话注入的 Markdown 正文共用 `--font-body`，h1–h6 继承正文字号与行高；跨会话消息的标题还继承正文的字重，兼容旧记录被 Setext 误解析为标题的情况。选择器限定左侧 `data-sender=scheduler/agent`，普通 AI 回复与宿主通知沿用各自排版。**消费约束**：`data-sender='scheduler'` 不独占表示调度注入——调度面板的普通 assistant 回复经 `chatAvatarSender` 也回落 `'scheduler'`，该值仅配合来源布局 class（`.is-left-aligned` 前缀）做 CSS 限定消费才安全；**禁止新增裸 `[data-sender='scheduler']` 选择器**（会误染调度面板普通 AI 回复的排版），新增消费面时应改按 avatarless 行回落 `data-sender='assistant'` 的方向评估。普通留言、审计及异常包装使用空行分段，不再把 `---` 紧贴正文（会把整段渲染成 h2）；不改写已有历史文本。
- 用户本人消息（`.chat-msg.user`，排除host与scheduler）使用 `--user-bubble-bg`：开启工作区主题色时取实际accent，关闭时恢复原 `surface-raised` 中性底色，不使用固定蓝色。正文始终使用全局fg-primary，和其他正文一致，不按气泡底色反转；链接单独配对并登记对比度。用户本人气泡不绘制描边或高亮框，头像、圆角、尺寸和无阴影状态不变，其他来源气泡仍为中性底色。

## 4. 回归

- `test/chat-avatar.mjs`：发送者 / 省略 / 归一 / face / 悬浮名 / 调度注入 vs host
- `test/chat-message-source.mjs`：历史来源判定与用户/宿主消息构造
- `test/subagent-characters.mjs`、`test/subagent-role-delegation.mjs`、`test/sessions-message.mjs`、`test/gui-host-lifecycle.mjs`：内置资源、工具选角、创建名、主动/自动汇报与忙时排队/历史身份。
- `test/e2e/subagent-role-avatar.spec.ts`：真实 Electron 走受控模型派活、主动汇报、角色图片加载及历史落盘；组件测试另覆盖全部 24 角色的展示转换。
- `test/user-avatar-config.mjs`：缺省、emoji 落盘、image 文件、重启 hydrate、显示名往返、全部 24 个内置 id 保存/重启、非法 id 拒绝以及上传/内置/emoji 切换
- `test/unit/chat-message-avatar.spec.tsx`：两种 AI 表面无头像 DOM/占位、调度注入与宿主左侧和用户右侧布局 class、消息时间统一位于共用悬浮栏且不重复、非简洁宿主顶部时间位、注入头像与名义、普通回复与注入分组隔离、title / TooltipHost 350ms mp-pop、设置点选与显示名实时生效、连续省略无 title
- `test/unit/user-avatar-settings.spec.tsx`：24 个符号逐个点选、保存 id、设置预览和消息头像即时更新、旧主进程回写 emoji:scout 的恢复、用户设置无 emoji 控件、显示名/失败回滚、上传和通用选择器旧调用兼容
- `test/e2e/user-symbol-avatar.spec.ts`：独立沙箱，现场遗留 emoji:scout 配置恢复、真实设置入口点选/保存、无 emoji 控件、完整应用退出重启仍选中符号；不调用外部模型

## 设计初衷（2026-10-26 与用户定稿）

> 依据 campaign-intent-drafts/D06.md 草案定稿（用户 2026-10-26「不抽查直接定稿」）；歧义点处置：22 项卡片决策＋长尾按草案推荐，明细见专项账本「意图定稿决策」节。

- 为谁/什么场景：会话流身份视觉：用户输入使用右侧头像与气泡，调度注入/宿主通知/跨会话 agent 汇报使用左侧头像与气泡，普通 AI 回复零头像释放正文宽度；24 个内置职业符号+上传图，外观设置点选即时生效并更新已挂载消息。
- 为什么这样设计：2026-10-20 v3 按用户明确要求收敛（移除 emoji 网格/自定义输入/采用按钮）；头像材质统一 resolver 中性配对不随项目色染底；连续同来源省略脸不省位、跨会话 agent 逐条头像防多代理混淆且身份快照落盘（不随改名/删除换脸）；旧主进程把 builtin 回写成 emoji 的归一层恢复（热更新兼容已实测）。
- 明确不做：不做 AI 回复头像/占位；用户头像与工作区图标用独立目录（24 职业 vs 36 软件游戏）且都禁 emoji；历史 emoji 配置兼容显示但不主动覆盖；展示层不改 isUser/host/source 语义（停靠点只收人手打、贴底按用户回合含注入）。
- 歧义点：无真决策（v3 即用户返修定稿，边界即用户裁决）。
