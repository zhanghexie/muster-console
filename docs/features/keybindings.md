# 快捷键系统

> 状态：实现说明 v1（2026-08-25）  
> 代码主入口：`src/shared/keybindings.ts`（目录/解析/搜索）、`src/renderer/src/keybindings/KeybindingHost.tsx`（分发）、`src/renderer/src/components/settings/KeybindingsPane.tsx`（设置页）

## 功能职责

集中式、可自定义的键盘快捷键：

- **设置 → 快捷键**：列出目录里每一条可绑动作（含未改过的默认项），即时改绑/解绑/恢复默认。
- **双线查找**：搜索框按动作名/分组找绑定；「按下查找」捕获和弦反查动作。
- **弹出层**：`overlay.close`（默认 Esc）只关 overlay 栈最顶一层。
- **实用功能**四项（定时任务 / 使用统计 / 记忆整理 / 扩展管理）默认有绑定，左栏行右侧显示当前键。
- **左右历史按钮**的悬浮提示通过 `useChordLabel` 显示当前绑定，并显示左侧可后退/前进或右侧可撤销/重做的步数。`useChordLabel` / `KeyChordHint` 尊重显式解绑 `null`：有 Provider 时不回退默认键，只有未挂载 Provider 的独立调用使用目录默认值。

用户覆盖存本机 `AppConfig.keybindings`（`actionId → 序列化和弦 | null`），不进工作区。设置表单「保存」不回写该字段（与 `themeId` 相同）。

设置页沿用统一 1120px 平铺模板，系统快捷操作与工作台快捷键分段。系统操作名称和组合键使用带标签的字段，窄布局改为纵排；动作搜索、按下查找、冲突提示与录制行为保持。

## 系统快捷操作

设置 → 快捷键顶部可新增、编辑、删除最多 20 项系统快捷操作，名称最多 40 字。
组合键使用与工作台快捷键相同的按键按钮：点击后直接按下组合键，纯修饰键继续等待，Esc 取消并保留原值；不再手填文本。行内按键直接进入编辑与录入，铅笔只编辑名称/当前组合键，表单保留显式保存。录入时暂停应用快捷键，失焦、切页、取消或卸载后释放捕获；不发送按键到目标工具。系统保留键可能被 OS 接管、无法传给页面，需取消后改用可捕获的组合键。录入校验仍使用跨平台共享白名单，按 Win/Cmd/Super、Alt/Option 显示，macOS/Linux 的执行依赖与限制不变。
行布局复用下方动作的 `kb-row`/`kb-row-main`/`kb-row-title`/`kb-chord`/`kb-icon-btn`，按键、编辑图标、删除按钮列对齐。
保存即写入本机 `AppConfig.systemShortcuts`；设置总表单不回写此字段。GUI 会话和 CLI 悬浮输入区的加号菜单每次打开读取最新配置，显示名称和按键；截图等操作完成后可粘贴生成的图片作为附件。

入口：`SystemShortcutsSettings.tsx` 管理配置；`useSystemShortcuts.ts` 加载菜单与操作状态；
`src/shared/systemShortcuts.ts` 校验并转换键码、按平台显示 Win/Cmd/Super；`src/main/systemShortcuts.ts` 执行系统发送，`src/main/systemShortcutCommand.ts` 集中生成 macOS/Linux 的白名单命令参数。
点击菜单项先收起菜单，等待现有动画 token 对应时间，再通过 `app:runSystemShortcut(id)` 发送。
主进程只允许桌面主窗口调用，按已保存 ID 查找组合键；不接受渲染层传入命令或任意脚本。
发送中阻止重复点击，错误保留在工具栏；快捷键校验、各平台依赖/权限建议与默认失败提示按当前界面语言生成，系统或工具返回的原始错误细节保留。支持字母、数字、功能键和常用导航键；普通键须带修饰键。平台分支：

| 平台 | 发送方式 | 权限、依赖与边界 |
|---|---|---|
| Windows | 隐藏 PowerShell → SendInput；按下后逆序释放，校验发送数量 | 修饰键尚未松开时拒绝发送；高权限目标可能受系统限制；支持 F1–F24、PrintScreen |
| macOS | `/usr/bin/osascript` → System Events 的 keystroke/key code | 需辅助功能与自动化（System Events）授权；Command/Option 独立于 Ctrl/Shift；支持 F1–F20，PrintScreen/F21–F24 显式报不支持，可改用 Cmd+Shift+3/4/5 |
| Linux X11 | `xdotool key --clearmodifiers` | 需安装 xdotool 并访问当前 DISPLAY |
| Linux Wayland | `ydotool key`，evdev 按下与逆序释放 | 优先于 DISPLAY 检测（避免误走 XWayland）；需 ydotool 1.x、ydotoold、/dev/uinput 和 socket 权限；按 US 物理键位映射，自定义布局需对应调整 |

所有命令通过 execFile 独立参数执行，不经过 shell；缺依赖、权限或图形会话时给出具体提示，不自动安装工具、不自动提权、不静默切换后端。目标工具需自行启用相同的全局快捷键，发送成功不证明截图/录屏完成。

测试：`test/system-shortcuts.mjs`（各平台命令参数、非法输入、失败与重入）、`test/unit/node-main/send-i18n.spec.ts`（各平台提示与命令参数）、`test/unit/system-shortcuts.spec.tsx`（设置和菜单）、`test/e2e/system-shortcuts.spec.ts`（真实 Electron IPC → 系统全局回调；macOS 用 F20，其他平台 F24）。此前 Windows 真机通过；本次提示翻译只做参数和模拟测试，macOS/Linux 仍须在目标平台授权/安装依赖后运行该 E2E 验证。

实现依据：[Apple UI 自动化权限](https://developer.apple.com/library/archive/documentation/LanguagesUtilities/Conceptual/MacAutomationScriptingGuide/AutomatetheUserInterface.html)、[xdotool](https://github.com/jordansissel/xdotool)、[ydotool 按键与守护进程](https://github.com/ReimuNotMoe/ydotool)。

## 关键文件与入口

| 文件 | 职责 |
|------|------|
| `src/shared/keybindings.ts` | 和弦解析/格式化、动作目录、覆盖归一、冲突、双向搜索 |
| `src/main/config.ts` | `normalizeKeybindingOverrides` 写入/读出 |
| `src/renderer/src/keybindings/overlayStack.ts` | 弹出层 LIFO |
| `src/renderer/src/keybindings/KeybindingHost.tsx` | Provider + 单一 capture `keydown` 分发 + `useKeybinding` / `useOverlayDismiss` / `KeyChordHint` |
| `src/renderer/src/hooks/useAppKeybindings.ts` | 桌面壳全局动作注册，集中维护 App 状态回调与快捷键目录的绑定边界 |
| `src/renderer/src/components/settings/KeybindingsPane.tsx` | 设置页：搜动作 / 按下反查 / 录制 |
| `src/renderer/src/panels/LeftPanel.tsx` | 实用功能开关 + 行右侧 hint + 新建任务 |

## 默认绑定

| 动作 | 默认 | when |
|------|------|------|
| 关闭当前弹出层 | `Esc` | always（仅栈非空时消费） |
| 打开设置 | `Ctrl+,` | always |
| 打开命令面板 | `Ctrl+Shift+P` | always（终端里也开，焦点进面板） |
| 跳转会话或工作区 | `Ctrl+P` | notTyping |
| 退出终端焦点 | `Ctrl+Shift+F8` | always（把焦点从 xterm 挪走，之后应用快捷键可用；点终端可再激活） |
| 实用功能：定时任务 / 使用统计 / 记忆整理 / 扩展管理 | `Ctrl+Shift+T/U/M/X` | notTyping |
| 开关全局看板 | `Ctrl+Shift+G` | notTyping（中键仍可用） |
| 开关运行监视器 | `Ctrl+Shift+R` | notTyping（顶栏按钮同源） |
| 新建任务 | `Ctrl+Shift+N` | notTyping |
| 分屏显示当前面板 | `Ctrl+\` | notTyping（见 [中央区分屏](center-split.md)；原虚拟屏切页让位改 `Ctrl+Shift+\`） |
| 快速打开文件 / 当前文件查找 / 所有文件中搜索 / 会话内查找 | 无默认 / `Ctrl+F` / `Ctrl+Shift+F` / `Ctrl+F` | quickOpen=`notTyping`；find=`filesPanel`（Git/文件虚拟屏激活，或焦点在文件）；findInFiles=`always`（命令面板「内容」档）；chat.find=`chatFind`（工作页或焦点在会话，输入框不劫持） |
| 侧栏切到文件 / Git / 浏览器 | `F` / `G` / `B` | sideTools 且非输入 |
| 虚拟屏切 Git/终端 | `Ctrl+Shift+\` | notTyping（原 `Ctrl+\` 让位给分屏） |
| 左侧面板/分屏/虚拟屏后退 / 前进 | `Alt+←` / `Alt+→` | notTyping |
| 右侧面板撤销 / 重做（开关标签、同签换内容、网页导航） | `Ctrl+Alt+←` / `Ctrl+Alt+→` | sideTools 且非输入 |

系统剪贴/撤销不进可改表（继续 `app.edit`），避免抢终端 `Ctrl+C`。

## 数据流

```
AppConfig.keybindings ──► resolveBinding ──► KeybindingHost capture keydown
动作目录默认键 ────────┘                         │
                                                 ├ overlay.close → closeTopOverlay()
                                                 └ 其它 id → 已注册 handler
设置页改绑 ──► config.update({ keybindings }) 即时落盘（失败回滚 + 内联提示）
```

**落盘失败处理（2026-10-25，keybindings F-03）**：改绑/解绑/恢复默认三条路径的 `config.update` 失败时，Host 先回滚 overrides（UI 不显示未落盘的假绑定，避免重启回退无解释）再上抛；设置页 `KeybindingsPane` 用 `runPersist` 统一捕获，在工具栏下方渲染内联 `role="alert"` 提示「保存失败：{{message}}」（成功/新操作清除）。回归 `test/unit/keybindings-persist-failure.spec.tsx`。

`when`：

- `always`：输入框 / 终端里也放行（Esc、设置、退出终端焦点）。
- `notTyping`：INPUT/TEXTAREA/contenteditable/xterm 不抢。终端聚焦时应用快捷键被拦住——`Ctrl+Shift+F8`（`terminal.releaseFocus`）把焦点挪到 `.app-key-sink` 后即可用；再点终端恢复输入。
- `filesPanel` / `sideTools`：仅对应面板 `useKeybinding(..., enabled)` 为真时注册。`Ctrl+F` 默认跟虚拟屏当前页（`findSurface.ts`）：Git/文件页走 `files.find`，工作页走 `chat.find`；焦点在文件或会话面时盖过默认。
- `chatFind`：会话面可见时由 App 注册；输入框（查找条自身除外）与终端不抢。

录制/按下查找时 `recording=true`，Host 停手；Esc 取消录制，不关设置。

## 弹出层

组件 `useOverlayDismiss(open, onClose)` 入栈。已覆盖：设置、确认框、QuickOpen（分类万能搜，见 [command-palette.md](command-palette.md)）、新建任务、工作区创建、扩展 UI/详情/导入、全局看板、Git 分支与仓库快开/排序菜单、扫描与大爆炸 overlay、右键菜单、CustomSelect、顶栏沙箱菜单与扩展溢出菜单、**mermaid 图查看器**。

左栏/Git 嵌入搜索条、重命名框等控件内 Esc 仍由组件自己处理，不进栈。栈空时 `overlay.close` 不 `preventDefault`，让这些控件收到 Esc。会话/当前文件查找浮条（`FindFloatBar`）**入栈**：否则看板「需要你」探出条等已占栈时 Esc 被吃掉，输入失焦后更关不掉。

终端聚焦且没有弹层时，Esc 必须交给 TUI（用于 CLI 打断/取消）。xterm 有文本选区时同步清选区，不能吞掉第一次 Esc；其他终端的残留选区也不能通过全局监听消费按键或抢焦点。实现与回归见 [终端本地键盘输入](terminal-control.md#本地-tui-键盘输入)。

使用 presence 的常驻弹窗必须以 `presence.mounted && presence.stage !== 'out'` 注册 Esc。`usePresence(false)` 初始状态以及退场卸载后的状态都是 `mounted=false, stage='enter'`；只判断 `stage !== 'out'` 会把不可见弹窗永久放进栈，消费终端 Esc 却不产生可见响应。AppConfirmDialog、BoardReviewDialog、ConfirmDialog、CreateWorkspaceModal、EvidencePanel、ExtensionUiDialog 与 GitBranchPopover 共用此条件。`test/unit/overlay-presence-escape.spec.tsx` 覆盖这七个生产组件的初始关闭状态、普通/减少动态效果，以及关闭完成后重新打开的栈生命周期。

**点外判定（2026-09-16）**：portal 到 `document.body` 的浮层不在面板 `contains(target)` 里，不能按类名（`.sel-bar` 等）逐个豁免。合同在 `overlayStack.ts`：浮层根挂 `data-overlay-root`（或 `registerOverlayRoot`），点外关闭一律问 `isInsideOverlay(target)`。已挂根：划词浮条、爆炸遮罩、文件批注录入框、壳层/应用确认框。消费方：GlobalBoard、SelectionMenuHost 自身外点（**AgentFloat 调度面板 2026-09-18 起不再点外关闭**，只走头像/气泡「收起」）。新 portal 浮层只需挂属性，不必改各面板的 closest 清单。

## 已知边界

- 扩展侧栏条目（`ext:*`）无默认键，避免动态 id 进目录。
- 同一和弦绑多个动作时设置页标「冲突」，分发按目录顺序取第一个已注册且 `when` 成立的 handler。不同 `when` 且都不是 `always` 的共享和弦（如 `Ctrl+F` = 文件查找 / 会话查找）不算冲突。
- 终端内不抢 `Ctrl+字母`（无 Shift/Alt）；默认应用键都带 Shift 或为 `,` / Esc。终端聚焦时 `notTyping` 动作不触发，避免把键送给 CLI 的同时还开面板——用 `Ctrl+Shift+F8` 退出焦点后再按应用快捷键。

## 设计初衷（2026-10-26 与用户定稿）

> 依据 campaign-intent-drafts/D07.md 草案定稿（用户 2026-10-26「不抽查直接定稿」）；歧义点处置：22 项卡片决策＋长尾按草案推荐，明细见专项账本「意图定稿决策」节。

- 为谁/什么场景：集中式可自定义快捷键（覆盖存 AppConfig.keybindings 本机不进工作区）：设置页改绑/解绑/恢复、双线查找（搜动作名/按下反查）、系统快捷操作（≤20 项，跨平台注入按键）。
- 为什么这样设计：单一 capture keydown 分发+when 门（always/notTyping/filesPanel/sideTools/chatFind）防终端输入被抢；默认键全带 Shift 或 `,`/Esc（终端内不抢 Ctrl+字母）；overlay.close 只关栈顶、栈空不 preventDefault 让位控件自处理 Esc；系统快捷操作只接受桌面主窗口+按已存 ID 查找（不接受渲染层传命令），缺依赖/权限给具体提示、不静默切换后端。
- 明确不做：系统剪贴/撤销不进可改表（保终端 Ctrl+C）；扩展 ext:* 无默认键（动态 id 不进目录）；同和弦冲突按目录顺序取第一个 when 成立 handler（不同 when 共享不算冲突）；macOS/Linux 真机未实测（已声明，归 X6 横切）。
- 歧义点：无真决策（终端焦点让位 Ctrl+Shift+F8 是既定约定；平台分支边界已按跨平台规约逐台声明）。
