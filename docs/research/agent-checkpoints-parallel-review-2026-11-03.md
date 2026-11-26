# Agent 文件审阅与并行回退方案对比

2026-11-03。结论：MetaAgent 的轮次快照、保守归属与逐文件回退适合辅助审阅；共享目录中的并行写入仍有覆盖、混合 Diff 和回退被阻止的问题。快照保存状态，工具事件提供归属证据，worktree 隔离执行现场，这三者不能互相替代。

## 竞品公开机制

| 产品 | 审阅与恢复 | 并行边界 |
|---|---|---|
| ZCode 本地源码 `872ad960` | 自有工具写前读原文并传 expectedRevision；成功结果生成单文件 artifact，轮内聚合；另有独立 index 的 Git checkpoint 服务 | 写前版本校验并非原子锁；回退 apply 存在计划检查后无版本条件写回的窗口，受控生产函数探针已复现。详见下方源码报告 |
| Claude Code | 每个启动回合的 prompt 建 checkpoint，追踪文件编辑工具；可分别恢复代码和对话。纯 Bash 修改的新路径不被追踪；已追踪文件后续受到的 Bash 或外部修改可能落入恢复范围 | 官方推荐独立会话使用各自的 Git worktree |
| Cursor | Agent 自动建立本地 checkpoint，与 Git 分开；恢复文件不删除聊天消息 | Agents Window 支持每个任务独立 worktree，完成后审阅与带回主工作区 |
| Cline | 在独立 shadow Git 仓保存工具操作后的工作区快照，可比较和恢复代码/任务；官方提示大仓库可能增加存储和耗时 | 工作区快照本身不能证明每项变化来自哪个会话；此为机制推论，未验证其当前多任务实现 |
| Codex | 审阅面板支持 Unstaged、Staged、Commit、Branch、Last turn；普通仓库视图包含人工与其他未提交变化；支持逐文件/逐 hunk 操作 | 提供独立 worktree 运行会话；AI `/review` 与文件 Diff 面板是不同能力 |

官方资料：

- [Claude Code checkpointing](https://code.claude.com/docs/en/checkpointing)
- [Claude Code parallel sessions](https://academy.claude.com/courses/ai-native-sdlc-playbook/parallel-sessions-and-subagents)
- [Cursor Agent checkpoints](https://cursor.com/docs/agent/overview)
- [Cursor worktrees](https://cursor.com/docs/configuration/worktrees)
- [Cline checkpoints](https://docs.cline.bot/core-workflows/checkpoints)
- [Codex code review](https://learn.chatgpt.com/docs/code-review?surface=app)
- [Codex worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees)

以上是官方公开契约，不表示已检验闭源产品内部存储、锁或竞态实现。Cline 的 shadow Git 机制由官方文档明确描述；不能据此推断其他产品采用同一存储方式。

ZCode 行来自本地固定 revision 的直接源码复核，不代表网上最新版。实现路径、与 Git 服务的区别及受控竞态实验见 ZCode 源码报告第 8 节。

## MetaAgent 当前方案判断

当前实现见 [轮次文件改动与 checkpoint](../features/turn-checkpoint.md)。`src/main/turnChanges/service.ts` 的 `begin` 冻结已完成基线，工具事件验证意图、原文和指纹，`finalize` 聚合净变化并持久化，`restore` 再检查当前现场。GUI 的 `host/fileChanges.ts` 把采集错误与引擎生命周期分离。`ipc.ts` 从当前消息解析快照身份，renderer 不提供任意恢复正文。

这些选择合理：保留轮前脏内容、不污染用户 Git index/历史；冷基线不伪造原文；有 Diff 不等于有撤销权限；并行碰撞、迟到事件与后续人工编辑令回退保守失败。共享增量缓存降低重复采集成本，但本次未做多会话性能测量，不能据此声称高并发性能达标。

目前仅保留会话最新可用非空快照，支持受限文本范围，Codex 路径事件和 Shell 等缺少完整意图时通常只能展示。这适合“最近一轮辅助审阅”，不能描述为完整任务历史或通用撤销系统。

## 多会话共用目录会发生什么

| 场景 | 当前行为与影响 |
|---|---|
| 两个已观测工具修改同一文件 | `toolStart` 比较活动 tracker 的物理路径，双方标记 unsafe 并通知；工具仍会执行，后写者仍可能覆盖先写者 |
| A 使用 Shell，B 在同一范围修改文件 | A 的轮末 `view.changed(current)` 可能包含 B 的变化，标记来源未确认；快照不能当作 A 的专属交付清单 |
| A 结束后，B 又修改同一文件 | A 的回退校验哈希与文件指纹，跳过已变化文件；即使内容相同，指纹变化也可拒绝恢复 |
| A 要回退，B 在同一根目录工作但只改其他文件 | `restore` 按活动 tracker 的整个 root 检查，会暂时阻止 A 的回退；是保守范围选择，非逐文件写锁 |
| 两个工具在同一主进程之外并行 | active 集合不跨应用进程；不能承诺及时碰撞提醒，外部同文件改动主要依赖内容/指纹校验 |
| 独立 worktree | 任务文件现场分开，不会因正常相对路径写入而互相覆盖；合并仍有内容和语义冲突，端口、数据库与其他外部资源需另行隔离 |

例：A、B 都从 `old` 开始，A 写成 `A`，B 再写成 `B`。当前碰撞提醒能阻止随后把该文件自动回退到 `old`，但不能让已被覆盖的 `A` 自动重新出现。回退安全不等于写入安全。

## 建议

保留现有审阅核心。独立并行开发优先复用已有的宿主 worktree 隔离能力；共享目录适合只读任务或明确分工、愿意接受交叉影响的协作。不为已有任务自动迁移或创建隔离目录。

界面应清楚区分“已确认工具改动”“期间观测到的变化”和“当前仓库未提交变化”。尤其 Shell 扫描结果不应让用户理解为当前 Agent 的独占成果。碰撞提示应明确表示仍可能覆盖，不暗示已经拦截。

暂不建议把目录级回退门直接放宽到 touched 文件：Shell、迟到事件和未知工具尚未报告的写入无法靠 touched 集合覆盖。若要提升可用性，应先建立可靠写入登记、回退互斥和事件缺失时的保守策略；对任意外部进程仍不能承诺事务安全。

完整任务历史、逐 hunk 回退、扩大非文本支持可另行设计，不能通过删除归属/指纹检查实现。大仓库性能优化须同时测采集字节、枚举路径、Git 调用与主线程阻塞，而非只检查最终 Diff 正确。

## 本次验证

- `node test/turn-changes.mjs`：18 个场景通过，包含脏基线、同文件并行、不同文件不误报、Shell 未确认改动、人工后续修改、活动回合回退阻止及链接保护。
- `node test/turn-changes-collisions.mjs`：双方通知、会话名、按回合对去重和已移除消息保护通过。
- Windows 本地真实文件系统测试；工具事件为确定性模拟，通知出口为 mock。未运行真实模型多会话、Electron UI、macOS/Linux 真机或性能压力测试。
- 本次只新增调研文档和索引链接，没有修改产品代码。调研索引已有合并标记，本次保留原现场。
