---
x-muster-version: 0.1.34
name: workflow
description: Author and manage scripted multi-agent workflows. Covers WORKFLOW.md, run.mjs, the wf API, triggers, restart behavior, and host.workflow.run parameters.
---

# host.workflow.run — scripted multi-agent workflows

Workflows live under `.muster/workflows/<name>/` (WORKFLOW.md + run.mjs). `host.workflow.run` is the scheduler-side entry point for the whole lifecycle.

## Actions

Required params are marked `*`.

| Action | params | Purpose |
|---|---|---|
| start | name*, args? | Start a run; returns the runId immediately. `args` keys follow the workflow's declared parameters (`?` marks optional in the `list` action). New or changed content passes fingerprint-bound business approval before execution; unchanged trusted content reuses trust. |
| list | {} | List workflows (name, description, parameters, limits, triggers, trust state `trusted\|changed\|never`, definition errors) plus running/recently finished runs. |
| get | runId*, logTail? (default 20) | View a run's status (running/waiting/completed/failed/cancelled/interrupted), current stage, what it waits on, pending questions, delegation counts, log tail. |
| validate | name* | Static parse of WORKFLOW.md plus an executable smoke import of run.mjs (module top-level code really runs) to check the default export — gated by current-content business approval. Call after writing or editing a workflow. |
| reply | runId*, askId*, answer* | Answer a question the script asked you (`wf.ask` to the scheduler). Option questions take the option's verbatim text (array for multi-select); otherwise text or an object. Questions for the user are rejected here — use `askHuman`. |
| askHuman | runId* | Re-surface the workflow's user question as a question card; the user's answer is written back to the script directly. Only call when the user mentions it or asks you to re-surface. |
| cancel | runId*, reason?, closeSessions? (default false) | Cancel a run together with its sub-workflows. `closeSessions:true` also closes the Worker sessions it spawned, reporting any that fail to close. |

## Calling pattern

```
host.workflow.run({ action, params })
```
`params` follows the chosen action's original schema; pass `{}` for no-arg actions.

- Discover what exists: `host.workflow.run({ action: "list", params: {} })`
- Start with arguments:
  `host.workflow.run({ action: "start", params: { name: "nightly-report", args: { scope: "release-1.2" } } })`
- Answer a script question: `host.workflow.run({ action: "reply", params: { runId: "wf_9", askId: "ask_2", answer: "retry" } })`

## Notes

- **Scheduler-side domain**: scheduler only — these actions are not in any Worker allowlist.
- **Events, not polling**: after `start` returns the runId, progress, pending questions, completion and failure arrive as orchestration events (kind `workflow`); no watching loop needed.
- **Re-run accounting (memo)**: keyed steps are remembered across restarts and resume without re-execution, but `wf.run` without a key plus `wf.tool`/`wf.read`/`wf.glob` re-execute on resume — a script must be idempotent or give `wf.run` a `key`.
- **Trust (TOFU)**: new or changed content needs business approval bound to its fingerprint; unchanged trusted content reuses trust without review; `validate`'s smoke import is real execution and passes the same gate (denial skips the import and notes it in the result's `exec` field; reviewer failures provide a human-handling path).
- **Guardrails**: at most 3 concurrent runs per workspace; per workflow `maxDelegates` default 10 (cap 30) and `maxHours` default 24 (cap 72, waiting-for-human time excluded).
- **User questions**: the default surface is the workflow panel (with desktop notification); `askHuman` only re-surfaces the same question — never rewrite or answer it for the user.
- Before writing a new workflow, read the authoring section below.

## 创作工作流

在当前工作区的 `.muster/workflows/` 下，每个子目录是一个工作流：`<名字>/WORKFLOW.md`（给调度看的说明）+ `<名字>/run.mjs`（机械步骤脚本）。
名字以小写字母或数字开头，最多 48 个字符，其余字符可用小写字母、数字和连字符。名字与目录名一致。工作流定义可随项目提交。

- 启动：调度对话框输入 `/workflow <名字> <参数>`，或由调度调用 `host.workflow.run({ action: "start", params: { name, args } })`；也可在 frontmatter 声明定时/事件触发。
- 新建：输入 `/workflow-new <想自动化什么>`，调度按本说明编写并校验，再向用户说明阶段、触发方式和何处需要判断。
- 首次执行或校验新内容版本时要过指纹绑定的信任审核。改了脚本或说明后须重新审核。调度输入栏旁的「工作流」面板可看运行进度、答复问你的问题、取消、信任/撤销信任。

### 分工原则

脚本只做**机械步骤**：派活、等事件、跑命令、读产物、汇总。
**需要判断时交还**：`await wf.ask(问题)` 挂起，调度被唤醒判断后答复；要用户拍板用 `wf.ask(问题, {to: 'human'})`（亮在工作流面板并桌面通知，用户直接答）。
脚本里不调模型、不猜意图。

### WORKFLOW.md

```markdown
---
name: review-then-merge
description: 派一个 Worker 实现，另一个厂商的 Worker 互审，通过后请用户确认合入
args: task, reviewer?
maxDelegates: 4
maxHours: 12
---

给调度的说明：何时用、每个 wf.ask 该怎么判断（判断标准写在这里，脚本里只放问题）。
```

- `args`：逗号分隔参数名，`?` 结尾为可选；启动时校验必填。
- `maxDelegates` / `maxHours`：本工作流的上限（默认 10 次 / 24 小时，宿主天花板 30 次 / 72 小时）。等人答复和应用关闭的时间不计入时长。

#### 触发（可选）

```yaml
schedule: daily 02:00
on: {"kind":"phase","trigger":"needs_you"}
cooldown: 30
```

- `schedule` 也支持 `weekly 1,3,5 09:30`（0 为周日）、`every 30m` 和 `every 2h`。`on` 是一行 JSON，语法同 `wf.waitFor`，事件作为 `args.event` 传入。`cooldown` 是事件触发冷却分钟数，默认 10。
- 只对**已信任的当前版本**生效：从未确认过的不触发（在工作流面板点「信任」）；确认过但改了内容的跳过并提醒调度。
- 声明 `schedule` 的工作流不能有必填参数；声明 `on` 的必填参数只能是 `event`。
- 不会被 `workflow` 事件或工作流自己派出的会话/任务的事件触发；同一工作流上一次触发的 run 还在跑时跳过；应用关着错过的定时，启动后最多补跑一次。

### run.mjs

```js
export default async function (wf, args) {
  await wf.phase('实现');
  const impl = await wf.delegate({ task: args.task, isolate: true, name: '实现' });
  const done = await wf.waitFor(
    { kind: 'phase', sessionId: impl.sessionId, trigger: 'needs_you' },
    { timeoutMs: 4 * 3600_000 }
  );
  if (done.timedOut) return { stage: '实现', timedOut: true };
  await wf.phase('互审');
  const review = await wf.delegate({ task: `评审会话 ${impl.sessionId} 的改动`, isolate: false, runtime: args.reviewer ?? 'claude-code' });
  const reviewed = await wf.waitFor(
    { kind: 'phase', sessionId: review.sessionId, trigger: 'needs_you' },
    { timeoutMs: 4 * 3600_000 }
  );
  if (reviewed.timedOut) return { stage: '互审', timedOut: true };
  const report = await wf.read('docs/review/latest.md');
  const go = await wf.ask(`评审结论：\n${report ?? '（没有报告）'}\n是否合入？`, { to: 'human', options: ['合入', '打回'] });
  return { decision: go };
}
```

### wf API

| API | 说明 |
|---|---|
| `wf.delegate({task, isolate, runtime?, name?, model?, thinking?, key?})` | 派一个 Worker（isolate 必须显式为 true 或 false，无 auto 或默认值；与 sessions.create 同管线，首次任务经邮箱保存）。排队时等到真正拉起才返回 `{sessionId, sessionName, taskId}` |
| `wf.waitFor(match, {timeoutMs?})` | 等一个事件。match 同订阅策略规则：`kind`（必填：phase / fact / turn_end / workflow …）、`trigger`、`sessionId`…；字符串字段可给数组表示任一。返回事件字段；超时返回 `{timedOut: true}`（不抛错）。等具体会话相位时先查会话现状，已满足立即返回 |
| `wf.ask(question, {to?, options?, multi?})` | 挂起并交还判断。默认问调度；`to: 'human'` 问用户（亮在工作流面板，答案原样回来）。有 options 时单选返回选项原文，`multi` 返回数组 |
| `wf.run(cmd, args?, {cwd?, timeoutMs?, key?})` | 跑命令（不给 args 时 cmd 按整行 shell 命令执行，可写 `wf.run(cmd, {key})`），返回 `{code, stdout, stderr}`；非零退出不抛错。带 `key` 时记账（重跑直接返回上次结果）。默认超时 10 分钟，最长 60 分钟 |
| `wf.tool(name, args)` | 调宿主工具；`name` 须为非空字符串，字面量 `workflow.run` 被拒绝，其余交由执行器处理（未知工具会报错）。调用边界见下文 |
| `wf.read(path)` / `wf.glob(pattern)` | 读工作区内文件（不存在返回 null，超 256KB 截断）/ 列匹配的相对路径（`**` `*` `?` `{a,b}`） |
| `wf.call(name, args)` | 调子工作流并等它结束，返回其结果（嵌套 ≤3 层；失败时抛错） |
| `wf.phase(name)` | 标记阶段（进 run 记录，调度下次被唤醒时捎带看到） |
| `wf.state` / `wf.checkpoint()` | 自定义进度对象（须可 JSON 序列化）/ 立即落盘 |
| `wf.log(text)` | 进度日志（不唤醒调度） |

脚本 `return` 的值是 run 结果（完成时唤醒调度）；抛错 = run 失败（唤醒调度）。

`wf.tool` 的边界：

- `workflow.run` 被拒绝以避免通过该入口启动工作流，受控子工作流用 `wf.call`。这不是完整的递归防护：执行器仍接受 `workflow.start` 和 `workflow_run` 等别名，可启动顶层 run 并绕过 `wf.call` 的嵌套限制；不要通过这些入口启动工作流。
- 危险工具仍走宿主安全审核；需人工确认时，若没人处理弹窗，run 会一直等待，同一工作流的定时触发在上一次触发的 run 未结束时会被跳过。
- 工具以调度身份和工作区作用域调用，不携带 Worker 会话身份。依赖 Worker 身份或活动回合的工具缺少上下文时会报错；`waitFor` 可为调度会话注册等待，`ui.render` 可使用调度会话身份，`turnChanges.trackFiles` 在存在调度活动审查回合时可能使用该回合，不能假定这些调用都会直接报错。
- 工具结果不记账，resume 会重新执行；脚本必须保证调用幂等。

### 必须可安全重跑

应用重启后，未结束的 run 会**从头重跑脚本**。宿主自动记账：`delegate / ask / waitFor / call`（以及带 `key` 的 `wf.run`）按「种类 + 参数 + 第几次出现」记下结果，重跑到同一步直接返回旧结果，不会重复派活或重复提问。因此：

- 步骤顺序要确定：不要用 `Math.random()`、当前时间、外部变化的数据决定**调用哪一步或传什么参数**。需要随时间变化的值，先 `wf.ask` 或存进 `wf.state` 再用。
- 不带 `key` 的 `wf.run` 与 `wf.tool` / `wf.read` / `wf.glob` **不记账**，重跑会再执行一次：命令要幂等（重复跑无害），或给 `wf.run` 带 `key`（跑过一次就不再跑）。读文件每次读最新内容正是想要的。
- 同一个任务说明派两次时给 `key` 区分（如 `key: 'round-2'`），否则会被当成同一步。
- 改脚本后，正在跑的旧版本 run 不会续跑（标记中断），需要重新启动。

### 不要这样写

- 在脚本里写判断逻辑去解析 Worker 的自然语言产出——读回来后交给 `wf.ask` 让调度判断。
- 用轮询代替等待：`while (true) { await wf.run('sleep 60') ... }`——用 `wf.waitFor`。
- 替用户做决定：合入、删除、对外发布之前用 `wf.ask(..., {to: 'human'})`。
- 把大段协议或文档内容写进 `wf.delegate` 的 task——给路径，让 Worker 自己读。
