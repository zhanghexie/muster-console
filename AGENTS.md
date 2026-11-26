## 宿主开发约定

- 禁止直接读写工作区的 Muster 私有存储，包括历史 runtime.json、local/ 和私有记忆；不要直接修改旧 docs/journal 或 USER.md。
- 新增提示词或上下文注入点必须先登记到 src/main/agent/injection-registry.ts，设置页的「注入清单」会显示登记结果。
- 协议、规约和目录类长文应落盘，提示词只提供按需读取的路径。

宿主自愈类检查不得消耗模型回合；只有 Worker 自己能修的事才允许注入会话，持续宿主故障走诊断日志与编排事件。

## 跨平台开发（用户设定，必须遵守）

本项目是面向 **Windows、macOS、Linux** 的跨平台 Electron 桌面应用。当前开发机、终端或路径属于 Windows，不代表产品仅支持 Windows。

- 新增或修改系统集成（快捷键、进程、Shell、文件路径、权限、窗口、安装/更新等）前，检查三个平台的行为；共用接口，平台差异集中在适配层，禁止只实现当前开发机分支后当作完整交付。
- 优先使用已有跨平台能力。必须调用平台 API/命令时，为 Windows、macOS、Linux 提供对应实现；Linux 涉及桌面输入/窗口时区分 X11 与 Wayland。
- 权限、外部依赖或系统本身限制必须明确提示并给出可操作说明，不可静默失败或返回假成功；平台缺口必须在实现前说明，不能擅自缩减支持范围。
- 对各平台分支补参数、能力与错误路径测试；交付时分别说明“代码/模拟测试通过”和“该平台真机验证通过”。没有相应机器时明确未实测，不能把 Windows 测试当作跨平台验收。
- README、CLAUDE.md、功能文档与界面文案不得把本机开发环境写成产品平台定位；确实仅适用于某平台的特性应标明具体边界。

<!-- feature-docs:begin -->
## 功能实现文档（所有 Agent 通用）

要探索某功能的实现时，先查 `docs/features/`（含 `docs/README.md` 能力地图与索引）是否已有该功能的文档——有则**先读文档**再进代码，避免从零重推。
探索完成一个功能的实现后，若尚无对应文档，把结论沉淀为 `docs/features/<功能名>.md`（kebab-case 小写命名，如 `virtual-screen.md`）：功能职责、关键文件与入口、数据流/IPC 通道、交互与已知边界，写给下一个接手的人。`docs/` 分层存放：**调研专指对外部项目/工具/方案的调研**，沉淀进 `docs/research/`；本仓自身功能的现状盘点与根因分析写进对应 `docs/features/` 功能文档；内部代码审查、架构与性能审计写进 `docs/audits/`；改造/实施设计进 `docs/plans/`，计划状态与目录生命周期按 `docs/plans/README.md` 管理（完成且有实施证据才移入 `implemented/`，待验收或部分实施仍留在根目录，被取代或取消的进 `archive/`）。原型归 `docs/prototypes/`，批次执行规格按既有索引留在 `docs/compose/` 和 `docs/superpowers/`。各目录入口登记在 `docs/README.md`；journal 和 memory 是宿主管理数据；现行目录与迁移约定见 docs/features/memory-system.md，日志条目格式保持兼容。
之后这些功能的行为、结构或数据流发生代码改动时，**同步更新对应文档**（直接改过时描述，勿叠加补丁式备注）；新增功能文档必须同时登记进 `docs/README.md`（能力地图加链接 + features 表加行）。
能力域的动作或参数发生变更时（`X.run` 入口的 action 枚举、参数 schema、权限档或用法套路变化），**必须同步更新 `~/.muster` 全局技能根目录下对应域的 SKILL.md**（如 `~/.muster/skills/browser/SKILL.md`）——工具描述只指路，技能文档是模型读取的唯一用法真源，漂移即误导（对应 `docs/features/tool-discovery.md` 的工具面形态）。
<!-- feature-docs:end -->

## 下拉选择规约

业务 UI 必须复用 `CustomSelect`；公共组件采用 Modern Web Guidance 的可定制原生 picker，禁止未定制系统下拉或业务内另造弹层。运行时、回退和验收要求见 [design.md](design.md) 与 [menus-and-tooltips.md](docs/features/menus-and-tooltips.md)。

<!-- motion:begin -->
## 动画规约（所有 Agent 通用）

做任何带开合/切换/进出场的新 UI（面板、弹窗、菜单、页签、抽屉、手风琴……）**必须先读 [docs/features/animation-system.md](docs/features/animation-system.md)** 并接入现有体系，不得自造：
- 时长/曲线只用 token：CSS 变量 `--dur-*` / `--ease-*`（base.css `:root`）；**禁止新写字面量时长或 cubic-bezier**。
- 进出场用 `usePresence`（components/motion.tsx）+ `mp-panel`/`mp-pop`/`mp-scrim`/`xfade`/`acc` 骨架类；**禁止用 keyframes 做进出场**（不可打断），keyframes 只许一次性内容入场与循环装饰。
- `CustomSelect` 的浏览器自有 `::picker(select)` 是明确例外：使用 `@starting-style` 与 `display`/`overlay` 的离散保留实现进出场，不能套 `usePresence`；视觉动画仍只用 `transform`/`opacity` 与既有 token，必须覆盖减少动态效果。其他 React 弹层继续使用上述骨架。
- 动画属性只许 `transform`/`opacity`/`grid-template-rows`（合成器友好）；禁止 `transition: all`、避免 width/height/max-height/padding/margin 过渡。
- 改 `--dur-*` 时必须同步 motion.tsx 的 `MOTION` 常量（presence 卸载兜底依赖 JS 侧时长）。
<!-- motion:end -->

<!-- shell-redirect:begin -->
## Shell 重定向规约（所有 Agent 通用）

Windows 下丢弃命令输出：Git Bash 一律 `> /dev/null`；`> nul` 只许出现在 cmd.exe 上下文（如 `cmd /c "… > nul"`）。原因：Git Bash（MSYS）不把 `nul` 当 Windows 保留设备名，`> nul` 会生成名为 `nul` 的真实文件并把输出写进去，反复污染仓库根目录（已多次发生，故立此规约）。
<!-- shell-redirect:end -->

<!-- testing:begin -->
## 测试规约（用户设定，必须遵守）

三层测试体系与命令见 [docs/features/testing.md](docs/features/testing.md)。两条硬规则：

1. **修 bug 必须带回归测试**：定位并修复任何 bug 后，**同一改动**里必须补一个能拦截该 bug 的用例——复现其触发路径，自查方式：把修复还原时该用例应转红。按三层分工落位：纯逻辑 → `test/*.mjs`；组件/Hook → `test/unit/*.spec.tsx`；跨真 app 的关键链路 → `test/e2e/*.spec.ts`。确实无法自动化（依赖真实外部服务、纯视觉验收等）时，必须在对话/journal 里说明原因与人工验证方式，**不得静默豁免**。
2. **UI 交互改动必须带 UI 测试**：新增或修改面板/弹窗/菜单/动画等 UI 的**交互行为**（状态流转、事件响应、进出场、键盘导航）时，必须同步新增或更新组件级测试（`test/unit/`，样板 `confirm-dialog.spec.tsx`，`window.api` 用 `helpers/api-mock.ts`）；涉及主进程联动的关键链路补 `test/e2e/`。纯文案或样式 token 替换可豁免。进出场类改动另受动画规约约束（`usePresence` 契约有 `motion-presence.spec.tsx` 守卫，改 `--dur-*` 须同步 `MOTION` 常量并让该用例过）。
3. **日常有界验证，不主动跑全量**：改完代码用 `npm test`（相关回归/冒烟子集，一分钟目标）或指定测试文件；构建配置/测试基建/删除变更不自动升级全量。真实 Git、浏览器视觉、静态审计按影响显式运行 `test:integration` / `test:visual` / `test:audit`；默认并发 2，同 checkout 测试命令互斥。不要为了「稳」加 `--full` / `TEST_FULL=1`；显式全量含类型检查共用一小时预算，超时非零退出，不得把日常抽样或未完成报告为完整覆盖。Git 测试钩子默认关闭，`npm install` 不自动安装，不假定存在每晚定时兜底；`npm run test:full` 与不带过滤的 `vitest run` 在 AI 环境里仍降级日常档。
<!-- testing:end -->
