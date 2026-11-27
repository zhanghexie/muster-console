# 测试体系

> 三层测试地图：离线自测（run.mjs）/ 渲染层组件单测（Vitest）/ Electron 端到端（Playwright）。
> 2026-09-14 升级引入组件层与 E2E 层，存量离线套件原样保留（双轨）。

## 总览

| 层 | 命令 | 框架 | 位置 | 跑什么 |
|----|------|------|------|--------|
| 离线自测 | `npm test`；显式专项见下文 | 自造 runner（`test/run.mjs`，默认并发 2） | `test/*.mjs`（平铺） | 日常纯函数/主进程回归子集 + audit 静态守卫按改动闭包并入；真实 Git、视觉走专项。EXCLUDE 白名单里的脚本需要活的应用/本机配置，不进离线套件 |
| 组件单测 | `npm run test:unit` | Vitest 3 + jsdom + Testing Library | `test/unit/**/*.spec.{ts,tsx}` | 渲染层组件/Hook/store 行为；`window.api` 由 Proxy mock 提供 |
| Electron E2E | `npm run test:e2e` | Playwright 1.63（`_electron`） | `test/e2e/**/*.spec.ts` | 真 app（out/ 构建产物）+ dev-sandbox 隔离 + mock-llm：启动冒烟、沙箱 fixture、Agent 管线与危险操作确认门 |

开发沙箱通过 `src/main/devSandboxGit.ts` 初始化演示仓库；Git 初始化失败会中止，后续每次写操作前核验本地 `.git` 与实际仓库根目录，避免误操作父仓库。Windows 启动 Git 时从短路径通过 `-C` 指定目标并启用 `core.longpaths`；系统或 Git 仍可能拒绝过长路径，报错时将测试目录或项目路径缩短。`test/dev-sandbox-git.mjs` 覆盖初始化失败、仓库身份及真实 Git 长路径场景。

`node test/sqlite-long-path.mjs` 验证 SQLite 长路径、共享 WAL、重开和内存库，并启动 Electron 内置 Node 覆盖同一长路径；该用例不替代 macOS/Linux 真机验收。`MUSTER_TEST_LONG_UPLOAD_PATH=1` 可让浏览器上传 E2E 使用长工作区，同时保持沙箱自身路径较短，以隔离 Git 长路径限制。

`test/unit/node-main/dev-sandbox.spec.ts` 在Windows用独立隐藏PowerShell进程持有禁止删除的真实文件句柄，验证清理被拒绝或明确记录延迟墓碑，释放后可以清理；macOS/Linux跳过此Windows专属锁例。外部进程持续持锁是系统限制，重试/重命名都失败时必须报告错误，不能返回重置成功。

Electron 消息专项使用隔离应用数据和替代传输。`logical-channels.spec.ts` 验证全局 Channel、工作区绑定和远程权限，`phone-feishu-setup.spec.ts` 用专用 CLI 夹具验证旧手机来源。测试入口向各夹具传递统一截止时刻和构建加载所需的环境变量。

`CustomSelect` 有现代 picker 与旧浏览器主题回退两条路径。jsdom 默认缺少 base-select，原有组件测试覆盖回退；`custom-select-native.spec.tsx` 显式启用能力桩，验证现代分支 React/DOM 接线。UA 的选择、滚动、Tab/Escape、顶层布局和动画必须使用 `test/fixtures/custom-select-native.tsx` + `custom-select-native-scenario.mjs` 的真实 Chromium 夹具；不能将 jsdom change 或 Playwright selectOption 当成原生 picker 交互验收。浏览器/Electron 的现代触发器按 combobox 定位，打开态用 `select:open`，选项使用实际 click/键盘；不要再假设 body portal 的命名 listbox。

## 日常验证与显式专项（2026-10-05）

用户目标：日常验证一分钟内；显式全量保留完整覆盖并允许较长时间；低并发，不默认安装 Git 测试钩子。测试保留在仓库，缩小默认执行范围；超时或未完成不能返回通过。

历史 WebView 迁移 spike、旧侧栏状态演示、分屏手柄/Snap、手机 Metro、旧配色及毛玻璃/原生材质小样只验证独立原型，不覆盖当前产品，已从测试套件移除；历史原型仍保留。正式浏览器、侧栏、分屏、手机和窗口材质由产品组件及视觉/Electron 回归覆盖，覆盖场景并非与原型测试逐项相同。旧的 `e2e.mjs`、`check-ui.mjs` 和已退役浏览器冒烟脚本也已移除，现行端到端入口见下文。

```bash
npm test                         # 日常有界验证，同 test:changed
npm test -- --list                # 只列范围，绝不启动离线测试或 Vitest
npm run test:integration          # 真实 Git 仓库/工作树集成专项
npm run test:visual               # Chromium 视觉/键盘/布局专项
npm run test:audit                # 全仓扫描、CSS/架构/打包静态守卫
node test/i18n-coverage.mjs --audit # 扩展扫描主进程/共享层中文，需人工区分用途
npm run test:unit -- confirm-dialog # 指定组件 spec
node test/run.mjs codex-driver    # 按文件名过滤离线专项
npm run test:full -- --full       # 显式类型检查 + 全部离线测试 + 组件全套
```

日常档由 `test/helpers/profiles.mjs` 管理：

- `test/helpers/impact.mjs` 仍构建源码依赖闭包；配置/基建/删除改动在底层判定为宽泛影响，但日常入口改用**冒烟 + 可解析的相关回归子集**，不自动启动全套。
- 默认最多 **16 个离线文件 + 6 个组件 spec**（audit 守卫并入与直接改动测试另计，见下两条）。直接修改的测试/spec **无论档位**始终保留——audit/integration/visual 专项档与新建未跟踪测试也一样（EXCLUDE 手动脚本除外），可超过数量上限，但仍受时间预算约束。额外相关离线测试打印延期数量，结果只代表日常范围加并入项。
- **audit 静态守卫按改动闭包并入默认档**（2026-10-25，修 D14 审计 P2「audit 档守卫永不在默认档可见」）：扫描型守卫（i18n-coverage、packaging-file-filters、test-hygiene 等 15 个）随任意 src 改动入选；闭包型守卫（sessions-slide-css、catalog-public-surface、surface-parity、updater-notify-wiring、impact-select）在其目标文件改动时入选；宽泛/删除改动全带。守卫均为秒级静态断言——实测整档 20 个约 8s（并发 2），并入默认档后墙钟增量约 +2~8s，55s 日常预算内可承受。
- i18n 日常守卫核对全仓 `t()` 字面量和重复键，按 TypeScript 语法树检查渲染层裸中文、JSX 文本/属性及已登记的数据驱动文案；只遮盖翻译调用、正则与已验证的数据键。主进程和共享层的原文字面量由显式 `node test/i18n-coverage.mjs --audit` 检查；该扫描同时包含模型协议和持久数据，需要结合实际展示路径判断。日常门禁不会证明所有主进程错误都已翻译，已知用户可见错误通过对应字典与 IPC/组件回归核对。共享模块渲染安全守卫区分类型与运行时导入，也检查 Node 内置模块和真实 `process` 引用。
- 真实 Git 进程测试与 Chromium 测试仍不进默认抽样（但被直接修改时会跑，见「无论档位」条）；长耗时集成专项可能吃满日常 55s 预算，预算耗尽按既有语义记 failed 而非静默跳过，完整验证用 `test:integration` / `test:visual` / `test:audit` 显式执行。专项数量和入口在输出中可见，`--list` 可查看每档实际清单与并入明细。
- 组件日常档保留确认框与 presence 冒烟，优先直接修改的 spec，再按源码文件名/读文件补边挑选有限相关 spec。它是抽样验证，不等同于 Vitest 模块图的完整相关集合。完整组件覆盖通过 `test:unit` 或强制全量执行。
- 文档改动不触发用例；`test/run.mjs --changed-files <清单>` 读取一行一个相对路径，供手动暂存区门禁和定向验证使用。
- `test/helpers/runScope.mjs` 让 AI 的 `--all` 和未过滤的 Vitest 请求降级日常档。现已识别 `CODEX_THREAD_ID` / `CODEX_SESSION_ID`，以及 Cursor、Claude、MetaAgent、Gemini、OpenCode 标记。`--full` / `TEST_FULL=1` 能显式执行完整覆盖，并使用全量预算。
- `test/design-lint.mjs` 用 PostCSS 按完整值检查圆角；当前分屏短标记只允许指定的隐藏态和对应焦点态，工作区短竖线只允许在切区按钮持有 `aria-current="true"` 的行上显示。内置日报检查读取 `resources/extensions/daily-report/ui/panel.html` 发布源码，不读取工作区安装副本。

原生下拉禁用检查`capability-ui-controls.mjs`是小型 UI 契约例外：渲染代码改动时日常必跑，不会被 16 项抽样省略；`native-select-policy.mjs`验证该选择规则。

### 资源与时间预算

- `test/helpers/resources.mjs`：离线进程与 Vitest **默认 2**，`TEST_JOBS=1` 可串行，任何正整数覆盖最多取 4；异常值回落 2。类型检查最多 2，Playwright 仍为 1。
- 离线与 Vitest 分阶段执行；显式 Git 门禁中的类型检查与测试也分阶段执行，不叠加各自的进程池。
- `test/helpers/lease.mjs`：同一 checkout 只允许一条测试/类型检查命令；重复命令快速失败并提示占用 PID，不再额外起一组 Worker。子阶段通过令牌复用父锁；正常退出释放，死进程锁可回收。不同 checkout 各自独立。
- 日常内部预算 **55 秒**，显式全量 **一小时**，离线专项/单独组件/E2E 入口 **175 秒**。当一次发布改动直接修改超过 6 个组件 spec 时，日常预算扩大到 **90 秒**，覆盖这组明确的回归测试；其他日常运行保持 55 秒。`TEST_BUDGET_MS` 只能缩短对应预算，不能延长。2026-10-28 全量包含 654 个离线文件、667 个进程及组件全套，三分钟只完成六个进程；经用户同意放宽全量预算，专项和日常上限不变。
- `scripts/test-full.mjs` 让类型检查、完整离线测试和组件全套共用同一个截止时刻，并实时转发子阶段输出；`scripts/test-e2e.mjs` 让构建和 Electron E2E 共用截止时刻。Vitest/Playwright 配置内也设看门狗：全量内的 Vitest 继承全量截止时刻，单独调用仍受专项上限约束。`test/helpers/execute.mjs` 超时终止测试进程树（Windows `taskkill /T /F`），返回非零并明确输出“验证未完成”；未执行项不能算绿。
- 显式全量中单个离线测试另有五分钟上限；超时只终止该测试进程树并记失败，继续执行余下测试，不能消耗整个全量预算。`turn-changes` 夹具在删除临时目录前释放文件监听，`test-policy` 以子进程退出断言守住该回归。
- 上轮离线耗时缓存仍在 `.tmp/test-timings.json`，只用于慢文件优先；文件分片仍用 `// @test-shards N` + `TEST_SHARD` + `helpers/shard.mjs`，各分片受同一个并发/时间上限。

### 为什么移出默认档

现状盘点为 408 个离线文件，旧依赖分析有 68 个 alwaysRun，任意源码修改都会带上浏览器和真实 Git 集成测试；配置改动还会启动全套。旧耗时缓存中单个工作树集成测试超过 7 分钟。过去的“默认最多 16 进程 + Vitest 同时起跑”和空闲机器约 33 秒的记录不适合作为桌面低负载目标。

真实 Git 集成覆盖回滚、采纳、子模块和清理语义，保留为专项；浏览器视觉负责像素/原生键盘，保留为专项；宽泛静态扫描和源码文本守卫无需每次源码修改都执行，保留为审计。此次未删除这些用例。

依赖分析只在同一次分析内缓存重复入口闭包和已解析节点，不跨改动复用；纯 spec 改动不建源码图。已知依赖命中优先于不相关 alwaysRun 地板，宽泛改动优先冒烟与直接修改的测试。另修复两类无关扩大：`load('main/...ts')` 包装调用可解析为入口；测试读取单个源码文件、同时遍历临时夹具，不再被当成全仓扫描。`test/impact-select.mjs` 保守兜底和闭包守卫继续有效。

实测：混合脏工作区下，16 个离线文件 + 6 个组件 spec 通过，首轮包含选范围 **40.967 秒**；依赖分析减重后两轮分别 **16.581 秒**、**17.803 秒**，默认并发 2。提交前的独立索引快照包含本任务改动，日常档选中 9 个离线文件 + 2 个组件 spec，全部通过，含选范围 **8.379 秒**；加上三套冷类型检查共 **24.1 秒**。依赖分析与测试卫生专项另行通过。三分钟截止与进程树清理由缩短预算的真实子进程回归验证；本轮未执行完整套件，也未声称全套能在三分钟内全部通过。计时随电脑负载变化。

## Git 测试钩子默认关闭

`package.json` 不再含安装钩子的 `prepare`；`npm install` 不设置 `core.hooksPath`。`scripts/install-hooks.mjs` 也拒绝通过 prepare 自动启用。

```bash
npm run hooks:install             # 用户显式选用时启用 pre-commit / pre-merge-commit
npm run hooks:uninstall           # 仅卸载指向 scripts/githooks 的本地设置，保留其他自定义钩子
```

2026-10-05 已卸载本 checkout 原有 `core.hooksPath=scripts/githooks`。显式安装后的 `scripts/gate.mjs` 仍保留：

- `pre-commit`：类型检查 + 暂存清单的日常验证（含 audit 守卫闭包并入；直接改动的暂存测试文件无论档位都会跑——把守卫改红的提交必然被门禁拦下）；代码脏区和暂存区不同时导出**暂存快照**，避免测到工作区半成品。
- `pre-merge-commit`：显式全量；快进合并不产生合并提交，Git 不运行该钩子。
- 读取暂存区的 Git 命令保留索引环境，测试子进程经 `stripGitEnv` 清洗；删除类变更仍传入影响面分析。
- 失败阻断；`mergeIsolate` 仍识别 `gate-failed` 并 abort，已有 `test/merge-hook-gate.mjs` 专项保留。
- 纯文档/本地状态提交放行；可用 `SKIP_TESTS=1` 或 Git `--no-verify` 显式跳过。
- 钩子必须 LF，`test/test-hygiene.mjs` 继续检查 Git 环境、钩子行尾、长计时器、随机端口与分片配对。

不假定本机已配置每晚测试；周期验证仅由用户显式安排，本轮不新增定时任务。

## 类型检查（scripts/typecheck.mjs）

`npm run typecheck` 用最多 2 个进程执行四套 `tsc --noEmit`，均开 `incremental`（buildinfo 在 `.tmp/tsbuildinfo/`）；与其他测试入口共用 checkout 互斥：

- `tsconfig.node.json`（主进程/preload/shared）、`tsconfig.web.json`（渲染层）；
- `tsconfig.test.json`（2026-09-28 新增）：`test/unit/**`（主进程用例除外）、`test/e2e/**`、`vitest.config.ts`、`playwright.config.ts`。Vitest/Playwright 执行时只剥类型不检查，接入前测试代码已积累 87 处类型错误（49 个文件）：20 个 spec 的 `import type` 路径多写一层 `../`（运行时被擦除不报错，但类型全塌成 `any`，fixture 形同无类型）、fixture 缺必填字段、mock 签名与真接口脱节、free-canvas 用例还在传已删除的字段。`store-sessions-reconcile.spec.tsx` 靠 `Required<SessionMeta>` 在编译期强制覆盖全字段——之前根本没人编译它，新加的 `escalateBudget` 字段就漏在覆盖外。`test/*.mjs` 是纯 JS，不在类型检查范围。
- `tsconfig.test-node.json`：`test/unit/node-main/**` 的主进程模块用例按 Node 类型检查，并包含主进程依赖的本地类型声明，避免与 DOM 计时器类型混用；Vitest 执行入口与环境不变。

## 覆盖率（npm run test:coverage）

`scripts/test-unit.mjs --coverage --pool=threads` 在三分钟预算与低并发下出 v8 覆盖率（范围 `src/renderer/src/**`、`src/shared/**`，产物 `.tmp/coverage/`，HTML 在 `index.html`），再由 `scripts/coverage-report.mjs [--top N]` 打印「未覆盖清单」：部分覆盖文件按未覆盖分支数排序 + 从未被任何 spec 加载的渲染层文件按行数排序。只量组件单测这一层——`src/shared` 的纯逻辑大多由 `test/*.mjs` 覆盖，那里的 0% 不代表没测。需要 devDependency `@vitest/coverage-v8`（版本与 vitest 对齐）。覆盖率不进门禁，是找测试盲区的工具。

新测试往哪放（写进了 CLAUDE.md 约定）：

- 纯 Node 逻辑（不碰 DOM/React）→ `test/<名>.mjs`，自动进 `npm test`；
- 需要 Vitest 模拟的主进程模块回归 → `test/unit/node-main/<名>.spec.ts`；
- 带 DOM/React/Hook → `test/unit/<名>.spec.tsx`；
- 跨真 app 的回归 → `test/e2e/<名>.spec.ts`；
- 需要活的应用但暂不收编的脚本 → 加进 `test/run.mjs` 的 EXCLUDE（手动跑）。

## 两条硬规则（用户设定，2026-09-14）

1. **修 bug 必须带回归测试**：修复任何 bug 的同一改动里必须补一个能拦截它的用例——复现其触发路径，自查标准是「把修复还原时该用例应转红」。落位按三层分工（见上）；确实无法自动化（依赖真实外部服务、纯视觉验收等）时，必须在对话/journal 里说明原因与人工验证方式，**不得静默豁免**。
2. **UI 交互改动必须带 UI 测试**：新增或修改 UI 的交互行为（状态流转、事件响应、进出场、键盘导航）必须同步新增/更新组件级测试（`test/unit/`；样板 `confirm-dialog.spec.tsx`，桥接用 `helpers/api-mock.ts`）；主进程联动的关键链路补 `test/e2e/`。纯文案与样式 token 替换可豁免。进出场类改动同时受动画规约约束：改 `--dur-*` 须同步 `MOTION` 常量并保住 `motion-presence.spec.tsx`。

> 现行强制力是文档约定（仓库的 AGENTS.md/CLAUDE.md）；将来上 CI 可加 diff 检查（bug 修复类提交必须触碰 test/ 目录）作为机器门禁。

## 组件单测（test/unit/）

- `vitest.config.ts`：jsdom 环境、`globals: true`、只扫 `test/unit/`；渲染层无路径别名（相对导入），无需 alias 配置。`pool: 'vmThreads'`：每个 spec 仍是独立 vm 上下文，但 jsdom 等模块跨文件复用，默认最多 2 个 Worker；保持每文件隔离，不用 `--no-isolate`。
- `test/unit/setup.ts` 每用例重装 `window.api` mock + 挂 renderer 的 i18n 实例 + RTL cleanup。
- **api-mock**（`test/unit/helpers/api-mock.ts`）：Proxy 生成任意 `api.a.b.c()` 的 `vi.fn`，默认 resolve `DEFAULTS` 里 store 启动即解构的形状（sessions.list / workspaces.list / config.get / runtimes.list / notify.list）；`api.on(channel, cb)` 返回真卸载函数，`currentApiMock().emit(channel, payload)` 模拟主进程推送（IPC_EVENT_CHANNELS）；`mockOf('sessions.list')` 断言调用；`override()` 覆盖默认返回。真实契约以 `src/preload/index.ts` 的 `WorkbenchApi` 为准（type-only import，不执行 preload）。 检查全局轻提示的组件用例通过 `helpers/app-tips.tsx` 挂载实际的 `AppTipHost`，历史错误先点击「查看详情」。每例卸载后清除轻提示和计时器。
- 现有样板：`panel-history.spec.tsx`（返回/前进双栈 + 回放抑制窗）、`motion-presence.spec.tsx`（usePresence 进出场契约，MOTION 与 base.css `--dur-*` 对齐的 JS 侧守卫）、`confirm-dialog.spec.tsx`（ui:confirm 事件 → 弹窗 → respondConfirm 回传 → 退场卸载，全链路样板）。
- 假定时器推进触发 setState 时要包 `act(() => { vi.advanceTimersByTime(...) })`（fireEvent 之外的定时器回调 React 不会自动 flush）。

## Electron E2E（test/e2e/）

- `playwright.config.ts`：`workers: 1`（所有 spec 共享 `.dev-sandbox`）、`retries: 1`、trace `retain-on-failure`。每次命令把产物写到独立的 `test-results/run-<UUID>/`（Git 忽略）。`test/helpers/e2e-artifacts.ts` 根据命令退出状态清理本次默认目录。整轮通过即清理，失败、中断或超时则保留产物。自动清理遇到占用或权限问题会打印路径和错误。
- 验收截图用 `npm run test:e2e -- test/e2e/<文件>.spec.ts --output .tmp/ui-captures/<验收名>`。显式指定的目录会保留，直跑 `npx playwright test` 也支持该参数。为每次验收指定独立路径，Playwright 会在下次使用同一输出路径时清空它。Playwright 交互 UI 会保留结果供浏览。
- 启动夹具 `test/e2e/fixtures/electron.ts`（worker 级、auto）：
  1. 先跑 `scripts/reset-dev-sandbox.mjs` 还原沙箱基准；
  2. `electron.launch(out/ 构建产物)`：`MUSTER_SANDBOX=1` + `MUSTER_INSTANCE_ID=e2e-<pid>`（Windows AUMID 加实例后缀），并删 `ELECTRON_RENDERER_URL` / `MUSTER_DEVTOOLS_PORT` / `MUSTER_WEB_PORT`（避免外部 dev 实例干扰；网关 7950 占用时动态端口）；
  3. 等 `.app-shell` 出现（渲染层水合以 `app:boot:wait` 放行为前提）；
  4. 收集渲染层 console error/warning 与 pageerror（过滤未打包态 Electron 自带的 CSP 安全告警）；
  5. 结束 `app.close()` 优雅退出，超时兜底 `taskkill /T /F` 杀进程树（该 app 关闭=最小化到托盘，且 pty shell 是子进程）。
- `mockLlm` 夹具（懒加载，只有用到的 spec 才拉起）：spawn `test/mock-llm.mjs`（18034）；端口已被占用时复用外部实例不负责停。
- 演示旋钮（给人看的时候用）：`PW_CONFIRM_PAUSE_MS=2500`（确认框点击前驻留，chat-guard）、`PW_LINGER_MS=3000`（关 app 前驻留）。注意 `electron.launch` 不支持 slowMo（playwright 1.63 静默忽略，勿再试）。
- 现有 spec：`smoke.spec.ts`（骨架渲染 + preload 桥 + console 零错误）、`sandbox-fixture.spec.ts`（dev-sandbox 基准校验，收编 ui-sandbox.mjs 的 CDP 分支）、`chat-guard.spec.ts`（Agent 管线 + 危险操作确认门，收编 e2e.mjs）、`mobile-approval.spec.ts`（T5.6 GUI 审批卡 → respondApproval，与手机 L3 同卡）、`notify-bus.spec.ts`（通知总线）、`github-pr.spec.ts`（真实应用、Git 和 IPC，模拟 GitHub App 登录及确认发布评审）。原 `file-trigger.spec.ts`（file 事件触发 e2e）已随定时任务简化、file/webhook/phase 事件触发退役（2026-11-02）一并移除，定时任务现行验收见 `test/prompt-tasks-*.mjs`。
- 断言经 `page.evaluate(() => window.api.xxx())` 走真 preload 桥；弹窗交互用 locator（`.confirm-modal`——注意 ConfirmDialog 与 AppConfirmDialog 共用该类名）。
- **契约时效**：收编时发现 e2e.mjs 三处过时契约——`.columns` 布局类已不存在；toolCall 取消语义从 `status:'cancelled'` 改为结果载荷 `{ok:false,cancelled:true}`；toolCall.result 是 `{content:[{type:'text',text:'<内层JSON>'}]}` 两层信封。收编旧脚本时先对照现行为再断言。

### 已知边界

- E2E 依赖本机装有 Worker CLI（claude-code 等）——chat-guard 的终端会话用例在无 CLI 的机器上会失败；上 CI 时需预装或打标跳过。
- `chat-guard` 的确认路径会真实创建主进程内部调度任务（不再写 schtasks），afterAll 按名字兜底清理。
- Windows 上杀软/索引器可能短暂锁住沙箱新写文件：`sandbox:reset` 已改为先停 fs watcher + `fs.promises.rm({maxRetries})` 预清理（见下「升级时顺手修掉的真 bug」）。

## GitHub Actions 发布矩阵

`.github/workflows/release-quality.yml` 在 Windows、Ubuntu 和 macOS hosted runners 上执行日常测试、类型检查和构建。打包阶段按目标准备并校验固定版本 Cua 驱动。Windows 打包使用搭载 Visual Studio 2022 的 `windows-2022`，供固定版本的 node-gyp 重建 node-pty；macOS x64 使用 `macos-15-intel`，arm64 使用 `macos-15`。打包生成 Windows NSIS、macOS x64/arm64 DMG、Linux AppImage/deb。CI 将安装器和解包应用一起封装为 tar artifact，保留可执行位和符号链接；冒烟和发布清单阶段先解包再读取对应产物。Linux smoke 分别通过 Xvfb 覆盖 X11，并通过 headless Weston 覆盖 Wayland。`npm run test:packaged-smoke` 使用 Playwright Electron 启动实际产物，检查窗口、IPC、boot failure 和优雅关闭。

PR 和 `main` 推送自动运行质量检查。工作分支通过 PR 触发质量检查，也可以在 Actions → `release-quality` → Run workflow 选中目标分支并勾选 `Run quality checks only`。公开仓的安装包通过手动运行验证。私有维护仓的 `main` 推送在质量检查通过后也会继续打包和冒烟。

手动运行默认打包、冒烟并生成 `packaged-verification-*` 和 `verification-manifest`。完成安装包分发范围及许可证验收后，可在 `main` 上勾选 `Build signed release artifacts (main only)` 进入正式发布验证。签名模式要求关闭 `Run quality checks only`，从 Actions secrets 检查 Windows 签名和 macOS Developer ID、公证凭据，强制签名并校验 macOS 公证票据，冒烟通过后生成 `release-manifest`。两种打包模式均通过 Actions artifacts 交付，electron-builder 使用 `--publish never`。 [GitHub 工件访问规则](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/download-workflow-artifacts)

Actions 结果用于确认对应 runner 已执行，GPU、真实用户桌面、硬件驱动和系统输入法仍需在发布记录中单独标记。

CI 的日常测试以 PR 基线或推送前的提交与检出的 HEAD 做差异选取。首推、手动运行或基线不可用时使用有界冒烟。本地日常测试继续按工作区改动取样，显式传入的 `--changed-files` 按清单执行。直接改动的 Chromium 视觉测试会并入日常测试，所以质量检查在 `npm ci` 之后、`npm test` 之前安装当前 Playwright 版本对应的 Chromium Headless Shell，Linux 同时安装浏览器所需的系统依赖。

质量检查、打包、冒烟、清单和 PR 审查草稿均通过 `setup-node` 配置 Node.js 24。工作流引用的 checkout、setup-node 和工件 Actions 也声明 Node.js 24 运行时。打包应用启动时使用 Electron 自带的运行时。`test/packaging-file-filters.mjs` 检查 CI 的 Node.js 版本、Actions 兼容版本，以及浏览器安装步骤的顺序和平台条件。

CI 类型检查步骤用 `NODE_OPTIONS=--max-old-space-size=4096` 为冷缓存编译提供足够的 Node 堆空间，仍沿用类型检查的时间预算和并发限制。各 packaged smoke 步骤通过步骤级 `env` 将 `runner.temp` 下的隔离 profile 交给冒烟脚本，失败时保留 profile 供诊断 artifact 收集。Linux 两种桌面会话分别设置 `XDG_SESSION_TYPE=x11` 和 `XDG_SESSION_TYPE=wayland`，让 Electron 选择 Xvfb 或 Weston 对应的 Ozone 后端。Wayland 步骤为 Weston 创建独立的 `XDG_RUNTIME_DIR`，失败诊断包括 Weston 日志。`test/packaging-file-filters.mjs` 检查堆设置、冒烟入口的作用域和 Linux 后端选择。

## 手动脚本收编 backlog

`test/run.mjs` EXCLUDE 里的脚本按价值逐步收编进 `test/e2e/`：

| 脚本 | 内容 | 状态 |
|------|------|------|
| ui-sandbox.mjs(CDP 分支) | 沙箱校验 | **已收编**（sandbox-fixture）；脚本仍供 `npm run test:ui` 使用 |
| e2e2.mjs | 手工 CDP 自测：多终端存活隔离、restartConversation 代理、邮箱存信、不自动输入正文、状态胶囊 | 待收编；需要单独启动 CDP9222/mock18034，本轮仅语法校验；当前自动化邮箱主链见 subagent-role-avatar.spec.ts |
| theme-ui-verify.mjs | 主题切换流程 | 待收编 |
| gui-chat-cdp.mjs / preview-cdp.mjs / browser-cdp-smoke.mjs | dev 实例 + 指定 devtools 端口（9333/9334） | 待收编（改走构建产物启动即可去掉端口约定） |
| web-access.mjs / web-mobile.mjs | 网关 + 手机表面（自带 build+launch，自包含） | 待收编（可平移为 playwright spec，浏览器侧用系统 Chrome） |
| terminal-raster-smoke.mjs / pi-electron-smoke.mjs | 派生进程冒烟（要 API key/网络的除外） | 待评估 |

## 升级时顺手修掉的真 bug（E2E 首跑即拦下）

1. **「一键沙箱重置」在 Windows 运行态静默失败**：`sandbox:reset` 只杀 pty 不停 fs watcher，recursive `fs.watch` 句柄锁住工作区目录 → 还原 `rmSync` EPERM 被 catch 吞掉、照样返回 `{ok:true}`，且半删除残留工作区。修复（ipc/workspaces.ts + devSandbox.ts）：reset 前停 watcher + `fs.promises.rm({maxRetries:10})` 预清理；模板还原失败显式返回 `ok:false`；预清理前先关记忆库 SQLite（WAL 句柄同样锁工作区文件），预清理挂 30s 看门狗——卡死显式报错 `{ok:false}`，不再静默挂死。
2. **automations.create 缺 schedule 参数时裸 TypeError**（capabilities/hosts/services.ts）：补显式校验与可读错误（词条已进 en.ts）。
3. e2e.mjs 旧断言编码的过时契约（见上「契约时效」）——收编版按现行契约重写。

## 并行化时顺手修掉的真 bug（2026-09-16）

**`extensions-tool-registry.mjs` 空转 60 秒**：用例 8 用 `setTimeout(() => r(1), 60_000)` 造一个「比超时更慢的底层任务」，断言 1ms 就通过了，但这个定时器句柄把 Node 事件循环吊住，进程打印完 `ok` 还要干等 60 秒才退出——一个文件吃掉全套 221s 里的 60s。修复：给它 `.unref()`；又因 `withTimeout` 内部的超时定时器本身也是 unref 的（`dynamicTools.ts:358`），两个都 unref 后事件循环会空掉、进程在 race 落定前就退出，故补一个 ref 住的 `keepAlive` 定时器并在断言后 `clearTimeout`。60.4s → 1.4s。

回归守卫 `test/test-hygiene.mjs`（测试的测试，两条不变量）：

1. 默认套件里 `setTimeout(..., ≥10s)` 必须 `.unref()` 或被 `clearTimeout`——直接拦上面这个 bug（还原修复即转红）；
2. 默认套件里不得 `listen(<固定端口>)`——守住并行化依赖的端口隔离前提。

实现上用括号配对扫描定位 `setTimeout` 实参，而不是惰性正则：回调里出现 `setTimeout(r, ms)` 这种非字面量 delay 时，`[\s\S]*?` 会跨行吃到文件后面某个数字上，报出根本不存在的违规（`evidence.mjs` 首次即误报）。注释在扫描前剥掉（换成等量换行保住行号），否则文档里的示例代码会自触发。

## 不在本期范围

- CI（GitHub Actions windows-latest 可跑 `npm run test:full -- --full` + E2E 冒烟子集，chat-guard 需预装 Worker CLI）；
- 存量 119 个 `.mjs` 迁移 Vitest（双轨制，零迁移）。

设计文档：plans/implemented/testing-upgrade-plan.md

## 设计初衷（2026-10-26 与用户定稿）

> 依据 campaign-intent-drafts/D10-D14.md 草案定稿（用户 2026-10-26「不抽查直接定稿」）；歧义点处置：22 项卡片决策＋长尾按草案推荐，明细见专项账本「意图定稿决策」节。

- 为谁/什么场景：三层测试地图（离线 run.mjs/Vitest 组件/Playwright E2E）+ 日常有界验证（55s 预算、并发 2、同 checkout 互斥、AI 请求自动降级日常档）。
- 为什么这样设计：真实 Git/浏览器视觉/静态审计移出默认档（单文件 7 分钟教训）；依赖分析选范围+冒烟兜底、超时非零退出不报完整覆盖；Git 测试钩子默认关闭显式选用；两条硬规则（修 bug 带回归测试/UI 交互改动带 UI 测试，不得静默豁免）为用户设定；test-hygiene 守测试卫生（长定时器 unref/禁固定端口）。
- 明确不做：不上 CI（本期范围外）；存量 .mjs 不迁移 Vitest（双轨零迁移）；不假定每晚定时兜底。
- 2026-10-25 更新：依 docs/audits/reliability/testing.md D14 两条 P2，audit 静态守卫按改动闭包有限并回默认档，直接修改的测试文件无论档位必跑（`npm test` 与提交门禁走同一 `--changed-files` 通道）；真实 Git/浏览器视觉仍为专项，不上 CI 与「一分钟日常」目标不变。
- 歧义点：CI——A=长期不上（单人+AI 工作流下本地互斥+可选钩子+硬规则已够；windows-latest E2E 需预装 Worker CLI，维护成本高）／B=试点 windows-latest 冒烟子集（smoke+纯逻辑，不含 chat-guard）。推荐 A，团队化/多机协作时再升 B。
