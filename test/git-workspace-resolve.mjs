/**
 * P2：工作区/仓库解析与 UI 活动工作区解耦（纯函数契约）。
 * Run: node test/git-workspace-resolve.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'git-ws-resolve-'));
const compile = createSharedCompiler(root, tmp);

const out = compile('main/git/workspaceResolve.ts');
const {
  worktreesRootForWorkspace,
  findContainingWorkspace,
  resolveWorktreesRoot,
  resolveTaskWorktreesRoot,
  compactWorktreePath,
  isolateWalkCeiling,
  isolateCwdInTargetWorkspace,
  classifyRepoAllow,
  isListedWorktree,
  unknownRepoI18n
} = await import(pathToFileURL(out).href);

const pathKey = (p) => path.resolve(p).replace(/\\/g, '/').toLowerCase();

const activeA = path.resolve('/ws-active-metaapp');
const targetB = path.resolve('/ws-target-workbench');
const workspaces = [
  { id: 'a', path: activeA },
  { id: 'b', path: targetB }
];

for (const platform of ['win32', 'darwin', 'linux']) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const storage = platform === 'win32' ? 'C:\\Data\\worktrees' : '/data/worktrees';
  const repo = platform === 'win32' ? 'D:\\Projects\\PhySicsLab' : '/projects/PhySicsLab';
  const common = p.join(repo, '.git');
  const make = (ws = 'workspace', task = 'a89e8a91-first', source = repo, git = common) => compactWorktreePath(ws, task, git, source, storage, platform);
  const parts = p.relative(storage, make()).split(p.sep);
  assert.equal(parts.length, 2);
  assert.match(parts[0], /^t-[a-f0-9]{12}$/);
  assert.match(parts[1], /^PhySicsLab-[a-f0-9]{10}$/);
  assert(p.relative(storage, make()).length <= 42);
  assert.notEqual(make(), make('workspace', 'a89e8a91-second'), 'same short UUID prefix must not alias');
  assert.notEqual(make(), make('WORKSPACE'), 'logical identity remains case sensitive');
  assert.notEqual(make(), make('workspace', 'a89e8a91-first', repo, p.join(repo, 'other.git')));
  assert.throws(() => compactWorktreePath('ws', '', common, repo, storage, platform), /scope/);
  assert.throws(() => compactWorktreePath('ws', 'task', common, repo, repo, platform), /outside/);
  assert.throws(() => compactWorktreePath('ws', 'task', common, repo, 'relative', platform), /scope/);
  for (const name of ['CON', 'NUL', 'com1', '中文 工程', 'very-long-project-name-more-than-sixteen']) {
    const result = make('ws', '../../NUL', p.join(p.dirname(repo), name));
    assert.equal(p.relative(storage, result).split(p.sep).length, 2);
    assert.match(p.basename(result), /^[a-zA-Z0-9_-]+-[a-f0-9]{10}$/);
    assert(p.basename(result).length <= 27);
  }
  const caseOnly = make('workspace', 'a89e8a91-first', repo, common.toLowerCase());
  if (platform === 'win32') assert.equal(make(), caseOnly);
  else assert.notEqual(make(), caseOnly);
  console.log(`ok: ${platform} compact paths, full identities, safe names and boundaries`);
}

{
  const storage = path.resolve('/task-storage');
  const common = path.join(targetB, '.git');
  assert.notEqual(resolveTaskWorktreesRoot('ws', common, targetB, storage), resolveTaskWorktreesRoot('WS', common, targetB, storage), 'logical workspace identities stay case-sensitive on Windows');
  assert.notEqual(resolveTaskWorktreesRoot('ws', common, targetB, storage), resolveTaskWorktreesRoot('ws', path.join(activeA, '.git'), activeA, storage));
  assert.throws(() => resolveTaskWorktreesRoot('', common, targetB, storage), /scope/);
  assert.throws(() => resolveTaskWorktreesRoot('ws', common, targetB, targetB), /outside/);
}

{
  assert.equal(isolateWalkCeiling(targetB, activeA), targetB, '天花板取会话工作区而非活动区');
  assert.equal(isolateWalkCeiling(undefined, activeA), activeA, '未绑会话工作区时回落活动区（旧调用兼容）');
  assert.equal(isolateWalkCeiling('  ', activeA), activeA);
  assert.equal(
    isolateCwdInTargetWorkspace(targetB, targetB),
    true,
    '目标区 cwd 允许隔离'
  );
  assert.equal(
    isolateCwdInTargetWorkspace(targetB, activeA),
    false,
    '不得用活动区当目标边界去拒 B 的 cwd'
  );
  // 调度绑 A、目标仓属 B：只要 session workspaceId 指向 B，cwd 在 B 内即允许
  assert.equal(isolateCwdInTargetWorkspace(path.join(targetB, 'src'), targetB), true);
  console.log('ok: 跨工作区 isolate 解析跟目标会话工作区走');
}

{
  const repoInB = path.join(targetB, 'repo');
  const wtRoot = resolveWorktreesRoot(repoInB, workspaces);
  assert.equal(path.dirname(wtRoot), worktreesRootForWorkspace(targetB));
  assert.equal(wtRoot.startsWith(targetB + path.sep), false);
  assert.notEqual(wtRoot, resolveWorktreesRoot(path.join(targetB, 'other'), workspaces));
  assert.notEqual(wtRoot, path.join(activeA, '.worktrees'), '树不得落到活动工作区');
  assert.equal(
    findContainingWorkspace(path.join(targetB, '.worktrees', 'abcd-task'), workspaces)?.id,
    'b'
  );
  const orphan = path.resolve('/orphan-repo');
  assert.equal(
    resolveWorktreesRoot(orphan, workspaces),
    resolveWorktreesRoot(orphan, []),
    '未登记仓退化到仓同级'
  );
  assert.notEqual(worktreesRootForWorkspace(targetB), path.join(targetB, '.worktrees'));
  assert.throws(() => resolveWorktreesRoot(repoInB, workspaces, path.join(repoInB, 'storage')));
  assert.throws(() => resolveWorktreesRoot(repoInB, workspaces, 'relative'));
  console.log('ok: worktrees 落点按主仓所属工作区');
}

{
  const wt = path.join(targetB, '.worktrees', 'sess-task');
  const kind = classifyRepoAllow({
    repoPath: wt,
    workspaces,
    allowedKeys: [],
    pathKey
  });
  assert.equal(kind, 'workspace', 'B 下 worktree 即使 allowed 空、活动区是 A 也算已登记工作区路径');

  const outside = path.resolve('/not-a-workspace/repo');
  assert.equal(
    classifyRepoAllow({
      repoPath: outside,
      workspaces,
      allowedKeys: [],
      pathKey
    }),
    'none'
  );
  assert.equal(
    classifyRepoAllow({
      repoPath: outside,
      workspaces,
      allowedKeys: [pathKey(outside)],
      pathKey
    }),
    'index'
  );
  assert.equal(isListedWorktree(wt, [wt, targetB], pathKey), true);
  assert.equal(isListedWorktree(wt, [targetB], pathKey), false);
  console.log('ok: assertAllowed 分类不绑活动工作区');
}

{
  const missing = unknownRepoI18n({
    reason: 'missing',
    resolved: 'Z:\\gone',
    activeWorkspace: activeA,
    targetWorkspace: targetB
  });
  assert.match(missing.key, /不是 git 仓库/);
  assert.match(missing.key, /当前活动工作区 \{\{active\}\}/);
  assert.match(missing.key, /目标 \{\{target\}\}/);
  assert.equal(missing.params.active, activeA);
  assert.equal(missing.params.target, targetB);

  const unindexed = unknownRepoI18n({
    reason: 'unindexed',
    resolved: 'Z:\\repo',
    activeWorkspace: activeA,
    targetWorkspace: targetB
  });
  assert.match(unindexed.key, /未知仓库（未登记或索引未刷新）/);
  assert.doesNotMatch(unindexed.key, /请先刷新或「添加」/);
  assert.match(unindexed.key, /git\.refreshRepos\(\)/);
  assert.match(unindexed.key, /当前活动工作区 \{\{active\}\}、目标 \{\{target\}\}/);
  console.log('ok: 报错区分未登记 vs 仓库不存在，并写明活动区/目标区');
}

{
  const catalogOut = compile('main/capabilities/catalog.ts');
  const { getToolDef, isWorkerAllowedTool, CATALOG_VERSION } = await import(
    pathToFileURL(catalogOut).href
  );
  assert.ok(Number(CATALOG_VERSION.split('.')[1] || 0) >= 37, `Catalog 版本随 R-18b 多仓组 bump（≥1.37，当前 ${CATALOG_VERSION}）`);
  const def = getToolDef('git.refreshRepos');
  assert.ok(def, '调度应有 git.refreshRepos');
  assert.equal(def.dangerous, false);
  assert.equal(isWorkerAllowedTool('git.refreshRepos'), false, '刷新入口只给调度，不进 Worker 白名单');
  assert.equal(def.parameters.properties.workspaceId?.type, 'string');
  console.log('ok: git.refreshRepos catalog');
}

{
  // 2026-09-26 sessions.ts 拆分：isolate 建树接线在 sessions/createTerminal.ts（wsPath=target 工作区根）
  const sessionsSrc = fs.readFileSync(path.join(root, 'src/main/sessions/createTerminal.ts'), 'utf8');
  assert.doesNotMatch(
    sessionsSrc,
    /跨工作区暂不支持隔离派活/,
    '还原活动区硬拒应使本断言转红'
  );
  assert.match(sessionsSrc, /isolateWalkCeiling\(target\.wsPath, cfg\.workspace\)/);
  assert.match(sessionsSrc, /resolveMainRepoFor\(target\.cwd, targetRoot\)/);

  const serviceSrc = fs.readFileSync(path.join(root, 'src/main/git/service.ts'), 'utf8');
  assert.doesNotMatch(serviceSrc, /未知仓库（请先刷新或「添加」）/);
  assert.match(serviceSrc, /未登记或索引未刷新/);
  assert.match(serviceSrc, /不是 git 仓库: \{\{resolved\}\}（当前活动工作区 \{\{active\}\}、目标 \{\{target\}\}）/);
  assert.match(serviceSrc, /workspaceRefs\(\)/);
  assert.match(serviceSrc, /compactWorktreePath\(findContainingWorkspace\(identity.mainRepo/);
  console.log('ok: 生产路径源码契约（还原修复应转红）');
}

console.log('git-workspace-resolve: all ok');
