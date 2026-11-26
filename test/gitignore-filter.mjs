/**
 * 嵌套仓发现的 .gitignore 过滤（src/main/git/gitignoreFilter.ts）：
 * - 匹配器语义（解析/锚定/级联/取反/父级排除不可救回/**）；
 * - 与真 `git check-ignore` 交叉验证（隔离全局 excludesFile，只比 .gitignore 语义；
 *   刻意不读 .git/info/exclude——宿主建组会往里写嵌套仓排除，读了会自我隐藏，
 *   该边界在文末用「info/exclude 命中仍保留」单独断言）；
 * - 发现过滤层级：范围根保护 / 最近包围仓判定 / 包围仓被过滤时子树连带 / 无包围仓保留。
 * 还原即红锚点：还原 discoveryCache/nestedRepos 对 filterGitignoreExcludedRepos 的调用，
 * 或整个还原 gitignoreFilter.ts → 对应断言转红。
 * Run: node test/gitignore-filter.mjs
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gitignore-filter-'));
const compile = createSharedCompiler(root, tmp);

const { parseGitignoreRules, createGitignoreMatcher, filterGitignoreExcludedRepos } =
  await import(pathToFileURL(compile('main/git/gitignoreFilter.ts')).href);

// ---------- 纯解析语义 ----------
{
  const rule = (line) => parseGitignoreRules(`${line}\n`, false)[0];
  assert.equal(parseGitignoreRules('\n# comment\n\n').length, 0, '空行/注释跳过');
  assert.equal(parseGitignoreRules('\ufeffrefs/\n', false).length, 1, 'BOM 剥离');
  const refs = rule('refs/');
  assert.equal(refs.dirOnly, true);
  assert.equal(refs.anchored, false, 'refs/ 无内部斜杠 → 任意深度匹配 basename');
  assert.equal(refs.negated, false);
  assert.equal(refs.regex.test('refs'), true);
  assert.equal(refs.regex.test('notrefs'), false);
  const top = rule('/top/');
  assert.equal(top.anchored, true, '首斜杠 → 锚定仓根');
  assert.equal(top.regex.test('top'), true);
  assert.equal(top.regex.test('a/top'), false);
  const sub = rule('a/b');
  assert.equal(sub.anchored, true, '含内部斜杠 → 锚定 .gitignore 所在目录');
  assert.equal(sub.regex.test('a/b'), true);
  assert.equal(sub.regex.test('b'), false);
  const anyDepth = rule('**/tmp');
  assert.equal(anyDepth.regex.test('tmp'), true);
  assert.equal(anyDepth.regex.test('x/y/tmp'), true);
  assert.equal(anyDepth.regex.test('x/tmpz'), false);
  const inside = rule('logs/**');
  assert.equal(inside.regex.test('logs/a'), true);
  assert.equal(inside.regex.test('logs/a/b'), true);
  assert.equal(inside.regex.test('logs'), false, 'logs/** 只匹配目录内部');
  const midDouble = rule('a/**/b');
  assert.equal(midDouble.regex.test('a/b'), true);
  assert.equal(midDouble.regex.test('a/x/y/b'), true);
  assert.equal(midDouble.regex.test('a/xb'), false);
  const neg = rule('!keep');
  assert.equal(neg.negated, true);
  const star = rule('pl?gins/[bc]*');
  assert.equal(star.regex.test('plugins/bee'), true);
  assert.equal(star.regex.test('plugins/axy'), false);
  const escaped = rule('\\#hash');
  assert.equal(escaped.regex.test('#hash'), true, '\\# 转义为字面 #');
  console.log('ok: gitignore 解析语义（锚定/深度/**/转义/字符类）');
}

// ---------- 真 git fixture + check-ignore 交叉验证 ----------
let gitOk = true;
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' });
} catch {
  gitOk = false;
}

if (!gitOk) {
  console.log('skip: 本机无 git，跳过 check-ignore 交叉验证（纯解析断言已跑）');
} else {
  for (const key of Object.keys(process.env)) if (key.startsWith('GIT_')) delete process.env[key];
  process.env.GIT_CONFIG_GLOBAL = path.join(tmp, 'empty.gitconfig');
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL, '');
  const git = (cwd, ...args) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const repo = path.join(tmp, 'cross');
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');

  fs.writeFileSync(path.join(repo, '.gitignore'), [
    'refs/',
    '.dev-sandbox/',
    'build',
    '/top/',
    '**/tmp',
    'logs/**',
    'a/**/b',
    'dist/',
    '!dist/keep/',
    '',
    '# trailing comment',
    '*.bak'
  ].join('\n'), 'utf8');
  // 级联：子目录 .gitignore 覆盖父层（deeper wins）
  fs.mkdirSync(path.join(repo, 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'plugins', '.gitignore'), ['!refs/', 'sandbox/'].join('\n'), 'utf8');

  // 目录树（全按目录检查——发现过滤只对目录路径判定）
  const dirs = [
    'refs', 'refs/clone', '.dev-sandbox', '.dev-sandbox/clone', 'x/refs',
    'build', 'deep/build', 'buildx',
    'top', 'sub/top',
    'tmp', 'x/y/tmp', 'tmpz',
    'logs', 'logs/a', 'logs/a/b', 'xlogs',
    'a/b', 'a/x/b', 'a/x/y/b', 'a/bb',
    'dist', 'dist/keep', 'dist/keep/x', 'dist/other',
    'plugins/refs', 'plugins/refs/clone', 'plugins/sandbox', 'plugins/sandbox/c',
    'normal', 'plugins/normal'
  ];
  for (const dir of dirs) fs.mkdirSync(path.join(repo, ...dir.split('/')), { recursive: true });

  const checkIgnore = (rel) => {
    try {
      execFileSync('git', ['check-ignore', '-q', '--', rel], {
        cwd: repo, stdio: 'ignore', windowsHide: true,
        env: { ...process.env }
      });
      return true;
    } catch (error) {
      if (error.status === 1) return false;
      throw error;
    }
  };
  const matcher = createGitignoreMatcher();
  const mismatch = [];
  for (const dir of dirs) {
    const expected = checkIgnore(dir);
    const actual = await matcher.excluded(repo, dir);
    if (expected !== actual) mismatch.push(`${dir}: git=${expected} ours=${actual}`);
  }
  assert.deepEqual(mismatch, [], `与 git check-ignore 语义不一致：${mismatch.join('；')}`);
  assert.equal(checkIgnore('dist/keep/x'), true, 'git 口径：父目录 dist 被排除时 !dist/keep 救不回子树');
  console.log(`ok: ${dirs.length} 个路径与 git check-ignore 交叉验证一致（含级联/取反/父级排除）`);
}

// ---------- info/exclude 刻意不读（建组自写排除不得自我隐藏） ----------
{
  const repo = path.join(tmp, 'exclude-guard');
  fs.mkdirSync(path.join(repo, 'plugins', 'b'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.gitignore'), 'nothing-ignored\n', 'utf8');
  const gitDir = path.join(repo, '.git');
  fs.mkdirSync(path.join(gitDir, 'info'), { recursive: true });
  // 模拟 ensureNestedReposExclude 的产物
  fs.writeFileSync(path.join(gitDir, 'info', 'exclude'), '# Muster Console: session worktrees\n/plugins/b/\n', 'utf8');
  const matcher = createGitignoreMatcher();
  assert.equal(await matcher.excluded(repo, 'plugins/b'), false, 'info/exclude 命中不算 .gitignore 忽略');
  console.log('ok: .git/info/exclude 刻意不参与判定（建组自写排除不自我隐藏）');
}

// ---------- filterGitignoreExcludedRepos：发现过滤层级 ----------
{
  const mkRepo = (dir, gitignore) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
    if (gitignore !== undefined) fs.writeFileSync(path.join(dir, '.gitignore'), gitignore, 'utf8');
    return dir;
  };
  // 场景 1：用户报场景——主仓 .gitignore 命中 refs/、.dev-sandbox/，正常 plugins 保留
  const main = mkRepo(path.join(tmp, 'f1'), 'refs/\n.dev-sandbox/\n.dev-sandbox-template/\n');
  const cloneA = mkRepo(path.join(main, 'refs', 'clone-a'));
  const cloneB = mkRepo(path.join(main, '.dev-sandbox', 'clone-b'));
  const ok = mkRepo(path.join(main, 'plugins', 'ok'));
  const kept1 = await filterGitignoreExcludedRepos(main, [main, cloneA, cloneB, ok]);
  assert.deepEqual(kept1, [main, ok], '.gitignore 命中的嵌套仓被过滤，范围根与未忽略仓保留');

  // 场景 2：级联（子目录 .gitignore）+ 最近包围仓判定（嵌套套嵌套按内层仓的规则）
  const main2 = mkRepo(path.join(tmp, 'f2'));
  const plug = mkRepo(path.join(main2, 'Plugins', 'P'), 'sandbox/\n');
  mkRepo(path.join(main2, 'Plugins', 'P', 'sandbox', 'S'));
  mkRepo(path.join(main2, 'Plugins', 'P', 'vendor', 'V'));
  const kept2 = await filterGitignoreExcludedRepos(main2, [main2, plug, path.join(main2, 'Plugins', 'P', 'sandbox', 'S'), path.join(main2, 'Plugins', 'P', 'vendor', 'V')]);
  assert(kept2.includes(plug), '未忽略的中间仓保留');
  assert(!kept2.includes(path.join(main2, 'Plugins', 'P', 'sandbox', 'S')), '最近包围仓的 .gitignore 命中即过滤');
  assert(kept2.includes(path.join(main2, 'Plugins', 'P', 'vendor', 'V')), '内层仓未命中的嵌套保留');

  // 场景 3：包围仓自身被过滤 → 子树连带过滤（.dev-sandbox 整体被主仓忽略，其内嵌套同理）
  const main3 = mkRepo(path.join(tmp, 'f3'), '.vendor/\n');
  const vendor = mkRepo(path.join(main3, '.vendor', 'V'));
  const deep = mkRepo(path.join(main3, '.vendor', 'V', 'sub'));
  const kept3 = await filterGitignoreExcludedRepos(main3, [main3, vendor, deep]);
  assert.deepEqual(kept3, [main3], '被忽略仓与其内部嵌套一并过滤');

  // 场景 4：无包围仓（范围根不是 git 仓）→ 顶层仓全保留（用户登记优先）
  const scope4 = path.join(tmp, 'f4');
  fs.mkdirSync(scope4, { recursive: true });
  const r1 = mkRepo(path.join(scope4, 'repo1'));
  const r2 = mkRepo(path.join(scope4, 'repo2'));
  const kept4 = await filterGitignoreExcludedRepos(scope4, [r1, r2]);
  assert.deepEqual(kept4, [r1, r2], '范围根非仓且无包围仓时不判忽略');

  // 场景 5：范围根自身被外层仓忽略 → 范围根与其嵌套照常保留（登记即权威）
  const outer = mkRepo(path.join(tmp, 'f5'), 'inner/\n');
  const scope5 = mkRepo(path.join(outer, 'inner', 'checkout'));
  const nested5 = mkRepo(path.join(scope5, 'plugins', 'x'));
  const kept5 = await filterGitignoreExcludedRepos(scope5, [scope5, nested5]);
  assert.deepEqual(kept5, [scope5, nested5], '包围仓在扫描范围外时不判忽略');
  assert.equal((await filterGitignoreExcludedRepos(outer, [outer, scope5, nested5])).length, 1, '同树从外层仓扫描时被过滤');
  console.log('ok: 发现过滤层级（范围根保护 / 最近包围仓 / 子树连带 / 无包围保留）');
}

console.log('done: gitignore-filter');
