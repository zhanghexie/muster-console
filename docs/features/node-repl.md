# node-repl 持久代码执行

> zcode-adopt-batch-d S2.2/T2。每会话一个持久 NodeReplSession，跨调用 globalThis；
> generation 单调防 ABA；超时/取消重建执行内核。工具面 `node_repl.js`（label 用用户语言）。
> 2026-09-27 复审改版：执行内核从主进程 vm 迁至 worker_threads Worker。

## 职责

- **持久会话**：同一 GUI Worker 会话内多次调用共享同一 Worker 全局——`globalThis` 赋值、
  `var` / `function` / `class` 声明、顶层 `const`/`let`（经 instrument 改写为 globalThis 赋值）均跨调用保留。
- **独立执行内核（worker_threads）**：代码跑在专属 Worker 里（`new Worker(source, {eval:true})`，
  源码内嵌免打包额外文件）。超时/取消由主进程 `worker.terminate()` **硬杀**——同步死循环与
  异步微任务死循环（`for(;;) await Promise.resolve()`）都能被杀，不再依赖主进程事件循环
  （旧 vm+宏任务轮询实现会被微任务饿死、冻结整个 App）。
- **generation 防 ABA**：每次 reset（超时/取消/terminate）generation 单调 +1 并重建 Worker；
  旧绑定/定时器随 Worker 线程消失。迟到结果携带旧 generation，调用方可用 `isCurrentGeneration` 判串线。
- **超时/取消契约**：单次执行缺省 60s / 上限 120s（`resolveNodeReplTimeoutMs` 钳制）。
  触发即 kernel reset，结果明示「上下文已重建」（不静默重建，防模型连环 ReferenceError）。
- **并发串行化**：同一会话的并发 run 排队执行（共享全局不互相污染）；下一次 run 先等待旧 generation 的真实 terminate 结果，避免两个内核重叠。
- **退出屏障**：dispose 同步停止受理、使旧 generation 失效，异步等待所有已退役 Worker 的真实退出和已受理队列收口。排队工作在销毁后只返回取消，不重建 Worker；迟到结果也不能变成新 generation 的成功。terminate 失败保留线程 owner 可重试，不吞错或直接从 manager 删除。
- **console 上限**：Worker 侧行数（500）/字符（64K chars，中文按 UTF-8 实占约 128KB）双上限截断；所有终态路径（含 error）都带回并清空，失败调用的输出不串进下一次结果。
- **工具面**：`node_repl.js`（`shared/nodeRepl.ts` 的 `NODE_REPL_TOOL_ID`，host 工具面唯一
  注册名；投影路由按清单精确解析，`node_repl_js` 等下划线变体不是别名），
  label/description 用户语言、禁 js/node_repl 实现术语进 title。权限类 `shell`
  （完整 Node 权限，与 Bash 同审批语义）。

## 关键文件

| 文件 | 职责 |
|---|---|
| `src/shared/nodeRepl.ts` | 纯函数合同：超时钳制、generation 判定、reset 指引文案、输出截断、工具 label/description（零依赖，不 import i18n） |
| `src/main/nodeRepl/session.ts` | `NodeReplSession`：Worker 生命周期（ref/unref/terminate）、generation、instrument 顶层声明、run（超时/取消/串行队列/exit 兜底） |
| `src/main/nodeRepl/manager.ts` | 每会话注册表（sessionId → session）；异步 dispose，失败保留 owner，disposeAll 停受理并聚合全部退出结果 |
| `src/main/agentSession/tools/nodeRepl.ts` | GuiHostTool 装配（参数校验 + 结果文案）+ dispose 出口（`disposeNodeReplSession`/`disposeAllNodeRepl`） |
| `src/main/agentSession/host/lifecycle.ts` | 会话关闭 → await `disposeNodeReplSession`（同其它资源并行收尾，失败仍继续持久化释放） |
| `src/main/index.ts` | Runtime Kernel 的 node-execution 域及根 scope → await `disposeAllNodeRepl` |
| `src/shared/hostTools/meta.ts` | 工具元数据（组 `repl`，permissionClass `shell`，preset `gui-full`） |
| `src/main/agentSession/tools/registry.ts` | 挂进 GUI Worker 会话工具集 |

## 数据流

```
模型调用 node_repl.js {code, timeoutMs?}
  → tools/nodeRepl.ts（校验 + resolveNodeReplTimeoutMs）
  → NodeReplManager.getOrCreate(sessionId) → NodeReplSession.run(code, {timeoutMs, signal})
      排队（同会话串行）→ instrument 顶层声明 → postMessage 进 Worker
      Worker：console 截断捕获 + 间接 eval 进 Worker 全局 + await 异步完成值 → 回包
      主进程 timeout/abort → worker.terminate() 硬杀 → generation+1 → 结果带 kernelReset + 指引
      Worker 意外退出（用户代码 process.exit()）→ error + kernelReset + 指引
  → 文本回执（generation 标注 + 展示值/console/错误或 reset 指引）
```

## 已知边界

- 顶层 `const`/`let` 多绑定与解构不改写（仍为脚本作用域，下次调用不可见）——合同在工具描述中写明。
- 顶层 `await` 不支持（脚本模式语法限制）；异步用 Promise 完成值（run 会 await）。
- instrument 是启发式扫描器（不识正则字面量；`const x\n= 5` 换行声明可能误改写）——复杂声明形态以单绑定单行为宜。
- Worker 不是安全沙箱（代码有完整 Node 权限）：隔离由权限审批层承担（permissionClass=shell）。
- terminate 是硬杀：超时/取消后 Worker 内全部状态（含异步回调现场）丢失，即「上下文已整体重建」语义。
- REPL 状态进程内易失，不落盘；重启即空。

## 测试

- `test/node-repl.mjs`：纯函数（钳制/判定/文案/工具面）· instrument · 跨调用状态 ·
  generation 防 ABA · 超时/取消 · 异步完成值 · 脚本错误不重建 ·
  异步微任务死循环硬杀 · process.exit 自杀 · error 路径 console 不串台 ·
  console 双上限截断 · 并发串行化 · manager dispose。
- `test/node-repl-disposal.mjs`：真实线程退出前屏障不完成、dispose 后迟到调用和排队拒绝、terminate 失败保留 owner、兄弟线程仍清理、重试成功、失败退出后的迟到结果不得成功。Windows 真实 Worker 验证不替代 macOS/Linux 真机。

## 设计初衷（2026-10-26 与用户定稿）

> 依据 campaign-intent-drafts/D04-D05.md 草案定稿（用户 2026-10-26「不抽查直接定稿」）；歧义点处置：22 项卡片决策＋长尾按草案推荐，明细见专项账本「意图定稿决策」节。

- 为谁/什么场景：GUI Worker 会话内的持久 Node 代码执行（数据处理、快速验证、胶水脚本），同会话跨调用共享 globalThis；PTY/ACP/调度无此工具（GUI_ONLY preset 已核）。
- 为什么这样设计：worker_threads 独立内核让超时/取消可 terminate 硬杀（旧 vm+宏任务轮询会被微任务死循环饿死、冻结整个 App 的实证教训）；generation 单调防 ABA 串线；重置结果明示「上下文已重建」不静默重建（防模型连环 ReferenceError 误判状态还在）；console 双上限截断、失败调用的输出不串进下一次结果；同会话并发 run 串行排队防全局互相污染。
- 明确不做：不做受限沙箱内核（代码有完整 Node 权限，隔离由 permissionClass=shell 审批层承担，与 Bash 同语义）；顶层 const/let 多绑定/解构不改写、顶层 await 不支持（合同写在工具描述里）；REPL 状态进程内易失不落盘，重启即空；terminate 硬杀后异步回调现场全丢（「整体重建」语义）。
- 歧义点：「无沙箱+shell 同档审批」是长期安全模型吗：A=长期（review 把「REPL 有完整 Node 权限」当已知边界不当 finding；审批层放行缺口才是缺陷）／B=未来做受限执行内核（无 fs/net 的轻 REPL）。推荐 A——受限内核掏空其核心价值（完整 Node 生态/文件处理），且与 Bash 同档审批已保持一致。
