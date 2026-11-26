/**
 * R-18b 多仓隔离组·嵌套容器：发现 / 建组（整组回滚）/ 组级合入（全或无预检 +
 * 零改动过滤 + 逐仓对称 target）/ 逐仓清理（真 git fixture）+ 接线守卫。
 * 还原即红锚点：
 * - 建组回滚：还原 addNestedWorktrees 失败分支里的 rollbackNestedWorktrees → 「整组回滚」转红；
 * - 预检拒绝：还原 integrateRepoGroup 的 precheckRepoMerge 阶段（直接进真合）→ 「零改动断言」转红；
 * - 容器排除：还原 ensureNestedReposExclude 调用 → 「容器 status 干净」转红。
 * Run: node test/multi-repo-worktree.mjs
 */
// @test-shards 3
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { inShard } from './helpers/shard.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'multi-repo-wt-'));
const compile = createSharedCompiler(root, tmp);

const nestedOut = compile('main/git/nestedRepos.ts');
const {
  discoverNestedReposDetailed,
  inspectNestedRepoHealth,
  selectHealthyNestedTargets,
  formatNestedRepoSkipWarning,
  formatAllNestedReposUnhealthyError,
  nestedWorktreePath,
  nestedRepoMainPath,
  normalizeRepoSetInput,
  addNestedWorktrees,
  isRepoUnchanged,
  supportsMergeTreeWriteTree,
  precheckRepoMerge,
  integrateRepoGroup,
  cleanupNestedWorktree,
  pruneNestedWorktrees,
  matchRepoSetToDiscovered,
  buildNestedRepoBriefNote,
  NESTED_REPO_SCAN_DEPTH
} = await import(pathToFileURL(nestedOut).href);

const wtOut = compile('main/git/worktree.ts');
const { ensureWorktreesExclude, sessionWorktreeBranch, sessionWorktreeId8 } = await import(
  pathToFileURL(wtOut).href
);
const { GitRepoDiscoveryCache } = await import(pathToFileURL(compile('main/git/discoveryCache.ts')).href);

// ---------- 真 git 工具 ----------
let gitOk = true;
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' });
} catch {
  gitOk = false;
}
function mustGit(args, cwd) {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
}
function tryGit(args, cwd) {
  try {
    return { ok: true, out: mustGit(args, cwd) };
  } catch {
    return { ok: false, out: '' };
  }
}

const SID = 'aaaabbbb-1111-2222-3333-444455556666';
const ID8 = sessionWorktreeId8(SID);
const BRANCH = sessionWorktreeBranch(SID);

/** 初始化单仓：main 分支 + 一个提交 */
function initRepo(dir, files) {
  fs.mkdirSync(dir, { recursive: true });
  mustGit(['init', '-q', '-b', 'main'], dir);
  mustGit(['config', 'user.email', 't@t'], dir);
  mustGit(['config', 'user.name', 't'], dir);
  for (const [rel, content] of Object.entries(files ?? {})) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content, 'utf8');
  }
  mustGit(['add', '.'], dir);
  mustGit(['commit', '-qm', 'init'], dir);
  return dir;
}

/** fixture：主仓 main + 嵌套 b、c（plugins/ 下独立仓） */
function mkGroup(name, opts = {}) {
  const main = initRepo(path.join(tmp, name), { 'a.txt': 'a\n' });
  const b = initRepo(path.join(main, 'plugins', 'b'), { 'b.txt': 'line=base\n' });
  const c = initRepo(path.join(main, 'plugins', 'c'), { 'c.txt': 'line=base\n' });
  ensureWorktreesExclude(main);
  // b 的主检出切到 feature（对称 target 用例：从 feature 建树应合回 feature）
  if (opts.bOnFeature) {
    mustGit(['checkout', '-q', '-b', 'feature'], b);
    fs.writeFileSync(path.join(b, 'feat.txt'), 'feat\n', 'utf8');
    mustGit(['add', '.'], b);
    mustGit(['commit', '-qm', 'feature ahead'], b);
  }
  return { main, b, c };
}

/** 建组：主仓容器根（模拟 addSessionWorktree 主仓段）+ 嵌套树 */
async function buildGroup(fx, sessionId = SID, relPaths = ['plugins/b', 'plugins/c']) {
  const container = path.join(fx.main, '.worktrees', sessionWorktreeId8(sessionId));
  fs.mkdirSync(path.dirname(container), { recursive: true });
  mustGit(['worktree', 'add', '-q', '-b', sessionWorktreeBranch(sessionId), container], fx.main);
  const res = await addNestedWorktrees({
    mainRepo: fx.main,
    sessionId,
    repoRelPaths: relPaths,
    containerRoot: container
  });
  return { container, res };
}

// ---------- 纯函数：repoSet 规整 / 简报提示 ----------
{
  assert.deepEqual(normalizeRepoSetInput(undefined), { ok: true, paths: [] });
  assert.deepEqual(normalizeRepoSetInput(['Plugins/Foo', 'Plugins/Foo', '.\\Plugins\\Bar\\', ' ./x/ ']), {
    ok: true,
    paths: ['Plugins/Foo', 'Plugins/Bar', 'x']
  });
  const abs = normalizeRepoSetInput([path.join(tmp, 'main', 'plugins', 'b')]);
  assert.equal(abs.ok, false, '绝对路径应报错');
  assert.match(abs.message, /repoSet 含非法路径/);
  const up = normalizeRepoSetInput(['../outside']);
  assert.equal(up.ok, false, '越出主仓应报错');
  // Windows 大小写不敏感匹配：命中改用发现清单的真实拼写，未命中报缺
  assert.deepEqual(matchRepoSetToDiscovered(['plugins/foo', 'Other'], ['Plugins/Foo']), {
    matched: ['Plugins/Foo'],
    missing: ['Other']
  });

  const narrowed = buildNestedRepoBriefNote({ repoSet: ['plugins/b'], discovered: ['plugins/b', 'plugins/c'] });
  assert.match(narrowed, /指定插件仓：plugins\/b/);
  const full = buildNestedRepoBriefNote({ discovered: ['plugins/b', 'plugins/c'] });
  assert.match(full, /隔离容器含全部 2 个嵌套仓：plugins\/b、plugins\/c/);
  const many = buildNestedRepoBriefNote({ discovered: Array.from({ length: 8 }, (_, i) => `p${i}/r`) });
  assert.match(many, /全部 8 个嵌套仓：8 个/);
  assert.equal(buildNestedRepoBriefNote({ discovered: [] }), '', '无嵌套仓不提示');
  console.log('ok: repoSet 规整 / locks 命中 / 简报提示（纯函数）');
}

// ---------- 纯函数：残缺嵌套仓挑选 / 告警文案 ----------
{
  const skipped = [{ path: 'plugins/broken', reason: 'missing-head', detail: '.git/HEAD 缺失' }];
  const none = selectHealthyNestedTargets({ healthy: [], skipped: [] }, []);
  assert.equal(none.ok, true, '磁盘上零嵌套仓应成功（单仓工作区）');
  assert.deepEqual(none.ok ? none.targets : [], []);

  const mixed = selectHealthyNestedTargets({ healthy: ['plugins/b'], skipped });
  assert.equal(mixed.ok, true);
  assert.deepEqual(mixed.ok ? mixed.targets : [], ['plugins/b']);
  assert.equal(mixed.skipped.length, 1);

  const allBad = selectHealthyNestedTargets({ healthy: [], skipped });
  assert.equal(allBad.ok, false, '全残缺必须报错，不能静默空组');
  assert.match(allBad.ok ? '' : allBad.message, /全部残缺/);

  const wantedBad = selectHealthyNestedTargets({ healthy: ['plugins/b'], skipped }, ['plugins/broken']);
  assert.equal(wantedBad.ok, false, 'repoSet 只列残缺仓应报错');
  assert.match(wantedBad.ok ? '' : wantedBad.message, /全部残缺/);

  const wantedMixed = selectHealthyNestedTargets(
    { healthy: ['plugins/b'], skipped },
    ['plugins/b', 'plugins/broken']
  );
  assert.equal(wantedMixed.ok, true);
  assert.deepEqual(wantedMixed.ok ? wantedMixed.targets : [], ['plugins/b']);

  const missing = selectHealthyNestedTargets({ healthy: ['plugins/b'], skipped }, ['plugins/ghost']);
  assert.equal(missing.ok, false);
  assert.match(missing.ok ? '' : missing.message, /repoSet 列出的嵌套仓不存在/);

  const warn = formatNestedRepoSkipWarning(skipped);
  assert.match(warn, /plugins\/broken/);
  assert.match(warn, /\.git\/HEAD 缺失/);
  assert.match(warn, /修复或删除/);
  const allErr = formatAllNestedReposUnhealthyError([
    { path: 'a', reason: 'lost-objects', detail: 'bad' }
  ]);
  assert.match(allErr, /全部残缺/);
  assert.match(allErr, /HEAD 指向丢失对象/);
  console.log('ok: 残缺嵌套仓挑选 / 告警文案（纯函数）');
}

if (!gitOk) {
  console.log('skip: 本机无 git，跳过真实多仓组对照');
} else {
  assert.equal(NESTED_REPO_SCAN_DEPTH, 32);

  // ---------- 发现：嵌套识别 / 深度限制 / 排除 node_modules ----------
  if (inShard(0)) {
    const fx = mkGroup('fx-discover');
    initRepo(path.join(fx.main, 'node_modules', 'skipme'), { 'x.txt': 'x\n' });
    initRepo(path.join(fx.main, 'deep', 'l2', 'l3', 'ok'), { 'x.txt': 'x\n' }); // 深度 4：可发现
    initRepo(path.join(fx.main, 'deep', 'l2', 'l3', 'l4', 'toodeep'), { 'x.txt': 'x\n' }); // 深度 5：排除
    const found = (await discoverNestedReposDetailed(fx.main)).healthy;
    assert.deepEqual(
      found,
      ['deep/l2/l3/l4/toodeep', 'deep/l2/l3/ok', 'plugins/b', 'plugins/c'],
      `发现清单应为 b/c/ok：${JSON.stringify(found)}`
    );
    assert.equal(nestedWorktreePath('C:/w/.worktrees/ab', 'Plugins/Foo').includes(path.join('Plugins', 'Foo')), true);
    assert.equal(nestedRepoMainPath('C:/w', 'Plugins/Foo').endsWith(path.join('Plugins', 'Foo')), true);
    console.log('ok: discoverNestedReposDetailed（识别/深度/排除）');
  }

  // ---------- .gitignore 过滤：被主仓忽略的嵌套仓不入发现（2026-10-06 用户报 refs/、.dev-sandbox/） ----------
  // 还原即红锚点：还原 nestedRepos/discoveryCache 对 filterGitignoreExcludedRepos 的调用 → 本节断言转红
  if (inShard(0)) {
    const fx = mkGroup('fx-gitignore');
    fs.writeFileSync(path.join(fx.main, '.gitignore'), 'refs/\n.dev-sandbox/\n.dev-sandbox-template/\n', 'utf8');
    initRepo(path.join(fx.main, 'refs', 'some-clone'), { 'x.txt': 'x\n' });
    initRepo(path.join(fx.main, '.dev-sandbox', 'clone'), { 'x.txt': 'x\n' });
    initRepo(path.join(fx.main, '.dev-sandbox', 'clone', 'inner'), { 'x.txt': 'x\n' }); // 包围仓被过滤 → 子树连带
    const found = await discoverNestedReposDetailed(fx.main);
    assert.deepEqual(found.healthy, ['plugins/b', 'plugins/c'], '.gitignore 命中的嵌套仓不入发现，未命中的保留');
    assert.equal(found.skipped.length, 0, '被忽略仓也不进残缺清单（完全不可见）');
    assert.deepEqual(selectHealthyNestedTargets(found).targets, ['plugins/b', 'plugins/c'], '自动全量建组只收未忽略仓');
    // 自动隔离过滤引用克隆；浏览拓扑仍完整列出独立仓，不能混用两个视图。
    const cache = new GitRepoDiscoveryCache();
    assert.deepEqual((await cache.nested(fx.main)).healthy, ['plugins/b', 'plugins/c'], '生产发现快照同层过滤');
    assert.ok((await cache.roots(fx.main)).some(p => p.endsWith(path.join('refs', 'some-clone'))), '浏览拓扑仍能查看被主仓忽略的独立仓');

    // 缓存失效重扫口径：先收进 refs/，写 .gitignore 后未强制重扫沿用快照（无 TTL，文档边界），强制重扫后消失
    const fx2 = mkGroup('fx-gitignore-rescan');
    initRepo(path.join(fx2.main, 'refs', 'clone'), { 'x.txt': 'x\n' });
    const cache2 = new GitRepoDiscoveryCache();
    assert.ok((await cache2.nested(fx2.main)).healthy.includes('refs/clone'), '写 .gitignore 前可发现');
    fs.writeFileSync(path.join(fx2.main, '.gitignore'), 'refs/\n', 'utf8');
    assert.ok((await cache2.nested(fx2.main)).healthy.includes('refs/clone'), '快照无 TTL：未强制重扫前沿用（边界）');
    await cache2.rootsMany([fx2.main], true);
    assert.ok(!(await cache2.nested(fx2.main)).healthy.includes('refs/clone'), '强制重扫后被忽略目录从发现结果消失');

    // 建组后宿主写入的 info/exclude（防容器恒脏）不影响后续发现——刻意不读该文件
    const grp = mkGroup('fx-gitignore-group');
    fs.writeFileSync(path.join(grp.main, '.gitignore'), 'refs/\n', 'utf8');
    initRepo(path.join(grp.main, 'refs', 'clone'), { 'x.txt': 'x\n' });
    const { res } = await buildGroup(grp);
    assert.equal(res.ok, true, res.ok ? '' : res.message);
    assert.deepEqual((await discoverNestedReposDetailed(grp.main)).healthy, ['plugins/b', 'plugins/c'], 'info/exclude 命中不算 .gitignore 忽略，正常嵌套仓仍在');
    console.log('ok: 嵌套仓发现 .gitignore 过滤（发现/缓存重扫/info-exclude 边界）');
  }

  // ---------- 健全性：无 HEAD 跳过 / 丢失对象跳过 / 健全入组 / 全残缺报错 ----------
  if (inShard(1)) {
    const fx = mkGroup('fx-health');
    const noHead = path.join(fx.main, 'plugins', 'no-head');
    fs.mkdirSync(path.join(noHead, '.git'), { recursive: true });
    fs.writeFileSync(path.join(noHead, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n', 'utf8');
    // 对照：部分 git 版本对缺 HEAD 的 .git 会向上回退到主仓（事故根因）；
    // 无论是否回退，inspect 都必须判残缺，不得因父仓 HEAD 而放行。
    tryGit(['rev-parse', '--verify', 'HEAD'], noHead);
    const noHeadHealth = await inspectNestedRepoHealth(noHead);
    assert.equal(noHeadHealth.ok, false, '缺 HEAD 不得因父仓而判健全');
    assert.equal(noHeadHealth.ok ? '' : noHeadHealth.reason, 'missing-head');

    const lost = initRepo(path.join(fx.main, 'plugins', 'lost'), { 'l.txt': 'l\n' });
    fs.writeFileSync(path.join(lost, '.git', 'HEAD'), `${'a'.repeat(40)}\n`, 'utf8');
    const lostHealth = await inspectNestedRepoHealth(lost);
    assert.equal(lostHealth.ok, false, 'HEAD 指向丢失对象应判残缺');
    assert.equal(lostHealth.ok ? '' : lostHealth.reason, 'lost-objects');

    const lostRef = initRepo(path.join(fx.main, 'plugins', 'lost-ref'), { 'r.txt': 'r\n' });
    fs.writeFileSync(path.join(lostRef, '.git', 'refs', 'heads', 'main'), `${'b'.repeat(40)}\n`, 'utf8');
    const lostRefHealth = await inspectNestedRepoHealth(lostRef);
    assert.equal(lostRefHealth.ok, false, '分支 ref 指向丢失对象应判残缺');
    assert.equal(lostRefHealth.ok ? '' : lostRefHealth.reason, 'lost-objects');

    const okHealth = await inspectNestedRepoHealth(fx.b);
    assert.equal(okHealth.ok, true, '健全仓应入组');

    const detailed = await discoverNestedReposDetailed(fx.main);
    assert.ok(detailed.healthy.includes('plugins/b'));
    assert.ok(detailed.healthy.includes('plugins/c'));
    assert.ok(!detailed.healthy.includes('plugins/no-head'));
    assert.ok(!detailed.healthy.includes('plugins/lost'));
    assert.ok(!detailed.healthy.includes('plugins/lost-ref'));
    const skipReasons = Object.fromEntries(detailed.skipped.map((s) => [s.path, s.reason]));
    assert.equal(skipReasons['plugins/no-head'], 'missing-head');
    assert.equal(skipReasons['plugins/lost'], 'lost-objects');
    assert.equal(skipReasons['plugins/lost-ref'], 'lost-objects');
    assert.ok((await discoverNestedReposDetailed(fx.main)).healthy.includes('plugins/b'));
    assert.ok(!(await discoverNestedReposDetailed(fx.main)).healthy.includes('plugins/no-head'));

    const onlyBroken = path.join(tmp, 'fx-health-all-bad');
    initRepo(onlyBroken, { 'a.txt': 'a\n' });
    const orphan = path.join(onlyBroken, 'plugins', 'orphan');
    fs.mkdirSync(path.join(orphan, '.git'), { recursive: true });
    const allBadDisc = await discoverNestedReposDetailed(onlyBroken);
    const allBadSel = selectHealthyNestedTargets(allBadDisc);
    assert.equal(allBadSel.ok, false, '全残缺建组必须失败');
    assert.match(allBadSel.ok ? '' : allBadSel.message, /全部残缺/);
    console.log('ok: 嵌套仓健全性（跳过告警 / 健全入组 / 全残缺报错）');
  }

  // ---------- 建组：容器结构镜像 / 每仓 ao 分支 / 容器排除（还原即红：去掉 exclude 调用转红） ----------
  if (inShard(2)) {
    const fx = mkGroup('fx-build', { bOnFeature: true });
    const { container, res } = await buildGroup(fx);
    assert.equal(res.ok, true, res.ok ? '' : res.message);
    assert.deepEqual(
      res.repos.map((r) => [r.path, r.branch, r.baseBranch]),
      [
        ['plugins/b', BRANCH, 'feature'],
        ['plugins/c', BRANCH, 'main']
      ],
      '每仓同名 ao 分支 + 各自 base（b 从 feature 建树）'
    );
    // 容器结构 = 主仓树 + b/c 树在真实相对位置（镜像主检出）
    assert.ok(fs.existsSync(path.join(container, 'a.txt')), '容器根=主仓 worktree');
    assert.ok(fs.statSync(path.join(container, 'plugins', 'b', '.git')).isFile(), 'b 树嵌在容器相对位置（gitfile）');
    assert.ok(fs.existsSync(path.join(container, 'plugins', 'b', 'feat.txt')), 'b 树内容=b 主检出 HEAD（feature）');
    assert.ok(fs.statSync(path.join(container, 'plugins', 'c', '.git')).isFile());
    // 分支注册在各仓自己 .git
    assert.equal(mustGit(['branch', '--list', BRANCH], fx.b).length > 0, true, 'b 注册 ao 分支');
    assert.equal(mustGit(['branch', '--list', BRANCH], fx.c).length > 0, true, 'c 注册 ao 分支');
    assert.equal(mustGit(['branch', '--list', BRANCH], fx.main).length > 0, true, '主仓注册容器分支');
    // 容器排除：嵌套仓目录在主仓视角 untracked，不排除容器恒脏
    const exclude = fs.readFileSync(path.join(fx.main, '.git', 'info', 'exclude'), 'utf8');
    assert.match(exclude, /\/plugins\/b\//);
    assert.match(exclude, /\/plugins\/c\//);
    assert.equal(mustGit(['status', '--porcelain', '-uall'], container), '', '容器 status 干净（嵌套仓被排除）');
    assert.equal(mustGit(['status', '--porcelain'], fx.main), '', '主检出 status 干净');
    console.log('ok: 建组（容器结构/每仓分支/容器排除）');

    // 零改动双检：b/c 树都未动
    assert.equal(
      await isRepoUnchanged({ repoMain: fx.b, worktreePath: path.join(container, 'plugins', 'b'), branch: BRANCH, baseBranch: 'feature' }),
      true,
      'b 未动'
    );
    // b 树提交后：领先提交>0 → 有改动（即便树干净）
    fs.writeFileSync(path.join(container, 'plugins', 'b', 'b2.txt'), 'x\n', 'utf8');
    mustGit(['add', '.'], path.join(container, 'plugins', 'b'));
    mustGit(['commit', '-qm', 'worker b'], path.join(container, 'plugins', 'b'));
    assert.equal(
      await isRepoUnchanged({ repoMain: fx.b, worktreePath: path.join(container, 'plugins', 'b'), branch: BRANCH, baseBranch: 'feature' }),
      false,
      'b 有领先提交'
    );
    // 只脏不提交 → 有改动（双检缺一不可）；探测完还原，让 c 回到真·零改动参与合入阶段
    fs.writeFileSync(path.join(container, 'plugins', 'c', 'c2.txt'), 'y\n', 'utf8');
    assert.equal(
      await isRepoUnchanged({ repoMain: fx.c, worktreePath: path.join(container, 'plugins', 'c'), branch: BRANCH, baseBranch: 'main' }),
      false,
      'c 树脏（未提交）'
    );
    fs.unlinkSync(path.join(container, 'plugins', 'c', 'c2.txt'));
    assert.equal(
      await isRepoUnchanged({ repoMain: fx.c, worktreePath: path.join(container, 'plugins', 'c'), branch: BRANCH, baseBranch: 'main' }),
      true,
      'c 还原后回到零改动'
    );
    console.log('ok: 零改动双检（脏 + 领先提交）');

    // ---------- 组级合入 happy path：零改动过滤 + 逐仓对称 target ----------
    const group = await integrateRepoGroup({
      mainRepo: fx.main,
      containerRoot: container,
      mainBranch: BRANCH,
      mainBaseBranch: 'main',
      repos: res.repos,
      merge: {}
    });
    assert.equal(group.ok, true, group.message);
    const byRepo = Object.fromEntries(group.entries.map((e) => [e.repo, e.status]));
    assert.equal(byRepo['plugins/b'], 'merged', 'b 合入');
    assert.equal(byRepo['plugins/c'], 'skipped-unchanged', 'c 预置分支冲突场景后已还原为零改动 → 未合（零改动过滤）');
    assert.equal(byRepo[''], 'skipped-unchanged', '主仓零改动跳过');
    // 对称 target：b 从 feature 建树 → 合回 feature，不碰 b 的 main
    assert.equal(mustGit(['rev-parse', '--abbrev-ref', 'HEAD'], fx.b), 'feature', 'b 主检出被切到 target');
    assert.match(mustGit(['log', 'feature', '--oneline'], fx.b), /worker b/);
    assert.doesNotMatch(mustGit(['log', 'main', '--oneline'], fx.b), /worker b/, 'b 的 main 不被搭车');
    // c 主检出零改动；主仓零改动
    assert.doesNotMatch(mustGit(['log', 'main', '--oneline'], fx.c), /worker/, 'c 零改动');
    assert.doesNotMatch(mustGit(['log', 'main', '--oneline'], fx.main), /worker/, '主仓零改动');
    console.log('ok: 组级合入（零改动过滤 + 逐仓对称 target）');

    // ---------- 逐仓清理：已合入仓静默拆树删分支；容器根最后拆 ----------
    const cleanB = await cleanupNestedWorktree({
      mainRepo: fx.main,
      repo: 'plugins/b',
      containerRoot: container,
      branch: BRANCH,
      baseBranch: 'feature'
    });
    assert.equal(cleanB.removed, true, `b 拆树失败：${cleanB.message ?? ''}`);
    assert.equal(mustGit(['branch', '--list', BRANCH], fx.b), '', 'b 已合入分支删除');
    assert.equal(fs.existsSync(path.join(container, 'plugins', 'b')), false, 'b 树目录已拆');
    const cleanC = await cleanupNestedWorktree({
      mainRepo: fx.main,
      repo: 'plugins/c',
      containerRoot: container,
      branch: BRANCH,
      baseBranch: 'main'
    });
    assert.equal(cleanC.removed, true, `c 拆树失败：${cleanC.message ?? ''}`);
    assert.equal(mustGit(['branch', '--list', BRANCH], fx.c), '', 'c 零改动分支（=base tip）删除');
    // 嵌套全拆后主仓容器根可正常移除（Windows 锁序：先嵌套后根）
    mustGit(['worktree', 'remove', container], fx.main);
    assert.equal(fs.existsSync(container), false, '容器根最后移除');
    console.log('ok: 逐仓清理（已合入/零改动仓静默清理，容器根殿后）');
  }

  // ---------- 建组失败整组回滚（还原即红：去掉 rollbackNestedWorktrees 调用转红） ----------
  if (inShard(3)) {
    const fx = mkGroup('fx-rollback');
    // 预置 c 已有同名 ao 分支 → c 的 worktree add -b 失败（branch already exists）
    mustGit(['branch', BRANCH], fx.c);
    const { container, res } = await buildGroup(fx);
    assert.equal(res.ok, false, 'c 建树应失败');
    assert.match(res.message, /plugins\/c/);
    assert.match(res.message, /回滚/);
    // 不留半组：b 的树与分支必须已回收
    assert.equal(fs.existsSync(path.join(container, 'plugins', 'b')), false, 'b 树已回滚');
    assert.equal(mustGit(['branch', '--list', BRANCH], fx.b), '', 'b 分支已回滚');
    assert.doesNotMatch(mustGit(['worktree', 'list', '--porcelain'], fx.b), new RegExp(BRANCH.replace(/[/\\]/g, '.')), 'b 无残留 worktree 注册');
    // c 自身未受影响（预置分支仍在，无新树）
    assert.equal(mustGit(['branch', '--list', BRANCH], fx.c).length > 0, true, 'c 预置分支原样保留');
    assert.equal(fs.existsSync(path.join(container, 'plugins', 'c')), false, 'c 无半建树');
    mustGit(['worktree', 'remove', '--force', container], fx.main); // 容器根回收由 service 层负责（接线守卫见文末）
    console.log('ok: 建组失败整组回滚（不留树不留分支）');
  }

  // ---------- 全或无预检：一仓冲突整组拒 + 零改动断言（还原即红：跳过 precheck 阶段转红） ----------
  if (inShard(4)) {
    assert.equal(
      await supportsMergeTreeWriteTree(mkGroup('fx-cap').main),
      true,
      '本机 git 支持 merge-tree --write-tree（≥2.38）；不支持时全或无预检降级，本组断言需人工核对'
    );
    const fx = mkGroup('fx-precheck');
    const { container, res } = await buildGroup(fx);
    assert.equal(res.ok, true, res.message);
    // b：干净改动（可合）；c：制造冲突（树上一改 + 主检出 target 上一改）；主仓容器也提交（主仓参与合入面）
    const bWt = path.join(container, 'plugins', 'b');
    const cWt = path.join(container, 'plugins', 'c');
    fs.writeFileSync(path.join(bWt, 'b.txt'), 'line=from-branch\n', 'utf8');
    mustGit(['add', '.'], bWt);
    mustGit(['commit', '-qm', 'b worker'], bWt);
    fs.writeFileSync(path.join(cWt, 'c.txt'), 'line=from-branch\n', 'utf8');
    mustGit(['add', '.'], cWt);
    mustGit(['commit', '-qm', 'c worker'], cWt);
    fs.writeFileSync(path.join(container, 'main-change.txt'), 'm\n', 'utf8');
    mustGit(['add', '.'], container);
    mustGit(['commit', '-qm', 'main worker'], container);
    mustGit(['checkout', '-q', 'main'], fx.c);
    fs.writeFileSync(path.join(fx.c, 'c.txt'), 'line=from-main\n', 'utf8');
    mustGit(['add', '.'], fx.c);
    mustGit(['commit', '-qm', 'c main moves'], fx.c);

    const tipBefore = {
      b: mustGit(['rev-parse', 'main'], fx.b),
      c: mustGit(['rev-parse', 'main'], fx.c),
      main: mustGit(['rev-parse', 'main'], fx.main)
    };
    const group = await integrateRepoGroup({
      mainRepo: fx.main,
      containerRoot: container,
      mainBranch: BRANCH,
      mainBaseBranch: 'main',
      repos: res.repos,
      merge: {}
    });
    assert.equal(group.ok, false, '一仓冲突应整组拒绝');
    assert.match(group.message, /全或无/);
    assert.match(group.message, /plugins\/c/);
    assert.match(group.message, /零改动/);
    const byRepo = Object.fromEntries(group.entries.map((e) => [e.repo, e.status]));
    assert.equal(byRepo['plugins/c'], 'failed', 'c 是阻断仓');
    assert.equal(byRepo['plugins/b'], 'blocked', 'b 被阻断未尝试');
    assert.equal(byRepo[''], 'blocked', '主仓被阻断未尝试');
    const cEntry = group.entries.find((e) => e.repo === 'plugins/c');
    assert.ok(cEntry.conflicts?.includes('c.txt'), `冲突文件清单含 c.txt：${JSON.stringify(cEntry.conflicts)}`);
    // 零改动断言：三仓 target tip 全部未动（还原预检 → b 真合入 → b tip 前进 → 转红）
    assert.equal(mustGit(['rev-parse', 'main'], fx.b), tipBefore.b, 'b 主检出零改动');
    assert.equal(mustGit(['rev-parse', 'main'], fx.c), tipBefore.c, 'c 主检出零改动');
    assert.equal(mustGit(['rev-parse', 'main'], fx.main), tipBefore.main, '主仓零改动');
    console.log('ok: 全或无预检（一仓冲突整组拒 + 零改动断言）');

    // ---------- 预检脏树拒绝：树未提交 → 整组拒 ----------
    fs.writeFileSync(path.join(bWt, 'b3.txt'), 'dirty\n', 'utf8');
    const dirty = await integrateRepoGroup({
      mainRepo: fx.main,
      containerRoot: container,
      mainBranch: BRANCH,
      mainBaseBranch: 'main',
      repos: res.repos,
      merge: {}
    });
    assert.equal(dirty.ok, false, '树脏应整组拒绝');
    assert.match(dirty.message, /未提交改动/);
    console.log('ok: 预检脏树整组拒');
  }

  // ---------- 未合入仓保留（归档清理语义） + 丢失容器 prune 兜底 ----------
  if (inShard(5)) {
    const fx = mkGroup('fx-keep');
    const { container, res } = await buildGroup(fx);
    assert.equal(res.ok, true, res.message);
    const bWt = path.join(container, 'plugins', 'b');
    fs.writeFileSync(path.join(bWt, 'b.txt'), 'unmerged work\n', 'utf8');
    mustGit(['add', '.'], bWt);
    mustGit(['commit', '-qm', 'unmerged'], bWt);
    // 未 integrate 直接归档：分支未合入（对该仓 base）→ 保留树+分支
    const kept = await cleanupNestedWorktree({
      mainRepo: fx.main,
      repo: 'plugins/b',
      containerRoot: container,
      branch: BRANCH,
      baseBranch: 'main'
    });
    assert.equal(kept.removed, false, '未合入仓保留树');
    assert.equal(kept.kept, 'unmerged');
    assert.equal(fs.existsSync(bWt), true, 'b 树保留');
    assert.equal(mustGit(['branch', '--list', BRANCH], fx.b).length > 0, true, 'b 分支保留');
    // 脏树保留
    fs.writeFileSync(path.join(container, 'plugins', 'c', 'c9.txt'), 'dirty\n', 'utf8');
    const keptDirty = await cleanupNestedWorktree({
      mainRepo: fx.main,
      repo: 'plugins/c',
      containerRoot: container,
      branch: BRANCH,
      baseBranch: 'main'
    });
    assert.equal(keptDirty.kept, 'dirty', '脏树保留');
    // 容器根被外部删除 → 逐仓 prune 悬空注册
    fs.rmSync(container, { recursive: true, force: true });
    await pruneNestedWorktrees(fx.main, ['plugins/b', 'plugins/c']);
    const wtList = `${mustGit(['worktree', 'list', '--porcelain'], fx.b)}\n${mustGit(['worktree', 'list', '--porcelain'], fx.c)}`;
    assert.doesNotMatch(wtList, new RegExp(container.replace(/\\/g, '\\\\').replace(/([.+*?^$()[\]{}|])/g, '\\$1')), '悬空注册已 prune');
    console.log('ok: 未合入/脏仓保留 + 容器丢失 prune 兜底');
  }
}

// ---------- 接线守卫（electron 依赖链离线不可跑，源码断言） ----------
// 2026-09-26 sessions.ts 拆分：建树接线在 sessions/createTerminal.ts、
// 收尾/自愈在 git/worktreeSessionOps.ts、合入在 git/worktreeIntegrate.ts——守卫随代码走
{
  const createTerminalSrc = fs.readFileSync(path.join(root, 'src', 'main', 'sessions', 'createTerminal.ts'), 'utf8');
  const opsSrc = fs.readFileSync(path.join(root, 'src', 'main', 'git', 'worktreeSessionOps.ts'), 'utf8');
  const integrateSrc = fs.readFileSync(path.join(root, 'src', 'main', 'git', 'worktreeIntegrate.ts'), 'utf8');
  assert.match(createTerminalSrc, /addSessionWorktreeGroup\(/, 'createTerminal 建树必须走组路径（无嵌套仓时等价单仓）');
  assert.match(createTerminalSrc, /worktreeRepoSet = res\.repos/, '建组成功必须把嵌套仓清单记进会话');
  assert.match(integrateSrc, /await integrateRepoGroup\(\{/, 'integrateWorktree 多仓组分支必须走组级合入');
  assert.match(opsSrc, /cleanupNestedRepoSet\(ctx, s\)/, '归档/删除清理必须先逐仓拆嵌套树');
  assert.match(opsSrc, /clearSessionWorktreeMetadata\(s\)/, '清理后必须走统一 worktree 记账删除入口');
  const metadataSrc = fs.readFileSync(path.join(root, 'src', 'shared', 'sessionWorktrees.ts'), 'utf8');
  assert.match(metadataSrc, /delete session\.worktreeRepoSet/, '统一入口必须清旧嵌套记账');
  assert.match(metadataSrc, /delete session\.worktreeGroups/, '统一入口必须清新组集合记账');
  assert.match(opsSrc, /pruneNestedWorktrees\(mainRepo/, 'heal 丢失自愈必须 prune 嵌套仓悬空注册');

  const serviceSrc = fs.readFileSync(path.join(root, 'src', 'main', 'git', 'service.ts'), 'utf8');
  assert.match(serviceSrc, /async addSessionWorktreeGroup\(/, 'service 暴露建组入口');
  assert.match(serviceSrc, /await this\.worktreeRemove\(res\.path, \{ force: true \}\)/, '嵌套建组失败必须回滚主仓容器根');
  assert.match(serviceSrc, /deleteMergedBranch\(root, branch, res.baseBranch\)/, '嵌套建组失败必须回收主仓分支');
  assert.match(serviceSrc, /selectHealthyNestedTargets/, '建组必须走健全性挑选（残缺跳过 / 全残缺报错）');
  assert.match(serviceSrc, /skippedNestedRepos/, '建组结果必须带回跳过的残缺仓供通知');
  assert.match(serviceSrc, /discoverNestedReposDetailed/, '建组扫描必须用含 skipped 的详细发现');

  assert.match(createTerminalSrc, /formatNestedRepoSkipWarning/, '建组跳过残缺仓必须组告警文案');
  assert.match(createTerminalSrc, /skippedNestedRepos/, 'createTerminal 必须接住跳过清单');
  assert.match(createTerminalSrc, /label: t\('嵌套仓残缺'\)/, '通知 label 点明残缺嵌套仓');
  assert.match(
    createTerminalSrc,
    /label: t\('嵌套仓残缺'\)[\s\S]{0,180}toast:\s*true/,
    '残缺仓告警必须弹桌面通知'
  );

  const nestedSrc = fs.readFileSync(path.join(root, 'src', 'main', 'git', 'nestedRepos.ts'), 'utf8');
  assert.match(nestedSrc, /--git-dir/, '健全性核 HEAD 必须 --git-dir 钉死该仓（防向上回退）');
  assert.match(nestedSrc, /HEAD\^\{commit\}/, '核对象必须剥到 commit（裸 --verify HEAD 丢对象仍成功）');
  assert.match(nestedSrc, /inspectNestedRepoHealth/, '发现路径必须走健全性校验');

  const delegateSrc = fs.readFileSync(path.join(root, 'src', 'main', 'tasks', 'delegate.ts'), 'utf8');
  assert.match(delegateSrc, /repoSet: repoSetForCreate/, 'delegate 必须把集合透传 createTerminal（同口径建组）');
  assert.match(delegateSrc, /buildNestedRepoBriefNote\(\{/, 'delegate 简报必须附预计涉及插件提示');
  assert.match(delegateSrc, /【多仓隔离组】/, '简报/GUI 首条消息都要带提示段');
  assert.match(delegateSrc, /repoNote: nestedRepoNote/, 'delegate 结果必须带回 repoSet 摘要');
  assert.match(delegateSrc, /selectHealthyNestedTargets/, 'delegate 预发现必须剔除残缺仓');
  assert.match(delegateSrc, /formatNestedRepoSkipWarning/, 'delegate 简报必须附残缺仓告警');

  // 会话创建和合入由各自的规范 Catalog 定义提供参数说明。
  const catalogTasksSrc = fs.readFileSync(path.join(root, 'src', 'main', 'capabilities', 'catalog', 'sessionsCore.ts'), 'utf8');
  assert.match(catalogTasksSrc, /isolationGroups: worktreeSelectionProperty/, '模型入口使用统一仓库组选取');
  assert.doesNotMatch(catalogTasksSrc, /repoSet:\s*\{/, '旧顶层选择参数已删除，底层多仓能力保留');
  const catalogSessionsSrc = fs.readFileSync(path.join(root, 'src', 'main', 'capabilities', 'catalog', 'sessionsOps.ts'), 'utf8');
  assert.match(catalogSessionsSrc, /any preflight conflict rejects all/i, 'Catalog sessions.integrate 声明组级语义');
  console.log('ok: 接线守卫（sessions/service/delegate/catalog）');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('[ok] multi-repo-worktree');
