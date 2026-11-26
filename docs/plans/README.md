# 方案与计划

计划正文顶部的 YAML `doc_type` 和 `status` 记录当前状态。

- `ready`、`in_progress`、`partially_implemented`、`needs_verification`、`decision_pending`、`awaiting_decision`：留在 `plans/` 根目录；部分完成与待验收不算已归档。
- `implemented`：实现完成且有功能文档、实施记录或验收证据后移入 `implemented/`。当前行为以 `docs/features/` 为准。
- `superseded` / `cancelled`：被新方案替代或明确取消后移入 `archive/`，保留历史决策。
- 复盘问题清单与进度账本可与计划同存，但用 `doc_type` 明确区分；纯内部代码审计放 `docs/audits/`。
