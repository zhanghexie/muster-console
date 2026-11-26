# 开源工具的 GitHub PR 审查接入

2026-11-24 核对上游代码和使用文档。桌面工具处理开发者的读写操作，仓库自动化根据事件运行，二者可以共用 GitHub 的 PR 数据。Muster 现有入口和技术边界见 [PR 功能文档](../features/pr-loop.md)。

## 桌面内审查

- **T3 Code** 由服务端直接调用 GitHub REST 和 GraphQL。文档列出设置内保存的 token、服务端环境变量、已登录的 `gh` 三种凭据来源。源码还包含可配置的 GitHub App 设备登录和 token 刷新，设备登录需要配置 App 的 client ID。已安装的 CLI 可以提供凭据，设置内有 token 时即可使用 GitHub API。 [连接文档](https://github.com/pingdotgg/t3code/blob/b5e1f91cba0e422e49e6ad33e666dd577e9af666/docs/user/source-control.md#github) · [凭据实现](https://github.com/pingdotgg/t3code/blob/b5e1f91cba0e422e49e6ad33e666dd577e9af666/packages/source-control-github/src/server/GitHubCredentials.ts) · [GitHub App 登录](https://github.com/pingdotgg/t3code/blob/b5e1f91cba0e422e49e6ad33e666dd577e9af666/packages/source-control-github/src/server/GitHubAppSignIn.ts)
- **T3 Code 的审查入口**包括待我审筛选、PR 文件和行内讨论、CI 详情、提交评审、GitHub 已查看状态、关联会话，以及用户主动启动的 PR 监控。监控复用同项目同一 PR 的检查，发现新评论、CI 或冲突等相关变化时才唤醒关联会话。可选的 Review Guide 在临时检出中生成阅读导览。 [审查与合并](https://github.com/pingdotgg/t3code/blob/b5e1f91cba0e422e49e6ad33e666dd577e9af666/docs/user/source-control.md#review-and-merge) · [关联 PR 与监控](https://github.com/pingdotgg/t3code/blob/b5e1f91cba0e422e49e6ad33e666dd577e9af666/docs/user/source-control.md#linked-pull-requests) · [Review Thread 查询](https://github.com/pingdotgg/t3code/blob/b5e1f91cba0e422e49e6ad33e666dd577e9af666/packages/source-control-github/src/server/pullRequestReviews.graphql.ts)
- **GitHub Pull Requests for VS Code** 复用 VS Code 的 GitHub 认证会话，在编辑器里列 PR、打开 Diff、评论和处理审查。凭据模块把认证结果交给 API 客户端。这个方式适合应用自己提供登录入口，把普通 Git fetch、checkout 和 push 留给现有 Git 凭据。 [扩展文档](https://github.com/microsoft/vscode-pull-request-github#readme) · [凭据实现](https://github.com/microsoft/vscode-pull-request-github/blob/main/src/github/credentials.ts)

## 仓库事件触发审查

- **DeepSeek Harness** 官方示例将实验性 GitHub Webhook 适配器挂在 `dsh web`。签名通过后，规则只接收指定来源、指定仓库的 `pull_request.ready_for_review`，携带 PR 编号和确切的 head SHA，创建只读审查 Session。审查结果留在 Session，示例需要额外安装 Webhook 插件并配置 HTTPS 转发。 [官方接入文档](https://github.com/deepseek-ai/deepseek-harness/blob/4b399c39a6d1479cd84ca591b4d7c88e24d38a96/docs/user/guide/github-review.md) · [事件规则](https://github.com/deepseek-ai/deepseek-harness/blob/4b399c39a6d1479cd84ca591b4d7c88e24d38a96/packages/experimental/webhook-github/examples/github-review/github-ready-review-rule.mjs)
- **The PR Agent** 支持 GitHub Actions 和自托管 GitHub App。仓库侧提供 GitHub 和模型凭据，根据 PR 事件或评论命令触发，在 GitHub 发布审查结论。社区 **DSH-action** 也走 Actions，由控制器调用隔离的 Harness 生成结果并发布评论。审查运行在仓库配置的服务或 runner 上，开发者可以直接在 GitHub 看结果。 [PR Agent 自动化文档](https://github.com/The-PR-Agent/pr-agent/blob/main/docs/docs/usage-guide/automations_and_usage.md) · [社区 DSH-action](https://github.com/Lixiaoyiao/DSH-action)

## 选型依据

- 现成的 CLI 可以通过 `gh api` 提供 PR 文件、评审和讨论，复用用户已经建立的登录。随着读取量增长，可按 PR 批量请求、分页，并根据新提交或明确的用户操作刷新。GitHub API 直接调用可以支持免装 CLI 的用户，需要产品承担按主机和账号选择、凭据存储与刷新、限流和权限反馈。 [GitHub CLI API](https://cli.github.com/manual/gh_api) · [GitHub App 用户授权](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)
- PR 常规评论、评审结论、文件行内评论各有数据接口。行内线程还包含解决状态、过时状态和 Diff 侧别。审查要读取确定版本的 Diff，发布前重新确认 head SHA。这样新提交到达时能指出草稿需要重新定位，并避免把旧行的意见写到新代码上。 [评审接口](https://docs.github.com/en/rest/pulls/reviews) · [行内评论接口](https://docs.github.com/en/rest/pulls/comments) · [T3 Code 线程字段](https://github.com/pingdotgg/t3code/blob/b5e1f91cba0e422e49e6ad33e666dd577e9af666/packages/source-control-github/src/server/pullRequestReviews.graphql.ts)
- 团队自动审查可将 GitHub Actions 或 GitHub App 用作独立入口，按仓库配置事件、凭据和发布权限。自托管 Webhook 的形态适合希望事件进入既有 Worker 和会话系统的团队。用仓库、PR 编号及 head SHA 去重审查任务，GitHub 评论与事件载荷保留为审查输入，写回由独立授权控制。 [GitHub Webhook 事件](https://docs.github.com/en/webhooks/webhook-events-and-payloads) · [DeepSeek 事件规则](https://github.com/deepseek-ai/deepseek-harness/blob/4b399c39a6d1479cd84ca591b4d7c88e24d38a96/packages/experimental/webhook-github/examples/github-review/github-ready-review-rule.mjs)
