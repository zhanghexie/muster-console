# 主题系统（色彩主题 · 色盘编辑 + JSON 底座 + Agent 工具）

模型出口在 `src/shared/interfaceToolResult.ts` 对 create/update 的成功结果只去掉完整 `colors/terminal`，保留保存后的主题身份、名称、外观及其他告警/证据字段；`get` 仍返回完整色盘。`list` 省略与 activeId 一致的完整 active 色盘，保留主题摘要与作用域。原始服务结果和 UI 广播不变；逐动作理由和超过 12k 的放大回归见界面工具回执审计。

> 状态：实现说明 v4（2026-10-09：单一 ResolvedAppearance、按表面配对前景、跨渲染器配色、启动缓存与拾取层同源）
> 代码主入口：`src/shared/theme.ts`、`src/shared/resolvedAppearance.ts`、`src/main/themes.ts`、`src/main/windowMaterial.ts`、`src/main/ipc/themes.ts`、`src/renderer/src/theme.ts`、`src/renderer/src/RootLayout.tsx`、`src/renderer/src/useWorkspaceAppearance.ts`、`src/renderer/src/editor/workbenchCmTheme.ts`、`src/renderer/src/components/settings/ThemePane.tsx`、`src/renderer/src/uiFont.ts`
> 关联：色彩 token 基准见 `src/renderer/src/styles/base.css` 与 `/design.md` §1；字阶/字重约定见 `/design.md` §5；框色见 [frame-backdrop.md](frame-backdrop.md)；消息头像见 [chat-message-avatar.md](chat-message-avatar.md)

主题系统只管**颜色**（灰阶海拔、文字、状态色、语法色、交互叠层、终端 ANSI 色）；圆角/字阶/层级等结构 token 不在主题范围内。外观页显示主题、配色和你的头像；界面语言与字体已移到「通用」页，见 [settings.md](settings.md)。**字体**（`AppConfig.uiFont`/`uiFontScale`）即时换界面字体族与字号档；**头像**（`AppConfig.userAvatar`）即时改会话流用户脸。旧效果配置仍可读写，但没有用户入口或渲染作用，见 [frame-backdrop.md](frame-backdrop.md)。

---

## 1. 用户可见行为

- 设置 →**「外观」**页：顶部主题缩略图卡片网格（内置「深色（默认）」「浅色」+ 自定义 + 新建卡），下方「配色」分区为**色盘编辑器**。
- 全部操作**即时生效**，不需要点设置底部「保存」。
- **内置深色阅读层级**：导航框 `#202023` 比聊天/文件阅读面 `#141416` 稍亮；阅读面与终端/编辑器画布同色，柔白正文仍为 `#EDEDEE`。与浅色的灰框/白页对应，让文字密集区获得更高对比度。只调整背景 token，不改变字体、字重、布局或交互；渲染默认值、扩展 SDK 和原生窗口初始色同步。
- **内置浅色配色**：导航框种子为 `#f0f3f9`，阅读面为纯白，输入控件种子为淡灰 `#f2f3f5`，避免白色会话中输入框只靠边框区分。实际控件消费 `--surface-input` 与其配对文字，保持单层中性描边，聚焦用明确焦点边框，不叠发光环；会话输入壳在深浅主题的静息与聚焦态均无阴影，规则见 surface-elevation.md。该调整复用浅色 `bg-input`，不改变深色仍从 `bg-raised` 派生的输入底色。
- **主题色**：入口统一到「设置 → 外观 → 主题色」（`WorkspaceAccentSettings.tsx`），可选全局默认或仅当前工作区。范围切换只选择编辑对象；颜色、跟随头像与启用开关选后即保存。全局默认不覆盖已有工作区设置；当前区可「恢复跟随全局」，同时继承颜色与启用状态。Windows 11 22H2（build 22621）及以上的桌面主窗口默认整圈框 Mica，macOS 桌面主窗口默认整圈框原生 Vibrancy（sidebar 毛玻璃），都覆盖侧栏、顶栏、原生控制区、底边、布局留白与设置导航。主题色关闭时直接露出原生材质，没有框色覆盖；启用时 `.app-shell` 只叠一次 28% 纯工作区色，`--workspace-native-tint` 在 sRGB 中与透明色混合，不掺 `bg-frame`。不透明阅读卡和输入壳只保留均匀主题色混合与同色轻染的装饰边缘（关闭主题色时恢复中性）；回退框色仍由工作区色以 28% 在 oklab 中混入 `bg-frame`。材质深浅跟随主题 `appearance`，开关主题色不关闭原生材质。Linux、浏览器客户端和原生失败时使用均匀实色框；窄屏抽屉保持不透明。框、阅读卡、输入、抽屉和回退模式全部不叠噪点贴图，无颜色渐变或 CSS 实时模糊，不新增配置字段，见 [frame-backdrop.md](frame-backdrop.md)。
- **主题色预设色板**：头像跟随入口之外提供一组柔和明亮的科技感配色：蓝 `#4d88e6`、紫 `#9276d8`、粉 `#d968b2`、红 `#e66a73`、橙 `#e58a52`、黄 `#d9b544`、绿 `#5fae83`、灰 `#9299a6`；全局缺省仍为跟随头像。
- **主题色存储与同步**：`AppConfig.workspaceAccentDefault = { accent: 'avatar' | '#rrggbb', enabled: boolean }` 保存全局默认；工作区已有 `accent/accentOff` 保留为整组覆盖，`avatarAccent` 仅是头像取色缓存。新建区不写覆盖，编辑头像仅更新头像和缓存。`config:update` 更新全局默认后通过 `workspaces:changed` 广播；store 启动从 config 水合默认，列表变化登记查表，`workspaceAccentEnabled` 与 `workspaceAccent` 共用作用域规则。清除覆盖用 `workspaces:update { accent:null, accentOff:false }`，不清头像缓存。设置表单保存剔除默认与工作区快照，避免旧草稿覆盖即时更改。
- **旧效果配置**：`globalPanelGlow`、`frameEffects`、`frameBackdrop` 字段保留用于旧配置与壁纸数据兼容。启动不再初始化对应渲染 store，外观页和命令面板不再显示效果入口。
- **用户消息气泡**：用户本人消息跟随开启的工作区主题色，关闭时恢复原有 `surface-raised` 中性底色，不使用固定蓝色。`resolveAppearance` 输出独立 `user-bubble-bg/fg/link`，正文始终跟随全局正文fg-primary，不按气泡底色自动反转深浅；链接保留对比度检查。用户本人气泡不绘制描边或高亮框；主题色开关/换色即时更新。只消费在 `.chat-msg.user`，调度注入、宿主通知与AI回复沿用各自表面。
- **头像**（消息头像）：与工作区选择器同结构（预设 emoji 网格 + 自定义 emoji + 上传图片，裁圆缩放后落 `userData/avatars/user.png`）+ 显示名（悬浮气泡）。`setUserAvatar` 立刻改会话流并 `config.update({ userAvatar })`；设置表单「保存」剥离不回写。
- **字体**：字体族四档（OPPO Sans 默认 / MiSans / HarmonyOS Sans / 跟随系统）+ 字号三档（紧凑/标准/宽松 = 字阶 token 整体平移，standard 与 base.css 默认一致，`test/ui-font.mjs` 解析 base.css 真对照防漂移）。`setUiFont` 经 `:root` 内联变量覆盖 `--font-sans`/`--font-mono`/七个字阶 token 即时生效（默认档 removeProperty 回落 CSS 单源），并 `config.update({ uiFont, uiFontScale })` 落盘（save payload 白名单含此二字段，`test/ui-font-config.mjs` 磁盘往返守卫）；所选字体的中文同时是等宽栈的中文回落（编辑器/代码块）。字体注册：OPPO Sans = base.css @font-face（官网 woff2，默认字体随首屏就绪），MiSans/HarmonyOS 的 CSS link 由 `uiFont.ts` 在**选中该字体时**动态注入（index.html 禁静态外链——渲染阻塞守卫；woff2 仍按 unicode-range 分包按需下载）；离线回退系统字体栈。终端字体走 `getTerminalFontFamily()`（固定纯等宽栈、**不随界面字体**——UI 字体是比例字体，xterm 按栈内命中字体的 'W' 宽定列宽、fontBoundingBox 定行高，比例字体把横竖间隙撑得显著大于等宽；中文由系统兜底，2026-10-26 起），已开终端不热更、新终端生效；终端字号固定、不随字号档。
- **切换主题**：点击列表行即选中并按**当前作用域**切换（幂等）——当前工作区设有独立主题时只切本工作区，否则切全局默认。
- **工作区独立主题**：每个工作区可在「当前工作区主题」下拉里单独指定一份主题（或「跟随全局默认」）。生效优先级 = 工作区覆盖 → 全局默认 → 内置深色；**切换工作区自动换肤**（主进程在激活漏斗里重放主题）。列表行以徽标区分：「使用中」（当前生效）、「本工作区」（该区独立主题）、「全局默认」。
- **新建主题**：输入名字创建，自动**复制默认深色主题**一份并切换过去，落盘为 `userData/themes/<id>.json`。名字输入的 Enter/Escape 先检查原生 `isComposing` 和 `keyCode === 229`，输入法确认/取消候选不创建或退出；共用 `AvatarPicker` 的自定义输入 Enter 同样守卫。组件回归见 `test/unit/frontend-ime-actions.spec.tsx`，原生系统输入法仍需人工验证。
- **色盘编辑**：自定义主题按分组改颜色种子。背景、文字、状态、语法与 ANSI 必须不透明；透明度控件只对交互、骨架、遮罩和终端选区可编辑，统一使用 `themeColorAllowsAlpha(section,key)`。合法改动以 `applyTheme(theme,{persist:false})` 实时预览；未保存稿不写启动缓存。「保存」才经 IPC 写格式化 JSON；「重置」恢复已保存版本。
- **删除**：自定义主题列表行悬浮（或键盘聚焦）出现行内删除入口，**不必先选中该主题**；内置 dark/light 不出现删除按钮。点击打开共用 `AppConfirmDialog`，显示主题名和引用回落影响；编辑器底部「删除」使用同一弹窗，取消不改主题，确认才删除。确认后主进程**级联清理引用**——全局默认指向它时重置回深色，各工作区的独立主题覆盖随之清除（该区回到跟随全局），列表原地刷新，界面经广播自动回落；内置主题不可删（可「复制为新主题」）。行内按钮显隐过渡只用 `--dur-micro` / `--ease-hover`。
- 阴影种子仍支持多段 box-shadow 或 `none`。resolver 从 `shadow-page/card/pop` 去掉零偏移、零模糊的 1px 外环，只保留真正投影；输入最终阴影为 `none`，tooltip 使用轻投影。原始 JSON 种子不会被可读性修正或阴影规整回写。
- 启动时：主进程按实际生效主题在加载页面前初始化窗口材质与标题栏；Mica 窗口保留透明 Chromium 底，回退窗口预刷框色。React 入口前的骨架与启动错误提示先使用同源生成的默认角色，再读取最近已保存外观的最小启动缓存；渲染层加载完整已保存主题后经 IPC 与工作区 scope 校正。未保存色盘预览不进入任一启动缓存。
- **调度 Agent 可管理主题**：`themes.list / themes.get / themes.create / themes.update / themes.activate / themes.remove` 六个 Catalog 工具（`remove` 走用户确认门），与设置页同一 ThemeService 底座——Agent 改主题，界面经 `themes:changed` 即时刷新。`themes.activate` 支持 `scope: 'global'（缺省）| 'workspace'`：workspace 配合 `workspaceId` 可给任意已打开工作区设独立主题，`followGlobal: true` 清除覆盖回到跟随全局。activate 对 id 强制小写后解析（slug 生成即小写，Linux 文件名大小写敏感）；未知 id 报「主题 "{{id}}" 不存在（主题 id 需全小写）」，提示大写 id 已被小写化。

## 2. 主题 JSON 格式

```json
{
  "name": "夜蓝",
  "appearance": "dark",
  "colors": {
    "bg-frame": "#202023",
    "bg-canvas": "#141416",
    "bg-panel": "#141416",
    "bg-raised": "#232326",
    "bg-overlay": "#262629",
    "bg-input": "#161618",
    "ink": "#ededee",
    "ink-soft": "#d6d6d6",
    "text-2": "#9e9e9e",
    "text-3": "#7e7e7e",
    "hairline": "#2c2c2c",
    "green": "#45d0a0",
    "yellow": "#dcc765",
    "red": "#f3687b",
    "blue": "#6cc2ff",
    "purple": "#a88fff",
    "syn-fg": "#c9d1d9",
    "syn-muted": "#8b949e",
    "syn-blue": "#8ac6ff",
    "syn-cyan": "#a5d8ff",
    "syn-red": "#f88b9a",
    "syn-purple": "#c3b1ff",
    "syn-orange": "#ffb37d",
    "syn-yellow": "#e8d47c",
    "hover-fill": "rgba(250, 250, 250, 0.05)",
    "hover-fill-strong": "rgba(250, 250, 250, 0.1)",
    "selected-fill": "rgba(250, 250, 250, 0.08)",
    "shadow-card": "0 0 0 1px rgba(255, 255, 255, 0.06), ...",
    "shadow-pop": "0 8px 24px rgba(0, 0, 0, 0.55)",
    "skel-a": "rgba(255, 255, 255, 0.04)",
    "skel-b": "rgba(255, 255, 255, 0.09)",
    "scroll-thumb": "#404040",
    "scroll-thumb-hover": "#525252",
    "scrim": "rgba(0, 0, 0, 0.5)"
  },
  "terminal": {
    "background": "#1a1a1a",
    "foreground": "#e4e4e4",
    "cursor": "#fafafa",
    "cursorAccent": "#1a1a1a",
    "selectionBackground": "#3f3f3f",
    "selectionInactiveBackground": "#333333",
    "black": "#1a1a1a",
    "red": "#f3687b",
    "...": "...（16 色 + bright 8 色，见 TERMINAL_COLOR_KEYS）"
  }
}
```

规则：

- `colors` 键是 `THEME_COLOR_KEYS` 的可编辑种子；缺省键按同 appearance 内置主题回填。`surface-*`、`fg-*` 等最终语义角色由 resolver 计算，不属于 JSON 编辑键。
- 色值只收 `#hex`（3/4/6/8 位）/ `rgb()` / `rgba()`；阴影键另收完整 box-shadow 多段值或 `none`。命名色/`var()` 一律拒绝。
- 不透明种子拒绝 alpha<1。仅 `hover-fill`、`hover-fill-strong`、`selected-fill`、`skel-a/b`、`scrim`、阴影及终端两种选区允许透明；原生 tint 是 resolver 根据工作区配置产生的专用材质层。
- `id` 不写入文件——**文件名即 id**（创建时由名字 slug 化，中文名回退 `theme`，冲突追加 `-2`）。
- `appearance: light` 会同时把 `color-scheme`、原生控件（滚动条/表单）与支持窗口的原生材质（Mica/Vibrancy）转浅色；原生材质不以当前框色的明度推断深浅。

## 3. 架构与数据流

```text
src/shared/theme.ts      主题模型 + 内置深/浅定义 + parseTheme 校验/回填 + formatThemeJson 格式化
        ▲（主/渲染共享）
src/main/themes.ts       ThemeService：list/get/create/save/remove/activate/applyChrome
src/main/ipc/themes.ts   IPC：themes:list|get|create|save|remove|activate|revealDir + themes:changed 广播
src/shared/resolvedAppearance.ts 纯 resolver：主题种子 + workspace scope → 最终 surface/fg/state/renderer palette
RootLayout/useWorkspaceAppearance.ts 桌面与移动入口共用，layoutEffect 在 paint 前同步 scope
src/renderer/src/theme.ts applyTheme / setWorkspaceAppearance → 同一 revision 的 CSS、nativeChrome 和订阅
                          subscribeAppearance → CM compartment / xterm / 扩展 SDK
scripts/generate-appearance-defaults.mjs DEFAULT_RESOLVED_DARK → base.css / SDK theme.css / index.html 启动默认块
src/renderer/src/windowChrome.ts  app:setChromeTheme；宿主确认后设置 data-native-material
src/main/windowMaterial.ts       每窗口材质状态；同步 nativeTheme、窗口底与 titleBarOverlay
ThemePane.tsx            设置「主题外观」页（列表/新建/JSON 编辑/保存）
```

关键机制：

- **最终角色**：`surface-frame/canvas/chrome/raised/input/overlay` 是不透明实色；每面有独立 `*-fg-*`、`*-fg-selected-*`、`*-interaction-*`、`*-status-*` 和 `*-border-focus`。普通前景同时校准静止/hover/pressed，选中前景同时校准 selected/selected-hover；各面文字不足 4.5:1 时局部调整，不全局提亮辅助字。自定义色使一组状态跨过黑白前景均无法共用的临界区间时，只将 hover/pressed 最小回缩到静止背景，或将 selected-hover 最小回缩到 selected；阅读面、selected 本身及原始种子不改，默认色板不漂移。焦点颜色角色仍按实际表面及其 hover/pressed 校准；常规配色中按钮与导航键盘焦点用柔和内填充而非外框，输入焦点仍使用对应局部角色，强制配色保留系统焦点轮廓。根 `border-focus` 和 `divider-focus` 取 canvas fallback。
- **看板层次**：`surface-board-column` 同时用于整张看板底面与列，列不再独立描边；它直接复用会话 canvas（包括工作区染色），外壳描边使用同源 surface-edge，不复用框背景。`surface-board-card` 不再绑定输入框：先从 canvas 向主题 ink 轻混（深色 2.5%、浅色 4%），深色再向 ink 混入 4%，浅色向 canvas 回混 85%。普通卡片边框从卡片底向 ink 混入 6.5%；hover/pressed 分别轻混 3.5%/6.5%，并经过既有跨状态可读性校准。选中只加专用 board-card-border-focus。两视图共用同一组配对文字、状态、交互与焦点角色；保留自定义主题种子和工作区染色，不增加设置字段。宿主与 SDK 默认值由同源生成器同步。
- **单次材质**：resolver 保留框 28% oklab、canvas 与深浅色输入均为 12% 实色框混合、raised/overlay 为 8%。工具 chrome 为 canvas+4% ink，选中页签为 canvas+11% ink。CSS 只消费最终颜色，不重新叠项目 tint。Mica 单次纯 accent 28% alpha 与不透明 frame fallback 是两个专用输出。
- **默认单源**：`DEFAULT_RESOLVED_DARK.cssVars` 经生成脚本写入宿主、SDK 与 `src/renderer/index.html` 的 `resolved-appearance:start/end` 块；启动页仅生成骨架 / 错误提示使用的五个角色，避免维护第二套首帧色板；`node scripts/generate-appearance-defaults.mjs --check` 检查漂移。旧 aliases 只映射，不派生另一套材质。中性 primary 与项目 action 分开；身份头像用不随项目色变化的 identity 角色，图片/emoji 原样。
- **色盘实时预览**：`parseTheme` 校验后 `applyTheme(theme,{persist:false})` 仅更新当前 appearance；主题 JSON 缓存和最小启动外观缓存均不写入。预览状态下的后续 scope 发布也不改启动外观缓存。正常非预览 scope 变化只保存最小 boot 五角色，不写完整 ThemeDefinition 缓存；普通 apply 默认恢复已保存状态并允许写两份缓存；保存广播更新原始主题，`getTheme()` 保留编辑种子，`getResolvedAppearance()` 返回当前最终快照。
- **同版本传播**：主题更新或 RootLayout 工作区 scope 改变都经 resolver 发布单调 revision；CSS 写入后同步通知 `subscribeAppearance`。CodeMirror 在独立 compartment 更改深浅 facet 与颜色，保留文档/撤销/选择；xterm 更新具体 theme 并重算 padding；SDK 收全量最终 roles 与同 revision，忽略过期消息，font-only 同 revision 更新仍接受。原生窗口异步返回由 `syncWindowChrome` 请求版本过滤。
- **真实拾取与扫描层**：`TerminalScanOverlay.tsx` 订阅当前 appearance，截图合成的压暗遮罩消费同一 `scrim`，换外观时重新合成，命中洞与键盘流程不变。浏览器元素拾取由主进程在开始操作时读取宿主最终 overlay 底 / 字、shadow、info 标示和 scan-selected 填充，传入 `src/shared/browserPicker.ts` 构造的真实 DOM 脚本；读取失败回生成默认外观，不在 guest 内重建色板。只给宿主拾取覆盖层着色，不改网页原内容，见 [builtin-browser.md](builtin-browser.md)。
- **终端边界**：默认背景、文字、选区与 CM/canvas 同源，16 色 ANSI 身份保留，程序显式单元格背景不被滤镜染色。xterm 的 `minimumContrastRatio:4.5` 校准普通前景；库对 SGR dim 硬编码减半门槛与 0.5 alpha，且没有公开 dim 透明度选项。深色继续使用官方 WebGL，不能宣称所有 dim 也达到 4.5；真实 CLI dim、powerline 仍需目视检查。浅色使用官方 DOM renderer，`terminal/dimContrast.ts` 在公开 `onRender` 后仅检查本次重绘行里的 dim spans：先批量读取文字与实际单元格背景，合成 alpha 后，不足 4.5 时保持色相修正具体前景；字符、缓冲区和显式背景均不改变。深浅切换通过 addon 的公开 load/dispose 保留终端实例、光标与缓冲区，恢复上一模式的前景覆盖；卸载解除订阅，重绘清除已离开 DOM 的引用。浅色因此放弃 WebGL 加速，尚未做吞吐性能基准。
- **窗口色与材质跟随**：`app:setChromeTheme` 接收 `{ panel, ink, appearance? }`；主题同步的 `panel` 是 **`bg-frame`（框色）**，工作区染框同步则传混合后的实色框色。`ThemeService.applyChrome(win)` 和 IPC 共用 `applyWindowChrome`：原生材质窗口（Mica/Vibrancy）保留透明 Chromium 底，Windows 上透明普通态 `titleBarOverlay`（mac 无此 API，天然跳过），符号色仍取 ink，悬停反馈由原生控件提供；回退窗口与控制区才取 panel 实底。`appearance` 单独同步 `nativeTheme.themeSource`，避免框色明暗与符号色改变材质的实际深浅；未传 appearance 时 IPC 取实际生效主题。渲染层 `syncWindowChrome` 只有收到桌面宿主 `{ ok: true, material: 'mica' | 'vibrancy' }` 才开启整圈透明框，浏览器客户端和失败响应保持实底。透明框只由 `.app-shell` 画一次纯工作区色覆盖，顶栏、主工作面、Git 页、设置页与折叠框层不再分别涂底或铺颗粒；阅读卡与输入保持不透明。启动时在加载页面前初始化原生材质（index.ts 创建参数仍保留深色框色字面量，满足 design-lint §5 同步检查）。旧自定义主题缺 `bg-frame` 时由同外观内置主题回填。`test/theme.mjs` 逐键校验内置深色与 base.css `:root` 同值。
- **启动缓存分层**：`muster.theme.cache.v1` 保存最近已应用的完整主题 JSON，读取时经 `parseTheme` 校验，坏值回内置深色；`muster.appearance.boot.v1` 只保存最近非预览发布的 `surface-frame`、`surface-raised`、`status-danger-bg/fg/border` 五个最终角色。index.html 在入口 module 前按白名单同步取这五个值，供骨架与 boot-diag 使用；缓存缺失、JSON 损坏或 storage 不可用时回同源生成的默认块。React 启动再应用完整主题缓存、拉 `themes:list` 并由 RootLayout 校正工作区，旧 `muster.theme` 清理。`persist:false` 不写完整主题或最小 boot 缓存，不能把未保存预览作为下次启动外观。
- **当前主题持久化**：全局默认存 `AppConfig.themeId`，工作区独立主题存 `AppConfig.themeByWorkspace`（workspaceId → themeId，config.json），均由 `themes:activate` 即时维护；设置表单保存时会剥离这两个字段不回写。`ThemeService.getActive(workspaceId?)` 按三级回退解析：工作区覆盖（覆盖指向的主题已删则视为未设置）→ 全局默认（指向的主题已删则回深色）→ 内置深色。
- **切换工作区自动换肤**：工作区激活漏斗（`ipc/helpers.ts` `applyWorkspaceActivation` 及 `workspaces:open`/`workspaces:close`）末尾调用 `reapplyActiveTheme(ctx)`（`ipc/themes.ts` 导出）——按新活跃区重算生效主题、`applyChrome` 同步原生深浅与窗口外观并广播 `themes:changed`，Mica 的透明窗口底保持不变。
- **Agent 工具**：`src/main/capabilities/hosts/themes.ts`（`themes.*` 六个工具，Catalog 1.8.0），复用 ThemeService 校验/格式化/广播；`themes.update` 支持 colors/terminal 增量合并；`themes.remove` 标记 dangerous 走 executor 的 ui.confirm 门。Worker/扩展白名单不含 `themes.*`，仅调度 Agent 可用。

## 4. IPC 通道一览

| 通道 | 方向 | 说明 |
|------|------|------|
| `themes:list` | R→M | `{ activeId, active(全量), themes(元信息+色卡预览), dir, globalThemeId, workspaceThemeId?, activeWorkspaceId, activeWorkspaceName? }` |
| `themes:get` | R→M | 按 id 取单个主题全量 |
| `themes:create` | R→M | 从默认深色复制新建，返回新主题 |
| `themes:save` | R→M | 校验+规整+格式化落盘；广播变更 |
| `themes:remove` | R→M | 删自定义主题并级联清理引用（内置拒绝） |
| `themes:activate` | R→M | 写 themeId / themeByWorkspace（按 scope）+ applyChrome + 广播 |
| `themes:revealDir` | R→M | 资源管理器打开主题目录 |
| `themes:changed` | M→R 推送 | 同 `themes:list` 载荷（不含 dir），渲染层据此刷新 |
| `app:setChromeTheme` | R→M | `{ panel, ink, appearance? }` → `{ ok, material?: 'mica' \| 'vibrancy' \| 'solid' }`；同步窗口底/标题栏与实际原生主题深浅 |

Agent 工具（Catalog，调度 Agent 专用；Worker/扩展白名单不含）：

| 工具 | 说明 |
|------|------|
| `themes.list` | 列出主题 + 全局默认/工作区覆盖/生效 id + 主题目录；模型结果不重复附带 `active` 全色盘，以 `themes.get(activeId)` 读取，界面 IPC 与广播仍带完整 `active` |
| `themes.get` | 单个主题全量配色 |
| `themes.create` | 从默认深色复制新建（必传 name） |
| `themes.update` | 增量改 name/appearance/colors/terminal；校验闸门同 UI |
| `themes.activate` | 切换主题；`scope:'workspace'` 只改指定/当前工作区，`followGlobal:true` 清除覆盖 |
| `themes.remove` | 删除自定义主题并级联清理引用（dangerous：用户确认门） |

## 5. 已知边界

- **扩展 iframe 的外观同步**：`ExtensionPanel.tsx` 在 init 与 appearance 中发送完整 resolved roles、revision、结构/字体 token 和字体 URL，主题或工作区色都触发更新；独立窗口经既有 panelAppearance IPC 转发相同载荷。SDK 忽略旧 revision，保留业务实例身份，不重载页面；其原子 CSS 直接取 surface/fg/state roles。扩展写死的颜色/字号仍需扩展作者自行修改。
- **主题目录不做文件监听**：面板外手改 JSON 需重启或在面板里重选该主题才会重读（单个坏 JSON 文件会被跳过并告警，不影响列表）。
- **工作区覆盖的悬空/残留**：覆盖指向的主题被删时由解析链回退（视为跟随全局）；工作区关闭后 `themeByWorkspace` 里的残留条目不清理（无害，同 `mcpByWorkspace` 口径）。
- xterm 主题热切换对已渲染缓冲生效，但终端内程序自设的 ANSI 24-bit 色不重映射（预期行为）。
- **滚动条默认隐藏、悬停显现（登记契约）**：全局 `*` 把 `scrollbar-color` 设为透明，悬停时只对 base.css 三个枚举清单登记的滚动容器显色（收敛自 `*:hover` 通配，避免全树 style recalc 掉帧）。**新增 overflow:auto/scroll 容器必须同步登记进三个清单**，否则该容器能滚但永远看不到滚动条（文件编辑器 CM scroller、doc 解析预览、排队面板泳道等都曾漏登记，2026-09-08 已全量补齐）。
- 默认最终角色由生成脚本、`test/theme.mjs` 与 `test/resolved-appearance.mjs` 守门；改 resolver 或种子后重新生成两端默认 CSS。启动前主进程窗口仍使用共享主题框种子初始化，渲染加载后以当前 resolved scope 校正。
- **原生材质的平台边界**：启动缓存、snapshot 透明度或 renderer / fallback 截图通过，只证明角色与材质策略，不代表真实桌面材质已通过视觉验收。实际壁纸、活动态、系统按钮仍需单独桌面采证。Windows 11 22H2+ 用 Mica、macOS 用 Vibrancy（sidebar 毛玻璃），Linux 不自动映射材质，浏览器客户端始终实底。系统策略可改变原生材质的视觉表现；中右阅读卡、设置内容卡、输入、窄屏抽屉和独立内容画布保持既有不透明规则，框与设置导航背景透明。自定义主题在原生框上的文字对比度仍需实机检查。

### 5.1 浅色阅读规则（2026-09-29）

内置浅色以实际阅读表面校准前景；聊天与 Markdown 的 15px 正文、400/500 字重及白底保持。时间/分组与操作名称分别使用三级灰字与 ink-soft，侧栏磁贴、工作区胶囊的三态材质不变。

| 范围 | 当前规则 |
|---|---|
| 二、三级文字 | text-2 #55534f / text-3 #64625d；三级文字在框底也达到普通文字 4.5:1 下限 |
| 设置说明 | ui 字阶（标准 13px）、text-2、1.6 行高 |
| 看板操作/验收摘要 | caption（标准 12px）、text-2；延期摘要不再整行降低透明度 |
| 状态文字 | 浅色绿 #18704f、黄 #795800、红 #b52e47、蓝 #2464a4、紫 #6843ba；在 raised 底的 12% 同色徽标上校验至少 4.5:1 |
| 记忆总览 | 图保持 1:1 最小尺寸，caption 说明不随面板缩到 8px；窄面板可滚动，宽屏上限 1400px |
| 已丢弃记忆 | 二级文字配状态标记，长正文默认三行、可展开；撤销保持正常可读 |
| 字体与控件 | 默认 OPPO Sans；button/input/select/textarea 继承字体族，显式等宽区域继续覆盖；扩展字体、字阶和主题随宿主同步 |

此前 review 采集实例的本机配置保存为 MiSans，不能将该实例值说成产品默认值。这轮使用仅内存的 OPPO Sans/标准档复核，没有回写个人字体配置。CDP 确认设置说明与导航中文实际由 OPPO Sans 绘制；也修复了原生控件默认 Arial 导致中文落系统回退字体的问题。

实机样本在本地 .tmp/ui-captures/light-fix-oppo-final/，包含浅色设置、侧栏、看板、记忆、工作日报与深色回归；采集结束恢复原工作区主题。对比度按浏览器计算样式与叠色计算，针对性守卫覆盖 620/1100/2800px 脑图容器，不代表全部自定义主题/缩放环境通过无障碍认证。

## 6. 测试

- `test/unit/terminal-scan-appearance.spec.tsx`：扫描截图合成使用实际 appearance 遮罩，外观变更触发重画，并检查卸载订阅清理；命中与键盘链仍依赖原扫描测试。
- `test/unit/browser-picker-appearance.spec.tsx`：执行真实拾取脚本，核对 tip / box DOM 消费传入外观与取消清理。
- `test/unit/theme-pane-opacity-policy.spec.tsx`：色盘不透明策略与实时预览同时保留完整主题、最小启动外观两份已保存缓存。
- `test/resolved-appearance.mjs`：深浅 × 八工作区色的单次材质、各面/选区/状态配对、身份稳定与 CM/xterm 同底；自定义低对比种子不回写。
- `test/appearance-sdk.mjs`：真实 SDK 的乱序 init/appearance、同 revision 字体变化、身份保留与字体清理。
- `test/unit/resolved-appearance.spec.tsx`：工作区色独立变化的同 revision 发布、订阅清理与未保存预览不写启动缓存。
- `test/unit/file-editor-roots.spec.tsx`：真实持久 EditorView 换色/深浅切换保持未保存内容与选择。

- `test/window-material.mjs`：Mica 平台/版本门槛、macOS Vibrancy 启用/失败复位/主题切换不重装、原生失败降级、每窗口状态、主题 `appearance`，以及 ThemeService/IPC 的统一同步路径。
- `test/unit/window-chrome.spec.tsx`：实际主题同步、桌面宿主确认（Mica 与 Vibrancy）、浏览器回退、过期响应与拒绝调用降级；原生视觉验收要求见 [frame-backdrop.md](frame-backdrop.md)。
- `test/unit/sessions-float-surface.spec.tsx`：透明框下速览侧栏覆盖关闭时序、快速重开、工作区切换隐藏与草稿保留。
- `test/light-readability-visual.mjs`：真实 Chromium 样式的文字/状态对比度、设置和看板字阶、已丢弃撤销可读性、SVG 最小尺寸、原生控件字体继承。
- `test/unit/terminal-dim-contrast.spec.tsx`：浅色 DIM、ANSI、truecolor 与显式背景配对，普通 ANSI 不改，模式切换恢复原样式、清理离开 DOM 的节点及 render 订阅；真实绘制与可读性另用生产 Electron 采集验证。
- `test/unit/extension-appearance.spec.tsx` + `test/extension-appearance-visual.mjs`：宿主初始化/热切换消息与订阅清理、实际 iframe 中 SDK 应用、OPPO 字体注册及可选字体清理。

- `test/theme.mjs`（进 `npm test`）：parseTheme 校验/回填/报错面、色值正则（含阴影多段）、formatThemeJson 格式化与键序稳定、slugify 冲突、ThemeService CRUD（复制深色、保存生效、内置保护、删除级联清理引用、坏文件跳过、getActive 三级回退）、工作区独立主题（覆盖解析/指定工作区/followGlobal/悬空覆盖/payload 字段）、parseCssColor/formatCssColor round-trip、THEME_UI_GROUPS 覆盖完整性、themesHost 六工具全流程（含 scope=workspace/followGlobal/内置保护/非法值/广播）。
- `test/unit/theme-pane-hover-delete.spec.tsx`：设置页主题列表行内删除——内置 dark/light 无删除按钮、自定义 hover 入口不先切换即可打开弹窗/确认删除、删当前生效主题走回落文案、显隐过渡只用 `--dur-micro`/`--ease-hover`。
- `test/unit/theme-pane-frame-fx.spec.tsx`：外观页仍能显示主题列表，且不显示旧灯带、渐变、毛玻璃和壁纸入口；`test/frame-fx-workspace-accent-config.mjs` 守旧配置归一化与落盘；`test/glass-surfaces-css.mjs` 守实底。
- `test/unit/font-settings.spec.tsx`：字体族/字号切换写 `config.update` + `:root` 内联变量、预览样本跟随、默认档 removeProperty 回落。
- `test/ui-font.mjs`：appearanceFonts 解析坏值回落、三栈映射、三档字阶数值（standard 与 base.css 真对照）、渲染层 CSS 字重禁 600、字体 CSS 按需注入（index.html 禁静态外链 + uiFont.ts URL/接线）与 main.tsx/config.ts/save 落盘/TerminalView 接线守卫。
- `test/ui-font-config.mjs`：`AppConfig.uiFont`/`uiFontScale` 归一化缺省、save 落盘不丢（回归：payload 漏字段静默丢弃）、重启存活。
- `test/unit/global-board-panel-glow.spec.tsx`：看板需要你探出停稳仍渲染面板且不挂旧灯带节点（展开态由 `test/board-glow-sheen-css.mjs` 源级守卫覆盖）。
- `test/global-panel-glow-config.mjs`：`AppConfig.globalPanelGlow` 归一化缺省开、落盘不丢、重启存活。
- `test/theme-ui-verify.mjs`（手动，需 `--remote-debugging-port=9222` 的运行中应用）：CDP 全链路——默认深色、切浅色变量/data-theme/color-scheme 即时变化、新建落盘格式化、保存当前主题界面自动刷新、非法色值拦截、设置面板渲染与新建→编辑→保存交互。

## 设计初衷（2026-10-26 与用户定稿）

> 依据 campaign-intent-drafts/D10-D14.md 草案定稿（用户 2026-10-26「不抽查直接定稿」）；歧义点处置：22 项卡片决策＋长尾按草案推荐，明细见专项账本「意图定稿决策」节。

- 为谁/什么场景：只管颜色的主题系统（灰阶海拔/文字/状态/语法/ANSI）+ 色盘编辑 + 工作区独立主题 + Agent themes.* 六工具；字体/头像即时生效走独立通道。
- 为什么这样设计：种子→resolver 单一来源算最终角色（每面配对前景/交互/状态/焦点，对比度不足局部校准不全局提亮、低对比种子不回写 JSON）；revision 单调发布同版本传播（CM compartment/xterm/SDK 忽略过期消息）；启动缓存分层（完整主题+最小 boot 五角色）；色盘预览不写缓存；删除自定义主题级联清理引用。
- 明确不做：圆角/字阶等结构 token 不在主题范围；主题目录不做文件监听（面板外改 JSON 需重选或重启）；工作区悬空覆盖残留不清理（无害，与 mcpByWorkspace 同口径）。
- 歧义点：无真决策（浅色终端放弃 WebGL 换 dim 对比度修正是已声明取舍，吞吐基准未做——若 review 判性能风险可提 P3 候选，不构成意图歧义）。
