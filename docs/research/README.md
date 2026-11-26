# 外部项目与工具调研

这些文章记录公开项目、工具和方案的对比，以及对 Muster Console 的设计启发。实现现状见[文档总索引](../README.md)。

- [dsh-im 多渠道接入方式与本仓移植可行性调研（2026-11-16）](dsh-im-multi-channel-integration-research-2026-11-16.md)：归一化渠道适配器、公共会话桥、凭据与状态隔离、连接监督，以及与本仓飞书桥、Agent Apps 和扩展运行时的差距。

- [开源 README 差距分析（2026-11-10）](open-source-readme-gap-analysis-2026-11-10.md)：对照 OpenHands、Cline、Open WebUI、Aider 的首屏定位、语言、安装、截图、代码入口、社区和发布信号，并记录本次 README/贡献流程落地项。

- [Agent 文件审阅与并行回退方案对比（2026-11-03）](agent-checkpoints-parallel-review-2026-11-03.md)：Claude Code、Cursor、Cline、Codex 官方机制及工作台共享目录并行边界。

- [开源工具的 GitHub PR 审查接入（2026-11-24）](github-pr-review-integrations-2026-11-24.md) — CLI 与原生 API 凭据、桌面端评审、Webhook 和 Actions

- [DeepSeek Harness 插件发布与目录维护（2026-11-19）](deepseek-harness-plugin-distribution-2026-11-19.md) — 官方插件列表、Git/npm 安装、静态索引生成和 dsh.pub 仓库链接投稿

- [多模型 Harness 的思考选项与目录分发（2026-11-18）](model-reasoning-catalog-research-2026-11-18.md) — Pi、OpenCode、Crush 与 DeepSeek Harness 的档位来源、隔离验证及独立 Git 仓库和静态分发选型

- [GitHub 反馈收件选型（2026-11-16）](github-feedback-intake.md) — 公开发布后的匿名查重、网页提交和应用内提交取舍

- [Magpie 技能、MCP 与子代理研究（2026-11-11）](magpie-library-capabilities-2026-11-11.md) — Library 归属账本、Skill router、MCP router 按需工具、原生子代理投影及工作台对照

- [跨 Harness Skills / MCP 管理实现深研（2026-11-06）](cross-harness-skills-mcp-implementation-2026-11-06.md) — 12 个固定 commit；中央库、声明生成与运行时网关；源码写入/归属/清理边界、Vercel API 发布差距及函数级实验

- [Computer Use / GUI Agent 当前方案校验（2026-11-03）](computer-use-landscape-2026-11-03.md) — 39 个仓库数据快照、驱动/平台限制、语义与视觉范式、任务授权与 host.desktop 修改建议
