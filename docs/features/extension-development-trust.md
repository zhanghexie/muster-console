---
doc_type: feature
---

# 扩展开发态信任

`src/main/extensions/extensionDevelopmentTrust.ts` 提供开发态扩展的显式信任记录。

## 信任模式

- `trusted-once` 只保存在当前宿主进程内，清理后需要重新确认。
- `trusted-persistent` 写入应用 profile 的 `extensions/development-trust.json`，绑定扩展 ID、作用域和绝对源码目录。目录内源码反复修改时，持久信任继续有效。
- 撤销信任按扩展 ID、作用域和源码目录匹配。每次打开仍重新解析 Manifest、计算当前 `package-extension` 指纹并做权限校验。

信任记录表达开发者对目录和指纹的确认。Manifest、能力声明、运行时权限和高风险操作仍按各自规则校验。`resolveLiveExtensionBinding` 在加载侧栏或顶栏运行时之前检查开发信任。已信任的开发包会把实例 MCP 映射为当前会话的 `trusted-once`，仍经过运行时权限校验。宿主每次资源请求和领域调用都会复核指纹，运行中修改包内容会返回冲突并拒绝继续执行。

`ExtensionHost` 将信任状态挂到侧栏面板身份上，并通过 `extensionCatalog:trustStatus`、`extensionCatalog:trust`、`extensionCatalog:revokeTrust` 和 `extensionCatalog:listTrust` 提供查询、授权和撤销入口。侧栏遇到开发信任要求时提供「信任开发目录」按钮。关闭后重新打开面板会在同一受信任开发目录下绑定新指纹。

顶栏的 `extensions:runToolbar` 将宿主抛出的 `ExtensionDevelopmentTrustRequiredError` 转为 `development-trust-required` 结果。`ExtensionChromeActions` 收到该结果后打开 `AppConfirmDialog`。确认后以 `trusted-persistent` 授权，并按原工作区、源根、选择版本和菜单命令重试一次。项目授权通过工作区 ID 和源根 ID 解析源码目录。取消会结束本次操作，授权或重试失败时顶栏显示实际错误。

## 与扩展中心审核的边界

扩展中心审核属于 release 发布流程，本机开发信任属于是否允许当前设备执行开发目录的运行边界。扩展中心包通过签名和摘要校验获得发布身份，本地开发包不需要中心审核，但仍需要 Manifest、权限、指纹和开发信任校验。两类状态分别保存，不用本机信任记录代替中心发布凭据。

## 验证

`test/extensions-domain-development-trust.mjs` 覆盖一次性信任、持久化恢复、撤销、指纹校验和绝对路径校验。`test/extensions-domain-host.mjs` 覆盖未信任包拒绝运行和运行中 fingerprint 变化拒绝资源/调用。

`test/unit/extensions-toolbar.spec.tsx` 和 `test/unit/extensions-ipc.spec.ts` 覆盖顶栏授权、取消、重试和错误分类。`test/e2e/extensions-build-package.spec.ts` 从实际工作台打开项目扩展，验证授权后可继续打包流程。



