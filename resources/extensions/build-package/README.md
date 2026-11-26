# 一键打包

## 安装

「一键打包」只在绑定本仓库的项目里可见。安装副本位于 `.muster/extensions/build-package`，仓库的 `.gitignore` 已排除该目录。

1. 在以本仓库为管理根的 Muster 项目会话中，用 `host.extensions.run` 执行 `inspect`，确认项目绑定为 `{ "kind": "relative", "path": "." }`。
2. 用 `create` 创建 `{ "id": "build-package", "scope": "project" }` 草稿。若已装项目副本，先 `list` 获取该副本的指纹，再把它作为 `expectedFingerprint` 传给 `create`。
3. 用 `write` 将 `resources/extensions/build-package/` 下的 `extension.json`、`command.mjs` 和 `README.md` 逐个写入草稿。用 `submit` 提交整包审核，返回 `published` 后即可在「扩展管理 → 项目扩展」里找到它。
4. 选择本项目，确认「一键打包」处于启用状态，再点击顶栏按钮。如果宿主要求开发信任，检查扩展源码后选择「信任并运行」。授权对该目录长期有效，宿主会继续本次操作。

## 从按钮到终端

1. 扩展从绑定项目读取 `package.json`，在输入框预填下一 patch 版本。`1.2.3` 预填 `1.2.4`，`1.2.3-beta.1` 预填 `1.2.3`。可输入正式版或预发布版，`+build` 元数据会被拒绝，因为 npm 会丢弃它。
2. 选择 macOS、Windows 或 Linux。当前系统排在第一项并标为默认，宿主单选框需要实际点选。
3. 确认弹窗展示 `npm version <版本> --no-git-tag-version && npm run build:<平台>`。版本相同只显示 `npm run build:<平台>`。任一弹窗取消或拒绝，项目版本保持原样，也不会打开终端。
4. 确认后，扩展复查项目版本及目标脚本，并检查 `node_modules/electron-builder`。检查失败会在顶栏显示错误。缺少脚本时请补齐 `package.json` 的对应项，缺少依赖时请在绑定项目运行 `npm install`，然后重试。
5. 扩展在绑定项目打开可见终端并提交命令。终端显示 npm 和打包脚本输出。如果版本更新失败，命令链停止。如果版本已更新后打包失败，更新后的版本会留在项目里。

| 目标平台 | 项目脚本 | 在该系统运行扩展时的 Shell |
| --- | --- | --- |
| macOS | `build:mac` | `zsh` |
| Windows | `build:win` | `powershell` |
| Linux | `build:linux` | `bash` |

Shell 由运行 Muster 的系统决定。Windows 终端通过 `cmd.exe /d /s /c` 执行预览中的命令，以兼容 Windows PowerShell 5.1。Node.js 和 npm 需要能从所选 Shell 的 `PATH` 找到。若宿主提示缺少 Shell，请安装或恢复该系统对应的 Shell 后重试。跨平台产物取决于项目脚本和 electron-builder 的构建环境。
