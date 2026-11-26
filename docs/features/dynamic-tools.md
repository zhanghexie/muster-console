# 动态工具 ext.*（已退役）

> **退役说明**：`dynamicTools` 能力域与扩展清单的 `tools` 声明已在「扩展单宿主收敛」中整体移除，不做旧兼容。本文仅作历史索引保留。

## 退役范围

- 清单合同（`src/shared/extensionManifest.ts`）不再接受 `tools`、`views`、`background`、`native`、`host`、`capabilities`、`hostTools`、`toolbar`、`schemaVersion` 等旧字段；携带这些字段的包会被校验器拒绝。
- `host.dynamicTools.run`（list/create/update/delete）与 `host.extensions.run` 的 `tools` / `invokeTool` / `run` 动作均已删除；调度常驻面不再注册 `ext.*` 动态工具。
- 实现模块 `extensionDynamicTools.ts`、`extensionToolSchema.ts`、`extensionBackgroundWorker.ts`、`extensionBackgroundRuntime.ts` 等已删除。

## 替代路径

扩展现在统一通过当前清单合同声明能力：

- 侧栏扩展用 `surface.kind=sidebar` + `domain`（DomainRuntime）+ `agent`，领域命令经 `domain.commands` 声明，由 Pi Agent 与面板共用同一 DomainRuntime 实例。
- 工具栏扩展用 `surface.kind=toolbar` + `commands` + `commandEntry`，命令在宿主拥有的独立进程执行。
- 创作、审核与安装统一走 `host.extensions.run` 的 inspect/create/write/submit/retryReview，审核通过后发布到源码布局并由 package catalog 登记。

作用范围、数据与审核见 [扩展工作台](extensions.md)；创作接口见 [扩展创作接口](extension-authoring.md)；工具面形态见 [宿主工具面](tool-discovery.md)。