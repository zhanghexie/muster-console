# 交互式教学页（源码讲解）

双击 `file://` 打开即可；`←`/`→` 翻页，每站实验区可交互。

表中的 `refs/` 路径表示对应上游项目的本地检出。

| 页面 | 讲的是什么 | 参考源码 |
|---|---|---|
| [dsh-design-walkthrough.html](./dsh-design-walkthrough.html) | deepseek-harness 的设计概念教学（历史页：DSH 已于 0.1.21 从产品移除，留作设计教学） | refs/deepseek-harness |
| [pi-walkthrough.html](./pi-walkthrough.html) | Pi Agent Harness（earendil-works/pi）：ai → agent → coding-agent 三层积木，渐进式重建 + 5 个实验 | refs/pi-main @ v0.84.3 |
| [prime-agent-walkthrough.html](./prime-agent-walkthrough.html) | prime-agent 源码讲解 | refs/prime-agent |
| [extension-agent-design-walkthrough.html](./extension-agent-design-walkthrough.html) | 扩展 Agent 设计原则教学：扩展、插件和 Agent Session 三层分工，宿主拥有 Agent Loop，扩展贡献工具与上下文，界面经事件连接 | 本仓 src/main/extensions/ 等源码指引 |

行为断言测试：`node <interactive-tutorial 技能目录>/scripts/stub-harness.js <页面> <同名 .test.js>`
