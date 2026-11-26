# 按线索找会话（sessions.search）

多 Agent 感知第 4 事：按文件路径 / 提交 / 关键词检索历史会话，命中后用 `sessions.observe({sessionId,includeHistory:true})` 读上下文。第一期无向量库。

## 职责

| 工具 | 用途 | 权限 |
| --- | --- | --- |
| `sessions.search` | 只读 grep 落盘转写 + 会话元数据，返回会话列表（工作区/时间/摘要） | read |
| `sessions.observe({sessionId,includeHistory:true})` | 对命中会话按尾页读最后 N 条纯文本 | read |

sessions.observe 用短 ID、worktree 路径和名称过滤当前会话；search 扫描已落盘的历史转写正文。

## 范围

- **默认当前工作区**（与会话观察默认范围一致）。
- `workspaceId=*` 或 `all`：本机全部已打开工作区。不扫其他机器、不扫已关工作区的磁盘外历史。
- **含归档**、**不含 hidden**（内部会话服务列表已滤 hidden）。
- 不 `select`、不抢焦点、不写盘。

## 语料

- GUI：经 `getHistoryRange` 按120条页读取当前事件投影/检查点，按消息原始顺序消费正文和工具入参/输出/patch；不先加载完整会话或trace，路径常在工具卡。
- 元数据：名称、cwd、隔离树路径/分支。
- pty：一期无落盘转写，只搜上述元数据。
- 历史观察由`src/main/sessions/history.ts`反向读取有界页，最多保留40条候选并按8,000字符输出预算截断；范围空壳不占观察行，失败/中止证据保留。

## 匹配

- `path`：正反斜杠等价、大小写不敏感；完整相对路径或文件名。
- `commit`：≥7 位哈希子串，大小写不敏感。
- `q`：关键词子串，大小写不敏感。
- 多条件**取交集**。`path` / `commit` / `q` 至少传一个。
- 条数 1–50，缺省 20；按 `lastUsedAt` 新→旧。

## 关键文件

- `src/shared/sessionSearch.ts` — 纯函数（解析/拼语料/匹配/摘要）
- `src/main/capabilities/hosts/sessions.ts` — `sessions.search` handler
- `src/shared/hostTools/meta.ts` 组 `observe`（pty / gui / acp）
- Catalog v1.65.0（`src/main/capabilities/catalog/types.ts` 的 `CATALOG_VERSION`）
- 测试：`test/sessions-search.mjs`

## 已知边界

- 无向量语义检索；拼写变体靠子串。
- 单会话语料最多200,000字符；会话按最近使用时间优先，最多300个/总计4,000,000字符，预算用尽即停止后续读页。达到全区预算返回truncated，不声称检索了全部历史。单条消息自身仍可能较大。
- pty 历史对话不在语料里（只有名称/cwd/树）。
- 与并行的自定义事件注册/审核单无契约交集（本工具挂 `sessions` host，不改 `tools.ts`）。

## 设计初衷（2026-10-26 与用户定稿）

> 依据 campaign-intent-drafts/D03.md 草案定稿（用户 2026-10-26「不抽查直接定稿」）；歧义点处置：22 项卡片决策＋长尾按草案推荐，明细见专项账本「意图定稿决策」节。

- 为谁/什么场景：多 Agent 感知第 4 事——调度/Worker 按文件路径、提交、关键词找回历史会话，命中后 observe 读上下文；默认本工作区，workspaceId=* 扩到本机已打开区。
- 为什么这样设计：只读 grep 落盘转写（GUI json 语料含工具入参/输出，路径常在工具卡）+会话元数据；无向量库、子串匹配、200KB 截断，把成本压在纯函数（src/shared/sessionSearch.ts）上；不 select、不抢焦点、不写盘，保住「观察工具」语义。
- 明确不做：向量/语义检索；pty 会话正文检索（一期无落盘转写，只有名称/cwd/树）；已关工作区的磁盘外历史、其他机器；hidden 会话。
- 歧义点：pty 正文不可检索是一期边界还是长期接受？A=长期接受（review 对 pty 覆盖最多记 P3）／B=规划补落盘（review 要关注 pty 转写落盘的存储与隐私面）。推荐 A——GUI 是主感知面，pty 是交互终端形态。
