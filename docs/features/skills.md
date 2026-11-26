# Skills（统一目录与宿主私有技能）

> 状态：实现说明（2026-11-07）
> 入口：`src/main/capabilityManagement/skills.ts`、`src/main/capabilityManagement/runtimeSkills.ts`、`src/main/agent/skillSources.ts`、`src/main/agent/skillsList.ts`、`src/main/metaAgent/hostSkillProvision.ts`、`src/main/metaAgent/hostDomainSkills.ts`

Skill 是一个包含 `SKILL.md` 的目录。管理器只认识两个通用根：用户全局 `~/.agents/skills`，以及每个项目源根下的 `.agents/skills`。目录由作用范围自动计算，不再读取 harness 的品牌目录声明，也不提供自定义目录登记、入口关联复选框或按品牌目录建立链接的能力。

全局清单扫描 `home/.agents/skills`；项目清单继承全局清单，并扫描当前 workspace 的所有源根 `.agents/skills`。同名技能保留为多个来源，使用偏好只解决冲突，不改变发现根。新建技能直接写入当前作用范围的通用目录：全局写入 `~/.agents/skills/<name>`，项目写入第一个项目源根的 `.agents/skills/<name>`，不会把目录链接到其它源根。原有 `.claude/skills`、`.cursor/skills`、`.codex/skills`、`.pi/skills` 内容由用户自行维护，管理器不会删除或迁移。

管理器持久化只保存 revision 和同名偏好；旧版包含目录登记或入口关联的台账不会继续驱动扫描或写链接。`SKILL.md` 编辑仍用 hash 和物理身份校验，宿主公共目录和继承项只读，`.muster` 私有存储始终拒绝作为用户技能根。扫描有深度、数量和文件大小上限，后台观察使用 `fs.watch` 加有界重扫，退出时释放 watcher。

## 宿主内置技能

宿主自带技能安装在 `~/.muster/skills`，真源来自 `resources/skills`，由 `hostSkillProvision.ts` 在启动和升级时按 `x-muster-version` 更新。`hostDomainSkills.ts` 只负责解析这一私有根和 catalog 声明，脚手架不会把它投递到项目 `.agents/skills`，也不会维护宿主技能链接的 `.gitignore` marker。除了工具参数技能外，这里还包含 `muster-extensions` 和 `ui-widget-design` 两份宿主创作合同；它们随应用安装，供显式加载使用。

宿主运行时通过显式路径加载自己的技能。Pi GUI/dispatcher 的运行时路径包含 `~/.muster/skills`、`~/.agents/skills` 和当前项目 `.agents/skills`；其它 target 只拿两个通用根。管理页面不扫描 `~/.muster/skills`，因此宿主文档不会混进用户技能清单。宿主技能以只读方式标识，不能编辑、创建或归并。扩展和工作流创作说明随宿主技能安装。脚手架保留项目的扩展和工作流目录，清理与已知旧模板一致的生成说明，保留用户写过的 README。

宿主提示直接引用 `~/.muster/skills/memory/SKILL.md`。开发沙箱把用户技能目录指向隔离目录，Pi 的宿主内置技能仍从安装器使用的公开技能根发现并授予已发布技能只读访问。旧工作区可能仍有指向旧安装目录的链接，宿主记忆流程按安装路径读取。

## Pi 发现与注入

`skillSources.ts` 为 Pi 构造显式加载路径，按物理文件身份去重，并通过 workspace context 将任务 worktree 映射回项目源根做策略判断。`skillsList.ts` 复用同一加载器提供菜单清单。技能正文按需读取：显式 `/skill:name` 或点名触发注入，派活简报只提供 `SKILL.md` 路径；注入预算、审计和 injection registry 规则保持不变。

Pi GUI 与调度的原生 `read` 共用已发布技能的物理目录作为只读范围。请求路径先解析 `realpath`，再核对已发布 `SKILL.md` 和包目录的物理身份；同一包的其它路径别名（包括整目录链接）无需重复发现，正文和包内引用文件均可读取。授权不依赖目录名称或路径白名单，物理去重也不会让等价别名丢失权限。链接解析到所有已发布只读范围之外时仍被拒绝；发布入口重定向后，其旧身份不再提供授权。该授权不允许写入，也不覆盖用户显式拒绝规则。

`test/workspace-skills.mjs` 通过真实 Pi 发现与 GUI／调度权限钩子覆盖全局优先发现、整目录别名去重、任意名称的包别名、引用文件读取、写入拒绝、嵌套链接逃逸及发布入口／请求别名重定向。夹具在 Windows 创建 junction，在 macOS/Linux 创建目录 symlink；Windows 执行结果不代表其它平台真机验证。

## 关键边界

- 管理器不接管第三方 CLI 的原生技能目录，也不承诺关闭它们的自有发现。
- 用户已有品牌目录、外部目录和外部链接不自动删除；只有用户主动使用归并工具时，才会执行带预览、备份和回滚的文件整理。
- 代码或模拟测试不代表 macOS/Linux 真机验收；本次没有新增平台专属系统 API。

## 相关文件

| 文件 | 职责 |
|---|---|
| `src/main/capabilityManagement/skills.ts` | 两个通用根的扫描、清单、编辑、创建、同名偏好和运行时过滤 |
| `src/main/capabilityManagement/runtimeSkills.ts` | 将通用根和宿主私有根接入运行时加载器 |
| `src/main/agent/skillSources.ts` | Pi 显式加载路径、worktree 映射、物理去重和来源标记 |
| `src/main/agent/skillReadAccess.ts` | 以已发布物理包身份统一别名读取与包内引用的只读范围 |
| `src/main/metaAgent/hostSkillProvision.ts` | 安装/升级 `~/.muster/skills` 的宿主正文 |
| `src/main/metaAgent/hostDomainSkills.ts` | 解析宿主私有根和 catalog 技能域 |
