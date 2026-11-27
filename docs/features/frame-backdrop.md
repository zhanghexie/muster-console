# 原生框 Mica/Vibrancy 与干净主题色

Windows 11 22H2（build 22621）及以上的桌面主窗口默认启用 Electron 原生 Mica；macOS 桌面主窗口默认启用原生 Vibrancy（`setVibrancy('sidebar')`，原生侧栏毛玻璃材质）。整圈框背景——左侧会话栏、顶栏、原生窗口按钮区、底部 `--frame-gap`（默认 4px）边缘、布局留白，以及设置导航背景——共用同一层原生材质。关闭主题色时直接呈现原生材质，不铺框色薄层；启用主题色时，仅在 `.app-shell` 叠一次 28% 纯工作区强调色。材质深浅跟随实际主题 `appearance`，不随顶栏文字明暗判断切换，也不新增材质设置。正式界面不加载噪点或颗粒贴图。

中右阅读卡、设置内容卡、调度浮层、输入壳与窄屏抽屉继续保持不透明；主题色启用时只保留均匀混色和中性边缘高光，关闭时恢复主题原有实色。不增加 CSS 实时模糊或滚动采样。浏览器客户端、Linux、旧版 Windows，以及原生调用失败的窗口回退均匀实色框，主题色开关仍控制混色，所有表面同样不铺噪点贴图。macOS 备选材质 `under-window`（更暗更平、接近 Mica 沉稳感）未采用，切换只需改 `windowMaterial.ts` 的 `MAC_VIBRANCY` 常量。

主窗口创建时将实际启用了 `titleBarOverlay` 的状态交给 `windowMaterial.ts`。Windows 同步 overlay 按钮配色，macOS 走系统红绿灯，Linux X11 和 Wayland 都使用原生标题栏。Linux 的 BrowserWindow 仍可能暴露 `setTitleBarOverlay` 方法，因此初始化和主题更新均按窗口配置决定是否调用。

`src/shared/resolvedAppearance.ts` 统一解析主题与工作区色，发布实色与原生覆盖层两个不同角色：`--workspace-frame-color` / `--surface-frame` 是工作区色以 28% 和主题 `bg-frame` 在 oklab 中混成的实色；`--workspace-native-tint` 是纯工作区色的 28% alpha 覆盖层，主题色关闭时为 `transparent`。原生框只取后者，不能把混入 `bg-frame` 的实色再次盖到 Mica 上。canvas 以 12% 实色框色与 `bg-panel` 合成；深浅色 input 与 canvas 一样混合 12%，raised 和 overlay 混合 8%。chrome 为 canvas + 4% ink，选中页签为 canvas + 11% ink。CSS 只消费最终颜色，终端、CM 与普通内容使用同一个不透明 canvas，避免重复染色或透出第二套文字。材质不新增配置字段。

## 关键路径

- `src/renderer/src/RootLayout.tsx` / `useWorkspaceAppearance.ts`：桌面与移动分支共用 scope hook，经 `workspaceAccentEnabled(id)` 与 `workspaceAccent(id)` 解析覆盖/全局默认，在 layoutEffect 中调用 `setWorkspaceAppearance({workspaceId,accent,enabled})`，paint 前发布一致的最终颜色。`src/renderer/src/theme.ts` 管理唯一 revision、root CSS 与 `data-workspace-material="frosted|solid"`，同时通知 CM、xterm、扩展并同步原生窗口。`frosted` 仅是均匀材质混合的内部状态名。旧 `useWorkspaceMaterial` 保留为独立调用/测试入口，也只设置 resolver 开关；正式 App 不再分别染框或调用 `useFrameBackdropChrome`。入口范围和持久化见 [theme-system.md](theme-system.md)。
- `src/main/windowMaterial.ts`、`src/main/index.ts`：创建主窗口后、加载渲染页面前经 `nativeMaterialFor(platform, release)` 分流——win32 build ≥ 22621 初始化 `setBackgroundMaterial('mica')`，darwin 初始化 `setVibrancy('sidebar')`（`MAC_VIBRANCY` 常量），其余实色——以每窗口状态记录实际成功的材质；原生材质窗口保持透明 Chromium 底，36px `titleBarOverlay` 的普通态背景同样透明（该 API 仅 win32/linux 存在，mac 天然跳过），符号色沿用现有规则，悬停反馈由原生控件提供。降级窗口与按钮区使用当前实色框色。`applyWindowChrome` 统一同步 `nativeTheme.themeSource`、窗口底与控制区；原生同步失败会告警并回退实色（Mica 复位 `none`、Vibrancy 复位 `null`）。
- `src/main/themes.ts`、`src/main/ipc/app.ts`、`src/preload/index.ts`：主题服务与 `app:setChromeTheme` 共用上述窗口同步路径，避免主题切换重新铺上实色窗口底。IPC 接收 `{ panel, ink, appearance? }` 并返回 `{ ok, material?: 'mica' | 'vibrancy' | 'solid' }`；省略 appearance 时主进程使用实际生效主题。
- `src/shared/resolvedAppearance.ts`、`src/renderer/src/theme.ts`、`src/renderer/src/windowChrome.ts`：主题与 scope 统一得到 nativeChrome 实色回退框/配对前景/appearance，并经 `syncWindowChrome` 同步。桌面主进程确认后 html 才设 `data-native-material="mica"`（Windows）或 `'vibrancy'`（macOS）；失败、浏览器或旧响应保持 `solid`，过期响应不覆盖新状态。框容器消费 `frame-fg-*`，选中状态消费 `frame-fg-selected-*`；浅色不会再由独立 CSS 分支重写另一套文字种子。
- `src/renderer/src/styles/material.css`：材质 aliases 只指向 `--surface-canvas/input`，不进行第二次 color-mix；`--material-rim` 是 resolver 发布的 6% ink 装饰边缘。输入垫底与阅读面同色，没有噪点或背景贴图。原生材质模式（`html:is([data-native-material='mica'], [data-native-material='vibrancy'])`）清空 html/body/#root 的底，`.app-shell` 只画 `--workspace-native-tint`；顶栏、主工作框、设置框、折叠框和切换骨架的框区透明，宽屏 Git 框同样透明。调宽不降低整页 opacity；设置挂载时仅给 `.app-shell.has-settings-page` 的两个直接子级 `.chrome-bar`、`.main-view` 设置 `opacity:0`、`pointer-events:none` 与 `transition:none`，父层合成使显式可见后代也不能透出，不展开后代隐藏规则。禁止以 `.app-shell:has(> .settings-page)` 推导该状态：设置内容的 DOM 变动会经祖先关系选择器使整棵工作台重新计算样式。`styles.css` 最后导入本文件，旧 backdrop.css 不进入正式包。
- `src/renderer/src/components/settings/SettingsModal.tsx`：设置页挂载后的 layout effect 仅给实际直接父级 `.app-shell` 加 `has-settings-page`，卸载时清理；原生材质下还保存两个直接兄弟 `.chrome-bar`、`.main-view` 的原始 inert 属性并启用 inert，阻止不可见底层接收键盘、焦点和辅助技术访问，卸载或实底回退时恢复原值。仅监听 html 的材质属性以处理晚到确认。沿用既有 presence 保留到退场结束，关闭动作本身不提前露出工作台。设置页内容切换、异步加载和 DOM 更新不反复切换父级 class；独立组件测试或其他挂载容器不修改无关根节点。该接线不改变设置布局、草稿保活或动画 token。
- `src/renderer/src/components/SessionsFloatSurface.tsx`：折叠速览下层侧栏继续常驻，借 `usePresence` 在覆盖关闭动画结束后移除 `is-retained`；Mica CSS 隐藏未保留或工作区切换中隐藏的侧栏及所有后代，防止透明工作框下透出重影，同时保留草稿和组件状态。
- `src/renderer/src/assets/frosted-grain.png`：历史模拟材质资产暂留源码，正式样式不引用、不加载，生产渲染包不使用；不再作为窗口或内容面贴图。
- `src/renderer/src/styles/left.css`：会话状态胶囊消费实际 frame 的 `frame-status-neutral-*`，窄屏重置为 canvas 的对应角色；轻底在 resolver 中按背景 + 6% ink 生成，文字按该底色校准，不局部叠色。退出态不整体降低 opacity。用户与 Worker 头像用稳定 identity 角色，状态另附。
- `src/shared/frameBackdrop.ts`、`src/main/config.ts`、`src/main/frameBackdropFiles.ts`：保留旧模板配置的解析、读写和已有壁纸文件，避免升级时丢失个人数据。旧配置当前不决定渲染结果。

## 旧效果的状态

外观设置和命令面板不再提供旧渐变、几何模板、壁纸、实时毛玻璃与灯带入口。启动过程不初始化 `frameBackdrop` / `frameFx` / `panelGlow`；`FrameBackdrop` 和选择器不挂到主窗口或设置页；旧背景 CSS 不进入应用样式包。相应配置结构、文件管理和独立组件代码暂留作数据兼容，不主动清理用户的壁纸文件。均匀主题色混合跟随已有主题色启用状态；原生 Mica 由桌面平台能力决定，两者均与这些旧效果配置无关。

## 范围与边界

- 工作区列表中正在对话的条目（`is-chatting`，对应调度对话面板已打开）在背景层使用 1px 内描边，颜色复用会话输入框聚焦的 `--input-focus-border`；悬停时保持描边，关闭对话后移除，不改变条目尺寸。当前激活工作区本身不触发描边。

- 会话阅读卡、右侧工具页和设置内容页通过 `--elevation-sheet: none` 移除外投影，保留页面圆角、`contain: layout paint` 和整圈 1px 内描边。这些阅读页在根节点按 [虚拟屏的窗框规则](virtual-screen.md) 共用 `--radius-page` 与 `--corner-shape-page`，描边继承页面轮廓。独立 `::after` 在内容上方通过 `--surface-rim`（inset）绘制纸边，`pointer-events: none`，满铺的终端、编辑器和内容根不会覆盖纸边。描边属于卡片内部，不计入 `--frame-gap` 净间距。窄屏右抽屉不绘制该纸边。旧主题的 shadow token 继续保留兼容，但页面不再消费它作为外投影。普通实色与原生材质模式共用此规则。
- `.ws-stage` 仍通过 `inset: 0 0 var(--frame-gap)` 缩短高度，底部保持 4px，留白直接露出共同框底。静态工作面以 `overflow: clip` + `overflow-clip-margin: var(--frame-gap)` 保留既有绘制边界；`.main-view` 与 `.work-area` 保留横向 `clip`、纵向 `visible`，`.workspace-page` / `.h-page` 不再截断卡片外投影。工作区胶片切换期间 `.ws-stage.is-sliding` 将 clip margin 归零，并保留 transit pane 的原有裁切，防下一格内容漏入底部留白；切换结束恢复 clip margin。该调整不改变卡片几何、分割条高度、命中宽度或虚拟屏比例。
- `test/frame-gap-visual.mjs` 使用运行时 `resolveAppearance` 与生产 CSS，覆盖深浅、主题色、原生透明背景、虚拟屏左右页/关闭/并排、侧栏展开与收起时的左右阅读页圆角及窄屏共 25 组。断言外缘/底边默认 4px、中央默认 4px 的净间距、整圈内描边、页面无外投影、圆角、分割命中与横向不可滚动。原生材质夹具在保留描边的 PNG 中检查中央、右边和底边的透明像素，同时确认相邻描边仍在不透明卡片内部；不以背景 RGB 推断间距，因为原生材质各处颜色可能不同。非整数设备缩放可能产生半像素抗锯齿，CSS 几何与物理像素覆盖需分别核对。Chromium 截图与透明 alpha 验证不代替原生 Mica/Vibrancy 桌面合成验收。

- 所有平台统一使用半透明左栏条目：实用工具、会话选中条与工作区条目的普通/选中/悬停底色分别保留 65%/72%/78% 不透明度；工作区条目的框色垫底保留 45%。会话与工作区状态胶囊底色保留 65%，工作区状态胶囊悬停沿用 78%；会话胶囊使用单层背景，避免重复叠色。仅背景透明，文字与图标不降低 opacity。折叠工作区时隐藏后排真实内容并设 aria-hidden/inert，只用行伪元素画底边堆叠，不透出后排文字或状态；展开恢复真实内容与交互，沿用现有折叠几何和动画 token。实际观感由用户验收。

- 宿主终端默认底、代码编辑器、diff、看板与扩展默认内容面共用 resolved canvas；终端显式 TUI/ANSI 单元格背景、原生浏览器网页正文、媒体图片和 emoji 保留原内容，不以滤镜或截图重染。
- macOS 顶栏 `hiddenInset` 红绿灯让位（chrome.css `.is-mac .chrome-bar` 84px）随原生全屏收回：主窗口 `enter/leave-full-screen` 与 `did-finish-load` 推 `window:fullscreen` 事件（ipcEvents 白名单，webAccess relay 自动转发），渲染层 `macChrome.ts` 切 `is-native-fullscreen` 收回让位；全屏时悬停顶部由系统层叠加菜单栏，不占应用栏。`test/unit/mac-chrome.spec.tsx` 与 `test/mac-chrome.mjs` 守卫。
- Mica 模式的应用顶栏、原生窗口控制区与全部框留白共用同一原生背景和单次工作区叠色；回退模式保持均匀框色同步。所有正式表面均无噪点贴图。现有虚拟屏调宽快照的模糊反馈独立保留，不属于背景材质。
- 运行监视器、全局搜索、反馈审核、全局看板、调度单窗与并排对话、大图查看器共用 `.backdrop-blur-overlay.mp-scrim` 磨砂遮罩。模糊强度由宿主结构 token `--backdrop-blur` 提供。macOS Vibrancy 窗口在遮罩在场期间给 `body` 设置 `will-change: opacity`，让背景滤镜在 Chromium 内容内部采样，避免原生透明窗框区域残留旧面板帧。边界包含挂到应用根外的弹层。层内的 `body::before` 用当前框色生成深色衬底，稳定展开时给透明区域提供不透明的滤镜底色。最后一层遮罩关闭时，衬底与其同步淡出，露出原生 Vibrancy。
- 支持系统仍可按系统策略改变 Mica/Vibrancy 表现；能力确认不保证所有壁纸、活动状态和系统设置下观感相同。macOS Vibrancy 默认 `followWindow`：窗口非活动时系统按原生惯例退为暗淡材质，不强行常亮。resolver 配对的是实色 fallback，实际 DWM/NSVisualEffectView 框仍需实机验收。主体种子拒绝透明，可读性修正不回写 JSON。xterm 普通前景有 4.5 保底；深色 WebGL 的 SGR dim 保留库自身减半门槛/0.5 alpha，不能等同普通文本保证。浅色用官方 DOM renderer 与公开 onRender 的 dim 前景修正，按实际背景配对至少 4.5，不改变程序背景；具体边界见 [theme-system.md](theme-system.md)。
- [历史模拟毛玻璃原型](../prototypes/frosted-glass-study/frosted-glass-study.html) 保留用于对比，其颗粒和烘焙 PNG 方案均不用于正式界面。
- [原生侧栏材质小样](../prototypes/native-material-demo/README.md) 保留最初独立 Electron 窗口，用于比较 Acrylic、Mica 和实色；正式工作台按用户确认后的整圈框 Mica 范围实施。小样的侧栏范围与实机证据不代替正式工作台验收。

## 验证

- `test/resolved-appearance.mjs` 与 `test/unit/resolved-appearance.spec.tsx` 验证单次 tint、不透明 surface、配对文字、身份稳定、同 revision 传播与预览不写缓存；`node scripts/generate-appearance-defaults.mjs --check` 守宿主/SDK 默认单源。

- `test/frame-backdrop.mjs` 验证旧数据解析、壁纸文件兼容，以及实色框与旧样式未挂载；额外守卫设置遮底必须使用显式 `has-settings-page`，仅透明隐藏两个直接父容器，禁止设置遮底规则展开后代通配符或写 visibility，防止祖先 `:has(settings-page)` 或后代继承隐藏引发整树样式失效。
- `test/unit/theme-pane-frame-fx.spec.tsx` 验证外观页无旧效果入口。
- `test/unit/frame-backdrop-picker.spec.tsx` 仅守旧组件和配置兼容，不代表产品入口仍在。
- `test/unit/workspace-material.spec.tsx` 验证材质开关、卸载清理与主题切换。
- `test/window-material.mjs` 验证 Windows 版本门槛、macOS Vibrancy 启用/失败复位/主题切换不重装、原生能力缺失/失败降级、每窗口状态、实际主题深浅，以及 ThemeService 和 IPC 使用统一同步路径（含 darwin 窗口经 IPC 回报 `vibrancy`）。
- `test/unit/window-chrome.spec.tsx` 验证宿主确认前保持实底、深浅主题同步、Mica 与 Vibrancy 确认、浏览器回退、过期响应忽略与拒绝调用降级。
- `test/workspace-material-css.mjs` 守卫 Mica 与 Vibrancy 共用透明窗框规则，并校验磨砂遮罩在 Vibrancy 下的采样边界。`test/e2e/panel-exit-layering.spec.ts` 用虚拟屏双页和右侧浏览器验证磨砂衬底与遮罩同步淡出。`test/e2e/window-material.spec.ts` 验证调度和大图查看器叠放时的磨砂及合成层释放。`test/e2e/scheduler-overview.spec.ts` 验证并排对话。macOS 使用正常速度的原生窗口录屏检查残影，冻结 CSS 过渡后的 Chromium 截图可能漏掉短暂的旧帧。
- `test/unit/sessions-float-surface.spec.tsx` 验证侧栏在关闭覆盖动画期间保留、结束后停止绘制、快速重开取消隐藏、工作区切换隐藏及草稿状态保留。
- `test/workspace-material-css.mjs` 守实际 App 接线、无渐变/实时滤镜/噪点贴图、输入垫底一致，以及不透明内容面与胶囊规则。
- `test/workspace-material-visual.mjs` 在 Chromium 使用生产 CSS 验证内置深浅 × 八色/禁用 × 框/抽屉共 36 组：文字对比度至少 4.5:1、退色态不降整体透明度、底色跟随实际所在面。`--baseline` 负向控制恢复旧退色规则后必须失败。
- 历史模拟材质的真实构建 Electron 深浅、紫色、禁用、文件页、调度输入区、状态展开和 780/390 布局曾截图查看；本地证据在 `.tmp/ui-captures/workspace-material/`。该批次使用独立临时沙盒、in-process GPU 与 1 倍缩放；OPPO 字体加载失败时使用回退字体，未测帧率/显存，不代表本轮 Mica、去噪点规则或安装版已验收。
- `test/window-material-visual.mjs` 为生产 CSS 的透明 PNG 验证入口：整圈框在主题色关闭时 alpha 为 0，开启时只有单次 28% 纯工作区色；阅读卡、输入与抽屉保持不透明，全部背景图为 none 且无旧噪点请求。设置夹具在根上同步显式 class，检查两个父容器即时透明、显式可见后代不被逐项改写但有效 opacity 为 0，保留透出位置的像素检查；动态插入后代仍被父层合成包含，移除设置页与 class 后恢复、重开再次隐藏。该夹具只验证 CSS，实际 inert 所有权、退出生命周期和焦点由 `settings-material-presence` 组件测试与 Electron 导航测试覆盖。2026-10-08 最终去噪点版本 78 组通过，覆盖深浅、虚拟屏比例与留白、调宽、折叠速览和设置导航；重复叠色与漏叠色两种负向控制均按预期失败。该入口只验证 Chromium 表面，不能证明 DWM 启用了 Mica。
- `test/e2e/window-material.spec.ts` 为真实构建 Electron 的验证入口：通过正式主题/布局 API 和实际鼠标拖拽检查整圈框、深浅、主题色开关、折叠速览、设置导航与窄屏内容面。`desktopCapturer` 捕获桌面合成后的窗口并检查文字/图标边缘，不能用仅含 Chromium 内容的截图替代。2026-10-08 本机 Windows 11 build 26200 / Electron 43.7.0 最终构建通过（17.8 秒），零 pageErrors；顶栏、原生按钮区、底边与侧栏采样证明单层纯色叠加，并实际查看深浅、设置与窄屏截图。最终证据在 `.tmp/window-material/captures/mica-{dark,light}-{raw,purple}.png` 及同目录布局截图、`observations.json`；旧侧栏限定版截图只作历史对照。本机 `in-process-gpu` 会只合成 Mica 底色，验收沿用正式应用的正常 GPU 模式。构建与三套类型检查通过，未验安装版或其他平台原生观感。
- 同文件的 Windows 圆角用例在独立实例里切换普通窗口与最大化，检查中栏、会话行和工作区行的 8px 超椭圆。深浅截图按测试窗口 ID 采集到 `.tmp/window-material/captures/mica-corners-*.png`，用于检查真实应用内容与窗口状态。整屏的 Mica 叠色继续由上面的材质用例验收。
- macOS Vibrancy 2026-10-09 在本机（darwin 25.4 / Electron 43.7.0 / dev 沙盒真实主窗口）实机验收：主进程日志 `Vibrancy (sidebar) enabled`；桌面合成窗口截图中左栏/顶栏呈毛玻璃透出壁纸蓝紫（深色左栏均值 76,73,105 / std≈25-32，浅色 199,197,234），阅读卡不透明、文字清晰、无黑块重影（中央疑似重影放大核实为工作区卡片正常分层）。材质选型依据同屏四窗对照：`sidebar` 透出壁纸细节（std≈17），`under-window` 更暗更平（std≈7），`hud` 明显更亮，实色 std=0。证据 `.tmp/vibrancy-probe/`（devapp-dark/light.png、two-window-a.png、探针日志）。同窗口重复 `setVibrancy` 切换材质可能不重排（首探针 under-window 截图与 sidebar 逐字节相同），同屏双窗对照可避开该假象。

## 设计初衷（2026-10-26 与用户定稿）

> 依据 campaign-intent-drafts/D10-D14.md 草案定稿（用户 2026-10-26「不抽查直接定稿」）；歧义点处置：22 项卡片决策＋长尾按草案推荐，明细见专项账本「意图定稿决策」节。

- 为谁/什么场景：原生框材质分层——Win11 22H2（22621）+ Mica、macOS Vibrancy（sidebar 毛玻璃）、Linux/浏览器/原生失败回退均匀实色；主题色开启时整圈框只叠一次 28% 纯工作区色。
- 为什么这样设计：resolver 发布实色 frame 与 native tint 两个角色（原生框只取后者，防混色二次覆盖）；启动加载页面前初始化材质；宿主确认才设 data-native-material（失败/浏览器/过期响应保持实底）；设置页遮底只动两个直接兄弟容器+inert（弃根级 :has 防整树样式失效）；旧渐变/壁纸/毛玻璃/灯带退役但配置文件与壁纸数据保留不清理。
- 明确不做：不新增材质设置字段；不承诺系统策略/壁纸下观感一致；macOS under-window 备选不采用（常量可切）；噪点/颗粒贴图全面不用。
- 歧义点：无真决策（平台差异已按三平台逐条声明并有 Mica/Vibrancy 真机证据；Linux 实底为明示边界，归 X6 横切收账）。
