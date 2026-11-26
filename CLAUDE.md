# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

仓库约定以根 AGENTS.md 为准。

## 指路

- **产品定位、布局与运行速览**：根 `README.md`
- **能力地图与全部文档索引**：`docs/README.md`；功能实现说明在 `docs/features/`（探索/改代码前先读对应文档）
- **全局规约与用户设定**（宿主开发、跨平台、动画、测试、Shell 重定向等）：根 `AGENTS.md`
- **测试体系与常用命令**：`docs/features/testing.md`

## 项目速览

Muster 工作台（muster-console）：跨平台 Electron 桌面应用（Windows、macOS、Linux），带真聊天调度 Agent 的 Agent 管理工作台。三层结构：`src/main/`（能力执行、编排、Shell API，含 `.muster` 脚手架 `metaAgent/`）、`src/preload/`（contextBridge）、`src/renderer/`（React UI）。GUI 聊天会话 driver 位于 `src/main/agentSession/drivers/`：acp、claude、codex、externalPi、muse、pi、win32、zcode；内置 CLI runtime 注册表与拉起脚本在 `src/main/runtime/builtins/`。架构细节以 `docs/README.md` 能力地图与对应功能文档为准。

- 仓库文档与注释以中文为主。
- `.muster/` 下 `runtime.json`、`local/` 等本机状态禁止读写。
