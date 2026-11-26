---
doc_type: feature
---

# 扩展激活与运行校验

## 内置扩展

`extensionAppSystem.ts` 从应用安装包的 `resources/extensions` 装入日报。未打包的开发应用使用 Electron 应用根目录下的 `resources/extensions`。`ExtensionCenterService` 核对全局注册目录和整包指纹，确认 profile 中的副本与应用资源一致后才允许直接运行。首次启动可离线打开工作日报。已有完全匹配的副本沿用同一校验。

## 本地扩展

在「扩展管理」中启用本地包时，`extensions:setEnabled` 或 `extensions:setEnabledAll` 经 `ExtensionManagementService` 为所选工作区记录运行许可及启用状态。项目包按当前选择的项目根解析。同名包的许可按作用域和绝对包目录区分。通过投稿流程试装的包在独立试装 profile 中启用。

发行版的运行许可绑定启用时的包指纹，换用其他内容后可在扩展管理中启用当前版本。显式启动的未打包开发环境允许已启用目录内继续迭代源码。侧栏和顶栏在执行前通过 `resolveLiveExtensionBinding` 核对工作区、包指纹及运行许可。运行中的资源请求和领域调用会复核指纹。开发态重新打开或重载面板时重新绑定当前内容。

## 权限与兼容

`ExtensionDevelopmentTrustStore` 兼容旧 profile 的开发目录授权。新启用的本地包记录在 `activations`，运行检查可使用该记录，MCP 授权继续由既有显式授权检查。扩展中心的发布身份、清单权限和危险操作确认各有校验入口。

## 验证

`test/extensions-center.mjs` 覆盖随包日报和同名改动副本的区分。`test/extensions-domain-development-trust.mjs` 覆盖旧记录兼容、启用许可持久化、开发源码迭代和 MCP 授权边界。Electron 验证见 `test/e2e/extensions-daily-panel.spec.ts` 和 `test/e2e/extensions-build-package.spec.ts`。

