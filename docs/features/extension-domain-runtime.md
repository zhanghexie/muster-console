# 扩展 DomainRuntime 注册层

## 职责

`ExtensionDomainRegistry` 为 sidebar 扩展维护实例级 DomainRuntime。宿主按扩展 ID 与包指纹注册 runtime factory，按工作区、实例 ID、表面和包指纹打开唯一运行时。主界面和 Extension Agent Session 共享同一实例。

## 关键入口

- `src/shared/extensionDomain.ts`：实例身份、快照、事件、查询和命令上下文。
- `src/main/extensions/extensionDomainRegistry.ts`：factory、实例、查询、命令、事件和关闭。
- `src/main/extensions/extensionIsolatedRuntime.ts` / `extensionRuntimeWorker.ts`：受认证的父子进程 RPC、worker broker 增量与取消。
- `test/extensions-domain-domain-registry.mjs`：复用、身份、队列、事件与关闭。
- `test/extensions-domain-isolation.mjs`：真实 worker、broker、流式增量与取消。

## 运行与边界

每个实例的 mutation 经宿主队列串行执行，`expectedVersion`、execute、版本时钟和 requestId 缓存位于同一执行段；失败不污染后续队列，snapshot/query 等待已入队 mutation。领域事件只描述状态变化；流式文字增量通过独立 broker 消息回调，不伪装成领域事件。

包内 DomainRuntime 和 toolbar command 由独立 Node worker 执行，Electron 主进程不 import/execute 扩展模块。worker 的进程组或 Windows Job 由 `spawnOwnedProcess` 管理；关闭、reload、崩溃与取消进入回收屏障。factory 注册返回 unregister 句柄，并按 package fingerprint 生命周期清理。所有扩展通过通用 broker 使用宿主能力；日报的数据/日志/通知也走相同合同，不再有专用 host adapter。

DomainRuntime 入口使用 `resolveLiveExtensionBinding` 生成规范化的 workspace/root、包指纹、activation、trust 和 project binding。`rootsRevision` 与 catalog/trust 状态可通过返回的 `assertCurrent()` 在长操作边界重新核对，避免 Domain、toolbar 和面板资源路径各自维护一套 live binding 规则。
