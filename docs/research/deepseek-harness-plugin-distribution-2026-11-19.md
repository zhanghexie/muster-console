# DeepSeek Harness 插件发布与目录维护

调研日期为 2026-11-19。DeepSeek Harness 的作者可在 npm 或 Git 独立发版，社区目录通过版本索引提供发现和安装入口。社区市场 dsh.pub 将投稿压缩为提交一个公开仓库地址，校验、索引变更与部署由系统完成。

## 官方列表与自定义索引

插件管理器带有离线可读的 Official 列表，收录随发行提供的可选插件和按需安装的官方包。按需包的安装目标由宿主按当前 DSH 版本生成。第三方索引是另一个入口，用户启用实验性的 Custom plugin indexes 后，在 Discover 添加索引 URL。这个入口初始没有索引源，用户按 profile 保存各自的来源。 [官方插件管理器](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/boot/plugin-manager/README.md) · [自定义索引文档](https://deepseek-harness.github.io/deepseek-harness/en/guide/plugin-market)

作者在 npm 发布带 `dsh.bundle` 的包，或在 Git 仓库提供可安装组合包。插件管理器可直接从这些来源安装。静态索引按插件列出各版本、兼容范围和安装来源。选中版本后，客户端显示 npm 包名、版本和 registry，或 Git 仓库、固定提交及子目录，经用户确认后调用同一安装链。索引验证覆盖格式，发布者、介绍和源地址由索引维护者声明。 [索引版本和安装规则](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/plugin-market.md#browse-and-install)

## 生成静态目录

官方生成器读一份 `plugins.txt`，每行是 npm 包名或 HTTPS Git 仓库。它读取 npm 元数据中的已发布版本，或 Git 的版本标签和默认分支，从合格的 `package.json` 提取展示字段以及 `engines.dsh`。Git 条目固定为提交 SHA。生成器只读取文件，缓存已发现的版本和提交，来源暂时不可用时复用上次结果并报错。维护者发布生成的 `index.json` 和图标即可。 [官方生成器](https://github.com/deepseek-ai/deepseek-harness/tree/master/apps/plugin-market-generator)

## dsh.pub 社区投稿

1. 投稿人只填公开的 GitHub 仓库地址。网页后台验证表单，用 Cloudflare Worker 创建任务，再由 GitHub App 代建索引 PR。投稿记录是仓库地址等元数据。
2. GitHub Actions 将仓库默认分支解析到一个明确的公开提交，读取该版的清单、运行入口、README 和许可并检查组合包契约。校验通过自动合并，`main` 再生成目录，Cloudflare Workers 从 Git 集成发布。
3. 用户通过目录找到安装方式。dsh.pub 的安装器将固定提交的 Git 来源交给 DSH 原生 `plugin add`。投稿是推荐收录，一个公开仓库也可以由作者之外的人提交。 [实际投稿页面](https://dsh.pub/zh/submit/) · [dsh.pub 投稿与部署说明](https://github.com/dsh-pub/dsh-pub#submit-a-plugin)

## Muster 可借鉴的流程

让作者提交一次仓库地址，维护侧记录源清单，生成器往后从已有发版约定发现版本，核对清单、宿主兼容性和包摘要。经认可的版本进入公开索引。作者发包可以沿用现有 JSON 格式，在作者仓的发版流程里自动运行打包器。生成器读取已发布产物，以固定提交为准。 [Muster 当前发包](../features/extension-center.md#独立仓库与发包)

页面可提供「提交仓库地址」入口，先把地址送到审核队列。早期可以用一份来源清单和 GitHub Actions 生成静态目录。若客户端继续要求同源，Pages 可同步已审核的版本包与目录。若改为从作者仓取包，新版客户端需支持该来源，并让可安装版本与经验证的发布身份及摘要绑定。 [Muster 当前目录校验](../../src/main/extensions/extensionCenter.ts)
