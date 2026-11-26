/** 多仓隔离组词条（R-18b：发现/建组/预检/组合入/清理/简报提示/左栏徽标） */
export const frag: Record<string, string> = {
  'Git 偏好保存失败': 'Could not save Git preferences',
  'Git 偏好保存失败：{{error}}': 'Could not save Git preferences: {{error}}',
  '隔离准备命令': 'Isolation preparation commands',
  '工作区准备命令': 'Workspace preparation commands',
  '仓库准备命令': 'Repository preparation commands',
  '全部隔离仓建好后执行。工作区命令在主容器执行一次，仓级命令只在选中的隔离仓执行。': 'Run after all isolated repositories are ready. Workspace commands run once in the primary container; repository commands run only in selected isolated repositories.',
  '每个输入框是一条完整命令，可包含多行。命令独立保存；保存不会执行，取消工作区设置不会撤销已保存命令。': 'Each field contains one complete command, which can span multiple lines. Commands are saved separately and do not run on save. Cancelling workspace settings does not undo saved commands.',
  '正在读取准备命令…': 'Loading preparation commands…',
  '{{label}}：命令 {{n}}': '{{label}}: command {{n}}',
  '删除 {{label}} 命令 {{n}}': 'Delete {{label}} command {{n}}',
  '为 {{label}} 添加命令': 'Add a command for {{label}}',
  '添加命令': 'Add command',
  '删除命令': 'Delete command',
  '准备命令目标仓库': 'Repository for preparation commands',
  '选择要配置的仓库': 'Choose a repository to configure',
  '添加仓库配置': 'Add repository configuration',
  '删除仓库配置': 'Delete repository configuration',
  '删除 {{label}} 仓库配置': 'Delete repository configuration for {{label}}',
  '该源文件夹已移除，请删除对应准备命令。': 'This source folder was removed. Delete its preparation commands.',
  '保存准备命令': 'Save preparation commands',
  '准备命令已保存，创建隔离任务时执行。': 'Preparation commands saved. They run when an isolated task is created.',
  '准备命令未保存：{{error}}': 'Preparation commands were not saved: {{error}}',
  '重新加载配置': 'Reload configuration',
  '丢弃未保存的准备命令，重新读取配置': 'Discard unsaved preparation commands and reload configuration',
  '隔离仓库范围': 'Isolated repositories',
  '刷新仓库': 'Refresh repositories',
  '选中的仓库及其嵌套仓将在独立副本中运行；其他源文件夹保持共享参考。': 'Selected repositories and their nested repositories run in separate checkouts; other source folders remain shared references.',
  '正在读取仓库列表…': 'Loading repositories…',
  '所选仓库已失效，请重新选择隔离范围。': 'A selected repository is no longer available. Select the isolation scope again.',
  '由上级仓库包含': 'Included by its parent repository',
  '没有可隔离的源仓库，请添加 Git 源文件夹或刷新仓库。': 'No source repositories are available. Add a Git source folder or refresh repositories.',
  '任务运行仓库': 'Task working repository',
  '在当前源文件夹中选择运行仓库': 'Choose a working repository in the current source folder',
  '请选择要隔离的仓库；未选源文件夹保持共享参考。': 'Choose repositories to isolate; unselected source folders remain shared references.',
  '工作区源文件夹已变化，请刷新仓库。': 'Workspace source folders changed. Refresh repositories.',
  '仓库扫描未完成': 'Repository discovery is incomplete',
  '仓库扫描未完成（{{n}} 处）': 'Repository discovery is incomplete ({{n}} locations)',
  '重试扫描': 'Retry discovery',
  '可访问目录的仓库仍可使用，修复后刷新。': 'Repositories in accessible directories remain available. Refresh after fixing the paths.',
  '目录不存在或暂时离线': 'The directory is missing or temporarily offline',
  '无法读取目录，请检查访问权限': 'Cannot read the directory. Check access permissions.',
  '路径不是文件夹': 'The path is not a directory',
  '还有 {{n}} 处目录未完成扫描': '{{n}} more directories could not be scanned',
  '刷新仓库列表': 'Refresh repository list',
  '重新发现仓库及嵌套仓；新增、删除或修复仓库后刷新':
    'Rediscover repositories and nested repos; refresh after adding, deleting or repairing a repo',
  '回滚未完成，已保留容器：{{detail}}': 'Rollback incomplete; container retained: {{detail}}',
  '本组已建部分已回滚': 'Created worktrees in this group have been rolled back',
  "无法确认 worktree 所属仓库，已保留：{{path}}": "Cannot identify the source repository; worktree retained: {{path}}",
  "无法确认合入目标，已保留 worktree": "Cannot identify the integration target; worktree retained",
  "分支尚未合入目标，已保留": "Branch has not been merged into the target and was retained",
  "worktree 初始化提醒": "Worktree setup warning",
  "worktree 存储目录必须是绝对路径": "Worktree storage must be an absolute path",
  "无效的 worktree 目录名": "Invalid worktree directory name",
  "隔离工作区": "Isolated workspaces",
  "worktree 存储目录": "Worktree storage directory",
  "新任务保存到此目录，可选择其他磁盘。已有任务保留原位置；此目录包含未提交工作，请勿当作缓存清空。": "New tasks use this directory, which may be on another drive. Existing tasks keep their location. It contains uncommitted work; do not clear it as a cache.",
  "worktree 有未提交改动或所属仓库无法确认，整组已保留：{{path}}": "The worktree has uncommitted changes or its source cannot be identified; the whole group was retained: {{path}}",
  "嵌套仓 {{repo}} 建树失败: {{error}}": "Failed to create nested worktree {{repo}}: {{error}}",
  // ── 通用标签 ──
  '（主仓）': ' (main repo)',
  '{{n}} 个': '{{n}}',
  // ── repoSet 规整 / 收窄 ──
  'repoSet 必须是主仓相对路径数组':
    'repoSet must be an array of repo-relative paths',
  'repoSet 含非法路径（须为主仓相对路径）：{{items}}':
    'repoSet contains invalid paths (must be repo-relative): {{items}}',
  'repoSet 列出的嵌套仓不存在：{{missing}}（主仓内发现的嵌套仓：{{found}}）':
    'Nested repos listed in repoSet do not exist: {{missing}} (discovered in the main repo: {{found}})',
  // ── 健全性（残缺嵌套仓） ──
  '嵌套仓残缺': 'Broken nested repo',
  '.git/HEAD 缺失': '.git/HEAD is missing',
  'HEAD 指向丢失对象': 'HEAD points to a missing object',
  '.git 无法解析': '.git cannot be resolved',
  '{{repo}}（{{symptom}}）': '{{repo}} ({{symptom}})',
  '跳过残缺嵌套仓 {{n}} 个：{{list}}。请修复或删除这些仓后再纳入隔离组。':
    'Skipped {{n}} broken nested repo(s): {{list}}. Repair or delete them before including them in an isolation group.',
  '嵌套仓全部残缺，无法组建隔离组：{{list}}。请修复或删除这些仓后重试。':
    'All nested repos are broken; cannot create an isolation group: {{list}}. Repair or delete them and retry.',
  // ── 建组 / 回滚 ──
  '嵌套仓 {{repo}} 建树失败: {{error}}（已回滚本组已建部分，不留半组）':
    'Failed to create worktree for nested repo {{repo}}: {{error}} (already-created parts of this group were rolled back; no half group left behind)',
  // ── 预检 ──
  '{{repo}}: 隔离树有未提交改动（先在隔离目录提交再合入）':
    '{{repo}}: the isolated worktree has uncommitted changes (commit inside the isolated directory before integrating)',
  '{{repo}}: 状态检查失败 {{error}}':
    '{{repo}}: status check failed {{error}}',
  '{{repo}}: 主检出有未提交改动与待合入文件重叠（不是合并冲突）。重叠 {{count}} 个：{{files}}。请提交/挪开，或传 stashMain:true 让路':
    '{{repo}}: uncommitted changes in the main checkout overlap with incoming files (not a merge conflict). Overlapping: {{count}}: {{files}}. Commit/move them, or pass stashMain:true to stash and proceed',
  '{{repo}}: 合入 {{target}} 有冲突（{{count}} 个：{{files}}）':
    '{{repo}}: merging into {{target}} has conflicts ({{count}}: {{files}})',
  '{{repo}}: 冲突预演失败 {{error}}':
    '{{repo}}: conflict dry-run failed {{error}}',
  // ── 组级合入 ──
  '零改动（无脏文件、无领先提交），排除出合入与验收':
    'No changes (no dirty files, no commits ahead); excluded from integration and acceptance',
  '无法解析合入目标分支': 'Cannot resolve the target branch to merge into',
  '{{repo}}: 无法解析合入目标分支（既无 base 记录也无默认分支），整组拒绝、零改动':
    '{{repo}}: cannot resolve the target branch (no base record and no default branch); whole group rejected, zero changes',
  '该仓没有分支 {{target}}，显式 target 对每仓生效、整组拒绝':
    'This repo has no branch {{target}}; an explicit target applies to every repo, whole group rejected',
  '{{repo}}: 没有分支 {{target}}（显式 target 对每仓生效），整组拒绝、零改动':
    '{{repo}}: no branch {{target}} (an explicit target applies to every repo); whole group rejected, zero changes',
  '预检阶段整组拒绝，未尝试':
    'Whole group rejected during pre-check; not attempted',
  '多仓组全或无预检失败：\n{{reports}}\n整组拒绝合入，全部仓零改动；请在隔离分支解决后重试':
    'All-or-nothing multi-repo preflight failed:\n{{reports}}\nWhole group rejected, every repo unchanged; resolve on the isolated branch and retry',
  '多仓组全或无预检失败：{{reason}}（{{repo}}）。整组拒绝合入，全部仓零改动；请在隔离分支解决后重试':
    'All-or-nothing pre-check failed for the multi-repo group: {{reason}} ({{repo}}). Whole group rejected, every repo unchanged; resolve on the isolated branch and retry',
  '已在 {{target}} 上，无需再 merge':
    'Already on {{target}}, no merge needed',
  '前序仓真合失败，停止后续合入（不自动回滚）':
    'A previous repo failed its real merge; stopping further merges (no automatic rollback)',
  '{{repo}} 真合失败（预检后小窗口，概率极小）：{{error}}。已合入：{{merged}}；未合：{{pending}}。不自动回滚已合仓——请人工裁定后重试（已合仓重试会按已合入跳过）':
    'Real merge failed for {{repo}} (small window after pre-check, very unlikely): {{error}}. Merged: {{merged}}; pending: {{pending}}. Already-merged repos are NOT rolled back automatically — adjudicate manually and retry (merged repos will be skipped as already-merged on retry)',
  '多仓组合入完成：{{merged}} 个仓已合入、{{skipped}} 个零改动仓跳过（主仓+{{nested}} 嵌套仓）':
    'Multi-repo group integrated: {{merged}} repo(s) merged, {{skipped}} unchanged repo(s) skipped (main repo + {{nested}} nested)',
  // ── 逐仓清理 ──
  '树已不存在，已 prune 悬空注册':
    'Worktree no longer exists; pruned the dangling registration',
  '有未提交改动，保留': 'Has uncommitted changes; kept',
  '分支 {{branch}} 相对 {{target}} 有未合入提交，保留':
    'Branch {{branch}} has unmerged commits relative to {{target}}; kept',
  'worktree remove 失败': 'worktree remove failed',
  '分支 {{branch}} 未删（{{reason}}）':
    'Branch {{branch}} not deleted ({{reason}})',
  '本次隔离容器含指定插件仓：{{list}}':
    'This isolated container holds the specified plugin repos: {{list}}',
  // ── sessions 收尾文案 ──
  '分支未合入': 'branch has unmerged commits',
  '清理失败：{{reason}}': 'cleanup failed: {{reason}}',
  '多仓组部分嵌套仓未收尾，容器已保留：{{detail}}。各仓 ao/* 分支仍在，可回对应仓合入；归档卡片右键可放弃并清理':
    'Some nested repos in the multi-repo group were not settled; the container is kept: {{detail}}. Each repo still has its ao/* branch — merge in the corresponding repo, or right-click the archived card to discard and clean up',
  '会话已删除，但多仓组部分嵌套仓未收尾，容器已保留 {{path}}：{{detail}}（各仓 ao/* 分支与树同时保留，可手动处理）':
    'Session removed, but some nested repos in the multi-repo group were not settled; the container is kept at {{path}}: {{detail}} (each repo keeps its ao/* branch and worktree for manual handling)',
  '{{repo}}：树未能删除（{{reason}}）':
    '{{repo}}: worktree could not be removed ({{reason}})',
  '找不到容器 {{path}} 对应的主仓库根':
    'Cannot find the main repo root for container {{path}}',
  // ── 左栏组徽标 ──
  'worktree 隔离 · {{branch}}{{group}}': 'worktree isolation · {{branch}}{{group}}',
  ' · 多仓组 {{n}} 仓': ' · multi-repo group, {{n}} repos',
  '{{n}}仓': '{{n}} repos',
  '仓库目录已消失': 'Repository directory no longer exists',
  '仓库身份已变化，请刷新仓库': 'Repository identity changed; refresh repositories',
  '自动隔离排除': 'Automatic isolation exclusions',
  '参考仓及其子仓可排除出自动隔离，仍可在 Git 中浏览。显式选仓可覆盖排除。': 'Exclude reference repositories and their descendants from automatic isolation while keeping them visible in Git. Explicit selections override exclusions.',
  '取消排除 {{label}}': 'Remove exclusion for {{label}}',
  '取消排除': 'Remove exclusion',
  '自动隔离排除仓库': 'Repository to exclude from automatic isolation',
  '选择参考仓': 'Select a reference repository',
  '添加排除仓库': 'Add exclusion',
};
