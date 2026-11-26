# GitHub 反馈收件选型（2026-11-16）

讨论基于公开源码仓的反馈渠道。现有产品流程见 [反馈收集与逐条审核](../features/feedback.md)。

首发直接使用公开源码仓的 GitHub Issues。Muster 通过公开 Issues API 匿名读取历史，保留本机草稿、AI 查重和逐条审核。用户确认后，打开 GitHub 新建 Issue 页面，请用户用自己的账号完成提交。GitHub 支持预填标题和正文，仓库可以用 Issue Forms 规范网页入口。过长或不适合放入 URL 的正文由用户复制粘贴。桌面端显示「已打开 GitHub」，拿到对应 Issue 链接后才显示已提交。

实现时把读取历史和提交的凭据要求分开。当前远端适配器及自动重查都查本机令牌，公开发布路径应能在未配置令牌时远端查重。遇到限流或读取失败时保留草稿，并显示远端查重未完成。审核时明确发布内容会公开。发布目标使用应用对应的公开仓库。

如果发布后需要在 Muster 内一键提交并立即返回 Issue 链接，再验证 GitHub App Device Flow 对普通社区贡献者的授权和建单体验。如果需要接收无 GitHub 账号用户的反馈，再考虑独立接收服务。

[Issue REST 读写权限](https://docs.github.com/en/rest/issues/issues) · [预填 Issue 网页](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/creating-an-issue#creating-an-issue-from-a-url-query) · [Issue Forms](https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/configuring-issue-templates-for-your-repository) · [GitHub App Device Flow](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)
