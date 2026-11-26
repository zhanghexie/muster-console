# 扩展 源码布局

当前扩展的全局扩展源码只保留一份。宿主按应用 profile 解析全局源码根，默认位置为 \`<userData>/extensions/global/<extension-id>\`。该根由 StoragePathManifest 的 \`extension-source\` 条目登记，路径统计和恢复诊断可复用同一入口。工作区只保存实例绑定、启用状态、审核指纹和数据目录，不复制全局源码。

项目扩展使用选中项目源码根下的 \`.muster/extensions/<extension-id>\`，项目包可随项目源码管理。旧版曾把次级项目的包写入工作区控制目录。如果这类包升级后无法在对应项目中找到，请核对清单的项目绑定，把旧包移到绑定项目的扩展目录。目标目录已有同名包时，先比较两份源码。

## 实现入口

- \`src/main/extensions/extensionSourceLayout.ts\` 提供 \`currentSourceLayout\` 和 \`currentGlobalSourceDirectory\`
- \`src/main/extensions/extensionPackageCatalog.ts\` 提供文件化的 package catalog 和实例指纹绑定
- \`global(id)\` 返回单一全局源码目录，\`copiedPerWorkspace\` 为 \`false\`
- \`project(controlRoot, id)\` 返回项目扩展目录，\`copiedPerWorkspace\` 为 \`true\`
- \`resolve({scope, extensionId, controlRoot})\` 根据清单作用域选择源码来源
- \`discover({scope, extensionId, controlRoot})\` 异步读取并校验 manifest、入口文件和 symlink，返回 \`Promise<package-extension>\` 指纹
- \`currentPackageCatalog.scanGlobal()\` / \`scanProject(controlRoot)\` 异步扫描源码根并返回有效包及逐包错误，不复制源码
- \`currentPackageCatalog.syncGlobal()\` / \`syncProject(controlRoot)\` 异步同步记录并清理已经删除的包，导航通过防抖 stale-while-revalidate 刷新，不在同步 peek 中扫盘
- \`currentRunningPackageVerifier\` 为运行中实例缓存 package fingerprint，使用 fs.watch 失效提示、并发 discover 合并和不支持递归 watcher 时的异步轮询兜底
- \`currentPackageCatalog.register()\` 记录包指纹和目录，\`bindInstance()\` 只允许已登记指纹绑定工作区实例

该模块是 registry/source discovery 的基础合同。catalog 只保存目录、版本、菜单和指纹，不保存源码副本。启动时先确保内置日报 包可用，再扫描全局目录和当前项目目录。

路径解析会校验扩展 ID，并拒绝从源码根逃逸。全局根可显式注入，便于开发沙箱、测试和未来安装器提供独立源码目录。

## 扩展中心目标布局

扩展中心实施后，安装作用域统一为应用 profile。中心 release 使用不可变版本目录，本地开发包使用单独的开发目录登记，工作区只保存 `packageKey` 的激活记录：

```text
<userData>/extensions/
  packages/<publisher>/<extension>/<version>/<fingerprint>/
  dev/<publisher>/<extension>/
  registry-v2.json
  workspace-activation.json
```

`scope=project` 不再用于新安装。项目源码根仍可作为当前工作区的运行上下文和数据绑定来源。现有项目包迁移为全局 `local-dev` 记录，并按迁移前可见范围生成工作区激活记录。完整方案见 [扩展中心与工作区激活](extension-center.md)。



