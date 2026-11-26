# 交验前置门（维度门，R-14 一期）

> 状态：实现说明 v1（2026-09-21：一期落地——机械门两维度 + 调度语义教学 + 强制验收留痕。二期（独立评审 Worker / 维度路由 / quorum 聚合）原定于 docs/plans/archive/collab-retro-plan.md R-14，该计划已归档，二期如需推进按新架构重新评估）
> 代码主入口：纯逻辑 `src/shared/dimensionGates.ts`、收集 runner `src/main/dimensionGates/runner.ts`、触发与落盘 `src/main/sessions.ts`（`scheduleDimensionGates` / `applyDimensionGates` / `clearDimensionGates`）、验收硬阻断 `src/main/capabilities/hosts/sessions.ts`（`sessions.review`）
> 关联：[board-status.md](board-status.md)（needs_you 三档与验收动作）、[orchestrator-events.md](orchestrator-events.md)（dim_gate_red 编排事件）、[global-board.md](global-board.md)（看板展示面）、[animation-system.md](animation-system.md)（motion 维度检查的规约本体）

---

## 1. 职责与定位

Worker 报 `needs_you`（交验）时，宿主先对**本次交付的改动**跑一组**零 LLM 的机械维度检查**（编译不过类语义维度不做机械检查，交给调度教学——见 §5）。设计定案（夜批决议）：

- **硬阻断**：任一维度红灯的会话**不进「需要你」列**——卡片留在工作列（工作中 lane）带红灯徽标，验收 API（`sessions.review` passed）同时被阻断。
- **逃生门**：红灯会话看板右键「强制验收（跳过维度门）」→ 确认框展示红灯详情 → 确认后按验收通过处理，验收账本留痕 `dimension-gate-override：详情`（重启可查，同 approval=auto 先例）。LLM 侧等价参数 `sessions.review` 的 `skipDimensionGate=true`。
- **人是终审不变**：手工会话（未收编 orchestrated）不进门，人验即终局（与 R-08 授权方向一致）；只有编排会话（`orchestrated=true`）的 needs_you 触发。
- **混合执行者**：机械脚本管 i18n/动画这类可静态判定的维度；常规维度（编译/测试/规约）靠调度教学自查（§5），不设机械门。

## 2. 维度注册表

内置默认（`src/shared/dimensionGates.ts` 常量；结构支持工作区配置覆盖——本批只做内置 + 配置读取骨架）：

| 维度 | 命中条件 | 检查内容 | 红灯判据 |
|------|----------|----------|----------|
| `i18n`（多语言） | 改动文件含 `src/shared/i18n/**`，或改了 `.ts/.tsx`（新增行含 t() 调用才产生检查面） | 对本次交付**新增的 t() key** 跑双语对账（key=中文原文，词条表=locales/**.ts）；locale 文件**删除**的 key 若仍被 src 引用也算 | zh 有 en 缺（新增 key 无词条）或词条被误删仍被引用 |
| `motion`（动画） | 改动文件含 `*.css` 或 `src/renderer/src/components/motion.tsx` | 对**改动的 CSS 文件的 diff 新增行**跑静态规约：字面量时长（`transition/animation(-duration/-delay): … \d+m?s`）、`cubic-bezier(` 字面量、`transition: all`；改 motion.tsx 时另跑 MOTION 常量与 base.css `--dur-*` token 数值同步 | 任一新增行违规，或 MOTION 常量与 token 不一致/缺对应 token |

- `--dur-*` / `--ease-*` **token 定义行**（如 `--dur-micro: 120ms;`）放行——token 本体必然是字面量。
- i18n 检查核心抽取（`extractTCallKeys` / `extractLocaleKeys`）与 `test/i18n-coverage.mjs` **单源共用**（测试 import 本模块，勿再各写一份）。
- **改动文件口径**（runner）：隔离树 = 脏文件（`git status --porcelain -uall`——未跟踪新目录展开到文件，否则整目录折叠成 `?? src/` 会让门对新目录交付失明）∪ 分支领先提交（`git diff base...branch`，base=建树记录的 `worktreeBaseBranch`，缺省回落 origin/HEAD→main）；共享检出 = 脏文件。新增/删除行 = `git diff HEAD -U0` + `base...branch -U0` + 未跟踪文件全文；均设上限（文件 200 / 行 4000 / 单文件读 512KB / 问题行 20）。
- **配置覆盖骨架**：会话工作目录 `.muster/dimension-gates.json` 的 `{"disabled": ["i18n"]}` 可关维度（`parseDimensionGateConfig`，未知 id 忽略）。一期仅支持关闭内置维度。

## 3. 触发与阻断语义

```text
Worker POST phase=needs_you（编排会话）
  → setPhase 落库后 fire-and-forget 跑门（冷却 20s 去重；红灯/无结果时冷却不生效——返工再报必须重查）
  → 快照写入 SessionMeta.dimensionGates（{at, trigger:'needs_you', results[]}）+ broadcast
  ├─ 全绿/无命中 → 照旧进「需要你」列（meta 记绿灯结果，徽标不显示）
  └─ 红灯 →
      ├─ 看板：不进需要你列（boardReview.gatedFromNeedsYouColumn）；卡片留工作列出红灯徽标（.board-card-gate-red）；不进探出条/轮播（isNeedsYouPeekSession 同步排除）
      ├─ 调度：编排事件 dim_gate_red 入队（通知建议先打回）；通知中心补一条纠正 toast（needs_you 的桌面通知先于门结果弹过，需要纠偏）
      └─ API：sessions.review passed 硬阻断报错（文案指路打回/强制验收）；rejected/deferred/processed 不受阻
```

- **门结果生命周期**：下一次 needs_you 上报重跑覆盖；`sessions.review` rejected（打回）/ passed（含强制验收）/ processed 收尾时 `clearDimensionGates` 清除——打回后 Worker 返工再报 needs_you 必然触发新一轮检查。
- **fail-open**：门执行抛错（git 不可用等）只留日志、按无门处理，不挡 needs_you。
- Worker 侧感知一期不做主动注入：人不点打回 Worker 不知道被挡，靠调度收到 dim_gate_red 事件后打回（打回即达，rejectInjectText 注入）。

## 4. 逃生门与留痕

- **入口**：红灯会话卡片右键「强制验收（跳过维度门）」（danger 项）→ `AppConfirmDialog` 展示红灯徽标行 + 详情 + `dimension-gate-override` 留痕说明 → 确认调 `sessions.review {decision:'passed', skipDimensionGate:true}`。
- **留痕**：验收账本（`SessionMeta.acceptanceLog`）追加 note 前缀 `dimension-gate-override：<红灯详情摘录>`；有隔离树的会话 integrate 自带的 passed 痕照记，override 痕另补一条（append-only 账本两行并存是预期）。
- **LLM 侧**：`sessions.review` 参数 `skipDimensionGate`（catalog 已描述）；确认框摘要（`reviewConfirmSummary`）在快照带红灯时显示「强制验收…跳过维度门…」头行，显式 skip 才出现留痕承诺行；按钮文案（`reviewConfirmAction`）红灯时为「强制验收（跳过维度门）」。

## 5. 调度语义教学（软机制）

`src/main/agent/systemPrompt.ts` 调度正文加「交验前置门」段（对齐合入审批教学风格）：

- 收到【维度门红灯】编排事件 → 先自查并建议打回（`sessions_review rejected`，红灯详情会附上），Worker 修复重报后门会重跑；确属误报才提醒用户在全局看板右键「强制验收」，不要自己长期搁置。
- 通知用户验收前先自查常规维度：编译/测试过没过、是否守仓库规约（AGENTS.md 与 docs/features 惯例），确认无碍再提醒验收。

常规维度（编译/测试/规约）**没有机械门**——语义判断交给调度，一期明确不自动化。

## 6. 关键文件

| 文件 | 职责 |
|------|------|
| `src/shared/dimensionGates.ts` | 纯逻辑单源：维度注册表/命中 pattern/i18n 增量对账/motion 静态检查/MOTION 同步/快照聚合与徽标文案/配置骨架/diff 行解析 |
| `src/main/dimensionGates/runner.ts` | git 改动收集（脏 ∪ 领先提交）+ 文件读取 + 快照组装；无 electron 依赖（pipelineFacts 先例） |
| `src/main/sessions.ts` | `setPhase` needs_you 触发（编排会话限定）、`applyDimensionGates` 落盘广播、红灯编排事件 + 通知、`clearDimensionGates` |
| `src/main/capabilities/hosts/sessions.ts` | `sessions.review` passed 硬阻断 + `skipDimensionGate` + override 留痕；rejected/processed 清门 |
| `src/shared/boardReview.ts` | `gatedFromNeedsYouColumn`（列过滤）/ 探出条排除 |
| `src/renderer/src/panels/BoardPanel.tsx` / `BoardCard.tsx` | 桶分流（红灯留工作列）、红灯徽标、右键两动作、强制验收确认框、打回预填详情 |
| `src/shared/notifyQueue.ts` / `src/main/orchestrator/events.ts` | `dim_gate_red` 事件 kind + `noteDimensionGateRed` |
| `src/shared/confirmDialog.ts` / `sessionCloseBatch.ts` | 确认快照 `dimensionGateRed` 一行 + 强制验收摘要/按钮分支 |
| `src/main/agent/systemPrompt.ts` | 调度教学段 |

## 7. 已知边界

- **一期内置两维度**（i18n/motion）；「常规」维度靠调度教学，无机械检查。维度注册表的结构性扩展（工作区自定义维度/自定义 pattern）留二期，本批只有 disabled 开关骨架。
- **motion 检查只看 diff 新增行**：存量违规不追溯（与仓设计 lint 的全仓扫互补，不重复）；`--dur-*` token 定义行天然放行。MOTION 同步检查要求 base.css/motion.tsx 都在改动树的预期路径（`src/renderer/src/...`），他仓布局不命中即跳过。
- **i18n 检查依赖本仓式结构**（key=中文原文 + `src/shared/i18n/locales/**` 词条表）：locale 目录不存在时该维度不产生检查面（不误报）。「en 多余/未引用」不做红灯（数据驱动 key 属正常，与全量对账口径一致）。
- **needs_you 桌面通知先于门结果**（门是异步的，~百 ms 级）：通知已弹、列里却没出现——由红灯纠正 toast 与徽标解释；如仍觉突兀可在二期把 needs_you 通知延迟到门结果后。
- **GUI 会话建议胶囊**（R-20）的「验收通过」对红灯会话会收到硬阻断报错（flashTip 指路看板强制验收/打回），胶囊栏本身未做红灯态区分。
- **移动端看板**（MobileApp/WorkspaceDetailPage）用自己的 zone 过滤，未接 `gatedFromNeedsYouColumn`——移动端仍按原样展示 needs_you。
- **打回后 Worker 若不再重报 needs_you**（phase 已是 needs_you、修复后直接 idle）：门不会自动重跑，但打回时已清门结果，卡片不再带红灯徽标；下次任何 needs_you 上报（含 LLM 兜底被粘性拦下的场景之外的模型上报）会重新触发。

## 设计初衷（2026-10-26 与用户定稿）

> 依据 campaign-intent-drafts/D03.md 草案定稿（用户 2026-10-26「不抽查直接定稿」）；歧义点处置：22 项卡片决策＋长尾按草案推荐，明细见专项账本「意图定稿决策」节。

- 为谁/什么场景：编排会话 Worker 报 needs_you 交验时，宿主先跑零 LLM 机械维度检查（i18n 增量双语对账、motion 静态规约+MOTION 同步），红灯不进「需要你」列、验收 API 硬阻断——把「编译不过类」低级红灯挡在人验收之前。
- 为什么这样设计：机械脚本管可静态判定维度，常规维度（编译/测试/规约）交调度教学自查、不设 LLM 门；硬阻断+逃生门（强制验收留痕 dimension-gate-override，重启可查）；fail-open（门执行抛错按无门处理，不挡 needs_you）；手工会话不进门（人是终审，R-08 方向）。
- 明确不做：motion 只看 diff 新增行（存量违规不追溯）；不查「en 多余/未引用」；打回后 Worker 不再报 needs_you 就不重跑门；移动端看板未接列过滤。
- 歧义点：内置两维度（i18n/motion）是长期最小集还是占位待扩（危险命令、回归测试名等）？A=最小集、按发现驱动加维度（review 不催扩）／B=占位（review 关注注册表扩展点健全性并推动扩）。推荐 A——结构上已留 disabled/注册表扩展点，扩维度等真实误验收案例驱动。
