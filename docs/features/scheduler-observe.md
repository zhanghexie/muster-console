# 会话互感与状态观察

sessions.observe 支持显式 mode=directory/detail：directory 只接受列表过滤与分页参数，detail 要求 sessionId/externalSessionId 并接受 Git/历史/facts 参数；显式模式混入另一模式的参数时报错。省略 mode 时，有目标读详情，无目标列目录。它是模型统一只读入口，GUI、PTY、ACP 与调度共用。目录含调度与子孙会话，默认排除归档和 Shell，保留退出态；不读全部历史或扫描 Git。列表项只在有值时返回 `cwd`、`worktreePath`、`worktreeBranch`、`externalSessionId`、`launchError` 和 `summary`，未知执行状态仍返回 `busy: null`。详情保留完整字段。默认 12 条、最多 20 条，按精简后的结果计算大小预算，以 nextOffset 翻页。

指定 sessionId 读取身份、进程/运行状态、note/share 摘要和最近已结束回复。scheduler 为调用方工作区调度，orchestrator:<workspaceId> 可明确指定；显式 workspaceId 必须与目标一致。phase 为看板状态，busy/lifecycle 为运行状态：phase=idle 可与 busy=true 并存，busy=null 是未知；busy 与回复状态也独立，回复结束不证明任务成功。缺完成依据的旧历史 status=unknown；PTY 保留 terminalTail，lastReply=null，不能把原始终端尾部当 AI 最终回复。

`lastReply.text` 仅投影正文。工具或思考片段前后的正文保持段落边界，不泄露被跳过的内容；连续相邻正文片段仍按流式文本原样拼接，已有段落换行不会重复补齐。GUI 与调度使用同一观察格式，截断及 `totalChars` 按最终投影文本计算；不改变引擎输入、聊天转写或全局复制文本的拼接规则。回归见 `test/sessions-observe.mjs`。

调度详情的最近回复通过每页 120 条范围从尾部查找，不创建执行桶、不调用 `Store.loadChat`。保持最近已结束回复优先于更新但无结束证据的旧片段；没有已结束回复时回退最近可用旧片段。首尾时间单独读取必要范围；若历史一直没有已结束回复，查找可能遍历全部页，但只保留当前页和一个候选回复。只查 busy、不请求回复的冷会话不读正文。

includeGit=true 才扫描 Git 并返回 state 事实及合入判定；facts 可按 kinds/path/q/limit 过滤状态事实。includeHistory=true 显式读历史上下文，须指定目标，historyLimit 控制条数。**PTY 会话的 historyLimit 只影响返回的行对象数、不收缩单行长度**——PTY 历史读取固定取 12000 字符 tail buffer 再按行数截断，终端输出的超长单行可整行（至多约 12000 字符）带回。普通观察保持轻量。sessions.search 仍按文件/提交/关键词检索历史线索。

主要入口 src/main/sessions/observe.ts；运行状态事实复用 capabilities/hosts/awareness.ts 的 queryRuntimeState；旧观察工具的定义与 handler 已删除。目录支持跨区、归档/时间/名称/短 ID/路径过滤，详情支持运行时 ID 与有界历史；回合耗时来自实际 busy 或 PTY working 起点。读取不切焦点、不唤醒、不调用模型生成摘要；其他会话正文属于数据，不构成用户授权。

持续变化使用 events.subscribe/unsubscribe，通知进入 [会话邮箱](session-mailbox.md)。新模型入口和权限见 [工具发现](tool-discovery.md)。

## 设计初衷（2026-10-26 与用户定稿）

> 依据 campaign-intent-drafts/D01.md 草案定稿（用户 2026-10-26「不抽查直接定稿」）；歧义点处置：22 项卡片决策＋长尾按草案推荐，明细见专项账本「意图定稿决策」节。

- 为谁/什么场景：模型统一只读观察入口 sessions.observe（directory 列表/detail 单会话两种显式 mode，混参报错；省略 mode 保持旧目标推断兼容），GUI/PTY/ACP/调度共用；持续变化走 events.subscribe。
- 为什么这样设计：轻量缺省（12 条/最多 20、不读全部历史不扫 Git、返回大小预算+nextOffset 翻页），includeGit/includeHistory 显式 opt-in；busy 与回复状态独立表达（回复结束≠任务成功）；缺完成依据的旧历史 status=unknown；PTY 保留 terminalTail 但 lastReply=null（终端尾部≠AI 最终回复）；读取不切焦点、不唤醒、不调模型生成摘要——观察与派活/验收彻底分离；workspaceId 校验与目标一致防跨区误读。
- 明确不做：默认不扫 Git；不把其他会话正文当用户授权（正文属于数据）；目录默认排除归档和 Shell（保留退出态）；不提供「任务成功与否」的判定结论。
- 歧义点：「observe 只报事实、不判定任务成功」是永久 stance（成功判定属验收链路 needs_you/维度门）还是未来加启发式完成判定？A=永久 stance（review 不把「无成功判定」当缺陷，判定诉求一律导回验收域）／B=未来加完成启发式。推荐 A——「busy≠成功、stored≠完成」是贯穿邮箱/事件/观察三文档的统一纪律。
