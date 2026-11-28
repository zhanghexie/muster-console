# GitHub PR 创建与审查

入口是 Git 工具栏里的拉取请求图标。连接 GitHub 后可看「我发起的」和「待我审」，打开 PR 详情读变更、CI、评审结论和行内讨论。隔离 worktree 的 Git 工具栏提供加号按钮「开 PR」。本地工作区 Diff 仍可添加意见并通过会话邮箱交给 Worker。开源选型见 [GitHub PR 审查调研](../research/github-pr-review-integrations-2026-11-24.md)。

## 连接 GitHub 与仓库授权

Muster 内置公开的 **Muster Console GitHub App**。用户在 **Git → PR** 点「连接 GitHub」，通过「复制授权码并打开 GitHub」完成设备授权。工作台随后检查当前仓库的安装范围和已批准权限。如果该仓库还未授权，页面会打开 GitHub 安装或已有安装的管理入口。组织仓由有权安装的人选择仓库，成员各自授权 GitHub 账号。返回工作台后会重新检查，用户也可点「刷新」。私有 fork 与目标仓分别受各自的安装范围管理。 [Muster Console App](https://github.com/apps/muster-console) · [GitHub 安装说明](https://docs.github.com/en/apps/using-github-apps/installing-a-github-app-from-a-third-party)

| 仓库权限 | 级别 | 用途 |
|---|---|---|
| Pull requests | Read and write | 创建 PR、读取变更和讨论、发布评审和行内评论 |
| Contents | Read-only | 核对提交、分支与目标仓库内容 |
| Checks | Read-only | 查看 Check Run 检查状态 |
| Commit statuses | Read-only | 查看提交状态及其汇总 |
| Metadata | Read-only（GitHub 自动添加） | 读取仓库名称、fork 关系等基础信息 |

## 自定义 GitHub App

团队可以在 **Git → PR → 配置 GitHub** 填写自有 App 链接或 slug。Muster 从 GitHub REST 接口查询公开 App 的 Client ID。查不到公开信息时，可以从 App 设置页复制 Client ID。在弹窗点「创建 GitHub App」可打开预填上述仓库权限的个人注册页，填写名称并启用 Device Flow。组织可从自身的 GitHub App 设置注册。配置完成后返回工作台保存并连接。 [注册页预填](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-using-url-parameters) · [设备授权](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app#using-the-device-flow-to-generate-a-user-access-token)

构建或开发启动可以为自定义发行版提供成对的公开配置。`release-quality.yml` 可从同名仓库 Actions variables 读取这两项。留空的构建变量沿用内置 Muster Console App。界面保存的配置优先，可在配置框里恢复发行版默认 App。

| 构建或启动变量 | 用途 |
|---|---|
| `MUSTER_GITHUB_APP_CLIENT_ID` | GitHub App 设置页的 Client ID，作为设备授权及刷新参数 |
| `MUSTER_GITHUB_APP_SLUG` | `https://github.com/apps/<slug>` 中的名称，生成仓库安装入口 |

GitHub HTTP 和现有 Git 推送接口在 Windows、macOS、Linux 通用。Git 分支推送使用本机 Git 的 SSH 或 HTTPS 凭据。GitHub 用户令牌通过 Electron safeStorage 按系统账户加密保存，Windows 使用系统账户、macOS 使用钥匙串、Linux 需要 Secret Service 或 KWallet。退回明文的 Linux 后端会给出可操作的提示。公开 App 配置与加密会话在主进程原子保存。切换 App 会清除旧登录及在途设备授权，断开账号保留本机 App 配置。渲染层可读取公开 App 配置、账户状态及一次性用户授权码。

## 桌面工作流

1. **开 PR。** 主进程从当前检出解析 GitHub `origin` 和实际 push URL。fork 使用 GitHub 返回的父仓作为目标，界面展示两端仓库及分支。主进程核对 worktree、当前分支、提交和远端，先走原有 Git 推送，再通过 REST 创建。已有相同来源分支和目标的开放 PR 会复用。推送已完成而创建失败时明确告知。
2. **看评审。** GraphQL 查询分页列表及 PR 详情。列表和详情各用一行图标工具栏，CI 状态和新讨论用有可访问名称的图标表示。变更文件使用与本地 Git 共用的分隔条，默认显示首个文件的 Diff，窄面板把列表排在预览上方。文件补丁经 REST 分页，取回前后核对 base 和 head SHA。追加文件会保留当前选中项，切换文件会保留已编辑的行内评论。CI 检查链接、审批状态、评审正文和已解决或陈旧的讨论独立显示。PR 列表按可见性轮询，单飞，每页 25 条。切离 Git 或 PR 页签时暂停读取，保留页面、滚动位置和未发布评审，收起弹窗。返回后用已有内容承接刷新，已翻页的列表和详情保留到手动刷新。提交版本变化时重新建立评审草稿。
3. **发给 Worker。** 用户选中 GitHub 讨论串后，宿主核对讨论所属 PR、提交版本，以及当前工作区唯一匹配的隔离 Worker。意见作为引用资料经现有邮箱送达。本人发起的 PR 被合并后，已有收口提醒沿用 API 复核。
4. **发布评审。** 用户可在 Diff 行上留言并填写评审正文。「发布评审…」用于发表评论或要求修改。「批准…」直接打开发布确认框，评审正文可以留空。发布前须填写或删除空白的行内评论。自己发起的 PR 可以评论，批准和要求修改由其他评审人提交。确认框显示账号、仓库和提交。主进程提交前复核 PR 仍开放且 base/head 仍一致，并将 `commit_id` 显式交给 GitHub。可选「生成审查草稿」会使用已配置的文本模型读取该版本的有界 Diff，结果可以编辑后提交。 [GitHub 评审接口](https://docs.github.com/en/rest/pulls/reviews#create-a-review-for-a-pull-request)

## Agent 调用

调度和接入宿主工具的 GUI、ACP、PTY Worker 通过 `host.github.run` 使用同一套 GitHub App 登录与仓库授权。`repository` 检查安装和仓库权限。`list`、`detail`、`files`、`threads` 读取 PR、CI、Diff 和讨论，结果分页回传并登记为外部资料。`detail` 提供包含 base/head SHA 的版本对象，用于后续读补丁、讨论和写评审。用法见 `~/.muster/skills/github/SKILL.md`。

宿主从可信调用身份取工作区及根修订号，以会话当前检出或显式 `repoPath` 解析 GitHub 远端。调度默认使用工作区默认源目录。工作目录没有检出时，唯一已发现仓库可作为默认值，多个候选需要明确路径。创建和发布评审受 Worker 编辑权限及逐次确认约束，确认显示 GitHub 账号、仓库、提交和用户将看到的文本。确认后核对工作区、授权与版本。Agent 开 PR 推送固定 SHA。无头定时轮可读取，写入需要交互式会话。

## 自动审查草稿

- **常驻 Muster。** 在远程访问设置配置 Webhook 密钥，用 GitHub 仓库或 App 的签名 Webhook 投递 Pull requests 事件。在该仓的 PR 标签启用「就绪时生成审查草稿」。`pull_request.ready_for_review` 先进入事件日志，再核对已授权仓库、登录账号和事件携带的 head SHA，生成本地草稿。同账号、同仓、同 PR 版本复用已有草稿。排队任务随桌面进程运行，已生成的草稿可在重启后读取。评审、行内讨论和 CI 事件也可进入现有事件订阅。 [运行时事件](runtime-status.md) · [Webhook 入口](web-access.md)
- **GitHub Actions。** 已提供 `.github/workflows/github-pr-review-draft.yml`。仓库维护者可设置变量 `MUSTER_PR_AUTO_REVIEW=true`、`MUSTER_REVIEW_MODEL_URL`（OpenAI 兼容 HTTPS base URL）、`MUSTER_REVIEW_MODEL`，并配置 secret `MUSTER_REVIEW_MODEL_API_KEY`。启用后，同仓 PR 就绪时生成草稿，fork PR 可由维护者手动指定编号。workflow 使用受信任的 base/default 分支代码，用只读 `GITHUB_TOKEN` 取 Diff，输出 `review-draft.md` artifact。维护者可在 Muster 或 GitHub 上编辑并发布。

## 实现与验证

| 位置 | 合同 |
|---|---|
| `src/main/ipc/pr.ts`、`src/shared/githubPr.ts` | `pr:*` 配置 App、连接账号、列表、详情、创建、回传、草稿和发布。仓库请求绑定 workspace、仓库登记及 rootsRevision，失败返回结构化原因。 |
| `src/main/git/githubAppConfig.ts`、`githubAppAuth.ts`、`githubPrStorage.ts` | App 链接解析、公开配置查询、设备授权、令牌轮转与配置持久化，存储位于已登记的 `github-pr` 目录。 |
| `src/main/git/githubPrClient.ts`、`githubPrService.ts` | REST/GraphQL、Git 远端核对、版本一致性和用户操作。 |
| `src/main/capabilities/catalog/github.ts`、`src/main/capabilities/hosts/github.ts`、`resources/skills/github/SKILL.md` | Agent 动作、调用身份、结果预算、逐次确认和参数文档。GUI 和 Shell API 经统一宿主执行器调用 PR 服务。 |
| `PrPanel.tsx`、`GitHubAppSetupDialog.tsx`、`PrReviewPanel.tsx`、`PrChangedFiles.tsx`、`PrCreateDialog.tsx` | 生产 Git 页 UI，复用现有分栏、presence、确认框和工作区作用域。变更预览保留补丁行号、GitHub LEFT/RIGHT 批注坐标和截断提示。 |
| `src/shared/webhookPayload.ts`、`src/main/webAccess/hookRoute.ts` | PR、Review 和 CI 事件归一化，要求 GitHub 签名。 |

日常验证覆盖 `test/git-pr.mjs`、`test/hook-route.mjs`、`test/unit/node-main/github-pr.spec.ts`、`test/unit/pr-panel.spec.tsx`、`test/unit/pr-create-dialog.spec.tsx` 和 `test/e2e/github-pr.spec.ts`。Electron 验证使用真实工作台、Git 和 IPC，GitHub 及凭据加密由夹具提供。生产验收需要在已安装 App 的测试仓分别验证设备授权、fork 推送与创建、CI、意见回传、评审提交和签名事件，Windows、macOS、Linux 分别记录实机结果。

Agent 验证覆盖调度与 Worker 工具目录、未认证调用、工作区隔离、分页预算、确认取消、权限或提交变化以及评审提交。Electron 用例经过已认证的 Shell API 和真实确认框。`test/git-operation-scope.mjs` 用本地裸仓验证确认后分支变动时实际推送的仍是已确认 SHA。
