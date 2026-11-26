# CodeGraph 代码分析（已删除）

已完整移除 codeAnalysis.*、CodeGraph 服务/SDK、索引扫描与 watch、工作区索引配置/进度 UI、IPC/preload/事件、编辑器基于索引的定义/引用菜单，以及专属依赖和打包配置。

普通文件编辑、保存、文件/文本搜索、Markdown 文件链接与行号导航继续存在；没有引入 LSP 或其他索引替代。旧配置不再进入活动工作区配置；用户原有 .codegraph/codegraph.json 本轮不删除。

关键验证是 FileEditor 与 CreateWorkspaceModal 的真实组件回归、工作区配置兼容及依赖/目录退役检查。更多宿主能力见 [工具发现](tool-discovery.md)。
