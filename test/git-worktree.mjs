/**
 * P3.5 worktree：porcelain 解析 / 命名派生 / exclude 注入（纯函数）+ 真 git 输出对照。
 * Run: node test/git-worktree.mjs
 */
// @test-shards 4
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { inShard } from './helpers/shard.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'git-worktree-'));
const compile = createSharedCompiler(root, tmp);

// ---------- 纯函数（src/main/git/worktree.ts，无 electron 依赖）----------
const out = compile('main/git/worktree.ts');
const {
  parseWorktreePorcelain,
  slugifyWorktree,
  sessionWorktreeId8,
  sessionWorktreeDirName,
  sessionWorktreeBranch,
  ensureWorktreesExclude,
  parseOriginHeadRef,
  pickDefaultBranch
} = await import(pathToFileURL(out).href);

// porcelain 解析：主 + linked + detached
{
  const text = [
    'worktree /repo/main',
    'HEAD abc123def4567890abc123def4567890abc12345',
    'branch refs/heads/main',
    '',
    'worktree /repo/.worktrees/abcd1111-fix-login',
    'HEAD fedcba0987654321fedcba0987654321fedcba09',
    'branch refs/heads/ao/abcd1111',
    '',
    'worktree /repo/.worktrees/abcd2222',
    'HEAD 2222222222222222222222222222222222222222',
    'branch refs/heads/ao/abcd2222',
    '',
    'worktree /repo/.worktrees/other',
    'HEAD 1111111111111111111111111111111111111111',
    'detached',
    ''
  ].join('\n');
  const list = parseWorktreePorcelain(text);
  assert.equal(list.length, 4);
  assert.equal(list[0].path, '/repo/main');
  assert.equal(list[0].branch, 'main', 'refs/heads/ 前缀剥掉');
  assert.equal(list[1].path, '/repo/.worktrees/abcd1111-fix-login', '存量长名目录仍可解析');
  assert.equal(list[1].branch, 'ao/abcd1111');
  assert.equal(list[2].path, '/repo/.worktrees/abcd2222', '新规则纯 id8 目录');
  assert.equal(list[2].branch, 'ao/abcd2222');
  assert.equal(list[3].detached, true);
  assert.equal(list[3].branch, undefined);

  // 空输入 / 尾块无空行
  assert.deepEqual(parseWorktreePorcelain(''), []);
  const noTrailing = parseWorktreePorcelain('worktree /a\nHEAD x\nbranch refs/heads/b');
  assert.equal(noTrailing.length, 1);
  assert.equal(noTrailing[0].branch, 'b');
  console.log('ok: parseWorktreePorcelain');
}

// 命名派生：目录名纯 id8，与分支 ao/<id8> 对齐；会话名不进路径
{
  const SID = '12345678-4321-4321-4321-cba987654321';
  assert.equal(slugifyWorktree('修复登录: bug*fix?'), '修复登录-bug-fix');
  assert.equal(slugifyWorktree('   '), 'work', '空名兜底');
  assert.equal(slugifyWorktree('...---'), 'work', '只剩标点兜底');

  assert.equal(sessionWorktreeId8(SID), '12345678');
  assert.equal(sessionWorktreeDirName(SID), sessionWorktreeId8(SID), '目录名只取 sessionId 前 8 位');
  assert.equal(
    sessionWorktreeBranch(SID),
    'ao/12345678',
    '分支命名空间 ao/<sessionId8>'
  );
  assert.equal(
    sessionWorktreeDirName(SID),
    sessionWorktreeBranch(SID).slice('ao/'.length),
    '目录名与分支 id8 严格一致'
  );

  // 签名无 name 参：会话名（哪怕含非法字符/中文/空格）结构上进不了目录路径，
  // 旧 <id8>-<slug> 拼法不再可能生成；正常 id 的目录名恒为 8 位十六进制 id8
  assert.equal(sessionWorktreeDirName(''), 'session', '空 id 兜底');
  assert.equal(sessionWorktreeBranch(''), 'ao/session');
  assert.equal(
    sessionWorktreeDirName('ed70eaa7-c970-4f27-8975-16b4a1dfccf6'),
    'ed70eaa7'
  );
  console.log('ok: 命名派生');
}

{
  assert.equal(parseOriginHeadRef('refs/remotes/origin/main\n'), 'main');
  assert.equal(parseOriginHeadRef('origin/master'), 'master');
  assert.equal(parseOriginHeadRef(''), null);
  assert.equal(
    pickDefaultBranch({ originHead: 'main', localBranches: ['main', 'dev'], current: 'dev' }),
    'main'
  );
  assert.equal(
    pickDefaultBranch({ originHead: 'trunk', localBranches: ['main'], current: 'main' }),
    'main',
    'origin/HEAD 本地没有则退 main'
  );
  assert.equal(
    pickDefaultBranch({ originHead: null, localBranches: ['master'], current: 'topic' }),
    'master'
  );
  assert.equal(
    pickDefaultBranch({ originHead: null, localBranches: ['topic'], current: 'topic' }),
    'topic'
  );
  console.log('ok: pickDefaultBranch');
}

// exclude 注入：幂等 + 建 info 目录 + 不碰 .gitignore
{
  const repo = path.join(tmp, 'repo-exclude');
  fs.mkdirSync(path.join(repo, '.git', 'info'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules\n', 'utf8');
  // 已有 exclude 内容（用户自己的忽略）
  fs.writeFileSync(path.join(repo, '.git', 'info', 'exclude'), '*.log\n', 'utf8');

  ensureWorktreesExclude(repo);
  let content = fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8');
  assert.ok(content.includes('*.log'), '用户条目保留');
  assert.ok(content.split(/\r?\n/).some((l) => l.trim() === '/.worktrees/'));
  const first = content;

  ensureWorktreesExclude(repo);
  content = fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8');
  assert.equal(
    content.split(/\r?\n/).filter((l) => l.trim() === '/.worktrees/').length,
    1,
    '幂等不重复追加'
  );
  assert.equal(content, first);
  assert.equal(
    fs.readFileSync(path.join(repo, '.gitignore'), 'utf8'),
    'node_modules\n',
    '不碰用户 .gitignore'
  );

  // info 目录不存在 → 创建
  const repo2 = path.join(tmp, 'repo-exclude2');
  fs.mkdirSync(path.join(repo2, '.git'), { recursive: true });
  ensureWorktreesExclude(repo2);
  assert.ok(
    fs.readFileSync(path.join(repo2, '.git', 'info', 'exclude'), 'utf8').includes('/.worktrees/')
  );
  console.log('ok: ensureWorktreesExclude');
}

// ---------- 真 git 对照：porcelain 输出与解析器一致 + 脏拒删纪律 ----------
{
  let gitOk = true;
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
  } catch {
    gitOk = false;
  }
  if (!gitOk) {
    console.log('skip: 本机无 git，跳过真实 worktree 对照');
  } else {
    const iso = await compileMergeIsolate();

    if (inShard(0)) {
      const main = path.join(tmp, 'repo-real');
      fs.mkdirSync(main, { recursive: true });
      const git = (args, cwd = main) =>
        execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString();

      git(['init', '-b', 'main']);
      git(['config', 'user.email', 't@t']);
      git(['config', 'user.name', 't']);
      fs.writeFileSync(path.join(main, 'a.txt'), 'a\n', 'utf8');
      git(['add', '.']);
      git(['commit', '-m', 'init']);

      // 模拟 service.worktreeAdd 的参数形状：worktree add -b ao/<id> <dir> HEAD
      const wtDir = path.join(main, '.worktrees', 'abcd1111-fix-login');
      fs.mkdirSync(path.dirname(wtDir), { recursive: true });
      git(['worktree', 'add', '-b', 'ao/abcd1111', wtDir, 'HEAD']);

      // 真实 porcelain 输出 → 解析器
      const porcelain = git(['worktree', 'list', '--porcelain']);
      const list = parseWorktreePorcelain(porcelain);
      assert.equal(list.length, 2);
      assert.equal(list[0].branch, 'main');
      assert.equal(list[1].branch, 'ao/abcd1111');
      assert.ok(pathKeyEq(list[1].path, wtDir), `worktree 路径解析：${list[1].path}`);

      // exclude：worktree 在主仓工作区内出现为 untracked → exclude 注入后 status 干净
      ensureWorktreesExclude(main);
      const status = git(['status', '--porcelain']);
      assert.equal(status.trim(), '', `exclude 注入后主仓应干净：${status}`);

      // 脏拒删：不带 --force 删除脏 worktree 必须失败（AO 纪律）
      fs.writeFileSync(path.join(wtDir, 'b.txt'), 'dirty\n', 'utf8');
      let refused = false;
      try {
        execFileSync('git', ['worktree', 'remove', wtDir], {
          cwd: main,
          stdio: ['ignore', 'ignore', 'ignore']
        });
      } catch {
        refused = true;
      }
      assert.ok(refused, '脏 worktree 不带 --force 应删除失败');
      // force 后可删
      git(['worktree', 'remove', '--force', wtDir]);
      assert.ok(!fs.existsSync(wtDir), 'force 删除成功');
      console.log('ok: 真实 git worktree 对照');
    }

    // 合入：worktree 提交 → 主仓 merge → 再删 worktree（模拟宿主路径）
    if (inShard(1)) {
      const main2 = path.join(tmp, 'repo-merge');
      fs.mkdirSync(main2, { recursive: true });
      const git2 = (args, cwd = main2) =>
        execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
      git2(['init', '-b', 'main']);
      git2(['config', 'user.email', 't@t']);
      git2(['config', 'user.name', 't']);
      fs.writeFileSync(path.join(main2, 'a.txt'), 'a\n', 'utf8');
      git2(['add', '.']);
      git2(['commit', '-m', 'init']);
      const wt2 = path.join(main2, '.worktrees', 'merge-me');
      fs.mkdirSync(path.dirname(wt2), { recursive: true });
      git2(['worktree', 'add', '-b', 'ao/merge1', wt2, 'HEAD']);
      ensureWorktreesExclude(main2);
      fs.writeFileSync(path.join(wt2, 'feat.txt'), 'feat\n', 'utf8');
      git2(['add', '.'], wt2);
      git2(['commit', '-m', 'feat'], wt2);

      fs.writeFileSync(path.join(wt2, 'extra.txt'), 'x\n', 'utf8');
      const refusedWt = await iso.mergeIsolateBranch({
        mainRepo: main2,
        worktreePath: wt2,
        branch: 'ao/merge1'
      });
      assert.equal(refusedWt.ok, false, '脏 worktree 拒绝合入');
      fs.unlinkSync(path.join(wt2, 'extra.txt'));

      fs.writeFileSync(path.join(main2, 'wip.txt'), 'wip\n', 'utf8');
      const mergedDirty = await iso.mergeIsolateBranch({
        mainRepo: main2,
        worktreePath: wt2,
        branch: 'ao/merge1'
      });
      assert.equal(mergedDirty.ok, true, mergedDirty.message);
      assert.equal(mergedDirty.target, 'main');
      assert.match(fs.readFileSync(path.join(main2, 'feat.txt'), 'utf8'), /feat\r?\n/, '主仓脏也能合入');
      assert.match(fs.readFileSync(path.join(main2, 'wip.txt'), 'utf8'), /wip\r?\n/, '主仓未提交文件应保留');
      fs.unlinkSync(path.join(main2, 'wip.txt'));

      const again = await iso.mergeIsolateBranch({
        mainRepo: main2,
        worktreePath: wt2,
        branch: 'ao/merge1'
      });
      assert.equal(again.ok, true);
      assert.equal(again.alreadyMerged, true);

      git2(['worktree', 'remove', wt2]);
      const del = await iso.deleteMergedBranch(main2, 'ao/merge1');
      assert.equal(del.ok, true, del.message);
      assert.ok(!fs.existsSync(wt2));
      console.log('ok: mergeIsolate 真 git 合入');
    }

    // 冲突合入：结构化报告（冲突文件清单 + 领先提交数），abort 后主仓无残留
    if (inShard(2)) {
      const main5 = path.join(tmp, 'repo-conflict');
      fs.mkdirSync(main5, { recursive: true });
      const git5 = (args, cwd = main5) =>
        execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
      git5(['init', '-b', 'main']);
      git5(['config', 'user.email', 't@t']);
      git5(['config', 'user.name', 't']);
      fs.writeFileSync(path.join(main5, 'shared.txt'), 'line=base\n', 'utf8');
      git5(['add', '.']);
      git5(['commit', '-m', 'init']);
      const wt5 = path.join(main5, '.worktrees', 'conflict-me');
      fs.mkdirSync(path.dirname(wt5), { recursive: true });
      git5(['worktree', 'add', '-b', 'ao/conf1', wt5, 'HEAD']);
      fs.writeFileSync(path.join(wt5, 'shared.txt'), 'line=from-branch\n', 'utf8');
      git5(['add', '.'], wt5);
      git5(['commit', '-m', 'branch edit'], wt5);
      fs.writeFileSync(path.join(main5, 'shared.txt'), 'line=from-main\n', 'utf8');
      git5(['add', '.']);
      git5(['commit', '-m', 'main edit']);
      const conflict = await iso.mergeIsolateBranch({
        mainRepo: main5,
        worktreePath: wt5,
        branch: 'ao/conf1'
      });
      assert.equal(conflict.ok, false, '冲突合入应失败');
      assert.deepEqual(conflict.conflicts, ['shared.txt'], `冲突清单应含 shared.txt：${JSON.stringify(conflict.conflicts)}`);
      assert.equal(conflict.conflictClass?.judgment.includes('shared.txt'), true);
      assert.match(conflict.message, /shared\.txt/, '报告含冲突文件名');
      assert.match(conflict.message, /需裁定/, '报告含冲突分级');
      assert.match(conflict.message, /领先/, '报告含领先提交数');
      assert.equal(git5(['status', '--porcelain']).trim(), '', 'abort 后主仓工作区干净');
      git5(['worktree', 'remove', wt5]);
      console.log('ok: mergeIsolate 冲突结构化报告');
    }

    // R9：冲突分级 + 调用点（git grep 另一文件引用导出符号）
    if (inShard(3)) {
      const mainCs = path.join(tmp, 'repo-callsites');
      fs.mkdirSync(path.join(mainCs, 'src'), { recursive: true });
      const gitCs = (args, cwd = mainCs) =>
        execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
      gitCs(['init', '-b', 'main']);
      gitCs(['config', 'user.email', 't@t']);
      gitCs(['config', 'user.name', 't']);
      fs.writeFileSync(path.join(mainCs, 'src', 'lib.ts'), 'export function alpha() { return 1; }\n', 'utf8');
      fs.writeFileSync(path.join(mainCs, 'src', 'app.ts'), "import { alpha } from './lib';\nalpha();\n", 'utf8');
      gitCs(['add', '.']);
      gitCs(['commit', '-m', 'init']);
      const wtCs = path.join(mainCs, '.worktrees', 'cs');
      fs.mkdirSync(path.dirname(wtCs), { recursive: true });
      gitCs(['worktree', 'add', '-b', 'ao/cs', wtCs, 'HEAD']);
      fs.writeFileSync(path.join(wtCs, 'src', 'lib.ts'), 'export function alpha() { return 2; }\n', 'utf8');
      gitCs(['add', '.'], wtCs);
      gitCs(['commit', '-m', 'branch lib'], wtCs);
      fs.writeFileSync(path.join(mainCs, 'src', 'lib.ts'), 'export function alpha() { return 3; }\n', 'utf8');
      gitCs(['add', '.']);
      gitCs(['commit', '-m', 'main lib']);
      const cs = await iso.mergeIsolateBranch({
        mainRepo: mainCs,
        worktreePath: wtCs,
        branch: 'ao/cs'
      });
      assert.equal(cs.ok, false);
      assert.ok(cs.conflicts?.includes('src/lib.ts'));
      assert.equal(cs.conflictClass?.judgment.includes('src/lib.ts'), true);
      const hits = (cs.callSites ?? []).flatMap((c) => c.hits).join('\n');
      assert.match(hits, /app\.ts/, `调用点应含 app.ts：${hits}`);
      gitCs(['worktree', 'remove', '--force', wtCs]);
      console.log('ok: mergeIsolate 冲突调用点');
    }

    // P8：主仓脏文件与待合入重叠 → 准确文案，不是「未能列出冲突文件」
    if (inShard(4)) {
      const mainDirty = path.join(tmp, 'repo-dirty-overlap');
      fs.mkdirSync(mainDirty, { recursive: true });
      const gitD = (args, cwd = mainDirty) =>
        execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
      gitD(['init', '-b', 'main']);
      gitD(['config', 'user.email', 't@t']);
      gitD(['config', 'user.name', 't']);
      fs.writeFileSync(path.join(mainDirty, 'shared.txt'), 'base\n', 'utf8');
      gitD(['add', '.']);
      gitD(['commit', '-m', 'init']);
      const wtD = path.join(mainDirty, '.worktrees', 'd');
      fs.mkdirSync(path.dirname(wtD), { recursive: true });
      gitD(['worktree', 'add', '-b', 'ao/d1', wtD, 'HEAD']);
      fs.writeFileSync(path.join(wtD, 'shared.txt'), 'from-branch\n', 'utf8');
      gitD(['add', '.'], wtD);
      gitD(['commit', '-m', 'branch'], wtD);
      fs.writeFileSync(path.join(mainDirty, 'shared.txt'), 'local-wip\n', 'utf8');
      const overlap = await iso.mergeIsolateBranch({
        mainRepo: mainDirty,
        worktreePath: wtD,
        branch: 'ao/d1'
      });
      assert.equal(overlap.ok, false);
      assert.equal(overlap.blockReason, 'dirty-overlap');
      assert.ok(overlap.dirtyOverlap?.includes('shared.txt'));
      assert.match(overlap.message, /不是合并冲突/);
      assert.doesNotMatch(overlap.message, /未能列出冲突文件/);
      gitD(['worktree', 'remove', '--force', wtD]);
      console.log('ok: mergeIsolate 脏主仓重叠文案');
    }

    // stashMain:true：只暂存重叠文件让路，合入后 pop 恢复本地 WIP
    if (inShard(5)) {
      const mainStash = path.join(tmp, 'repo-stash-main');
      fs.mkdirSync(mainStash, { recursive: true });
      const gitS = (args, cwd = mainStash) =>
        execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
      gitS(['init', '-b', 'main']);
      gitS(['config', 'user.email', 't@t']);
      gitS(['config', 'user.name', 't']);
      fs.writeFileSync(path.join(mainStash, 'shared.txt'), 'base\n', 'utf8');
      fs.writeFileSync(path.join(mainStash, 'keep.txt'), 'keep-base\n', 'utf8');
      gitS(['add', '.']);
      gitS(['commit', '-m', 'init']);
      const wtS = path.join(mainStash, '.worktrees', 's');
      fs.mkdirSync(path.dirname(wtS), { recursive: true });
      gitS(['worktree', 'add', '-b', 'ao/s1', wtS, 'HEAD']);
      fs.writeFileSync(path.join(wtS, 'shared.txt'), 'from-branch\n', 'utf8');
      gitS(['add', '.'], wtS);
      gitS(['commit', '-m', 'branch'], wtS);
      fs.writeFileSync(path.join(mainStash, 'shared.txt'), 'local-wip\n', 'utf8');
      fs.writeFileSync(path.join(mainStash, 'keep.txt'), 'keep-wip\n', 'utf8');
      const stashed = await iso.mergeIsolateBranch({
        mainRepo: mainStash,
        worktreePath: wtS,
        branch: 'ao/s1',
        stashMain: true
      });
      assert.equal(stashed.ok, true, `stashMain 应让路合入：${stashed.message}`);
      assert.notEqual(stashed.blockReason, 'dirty-overlap');
      assert.match(
        fs.readFileSync(path.join(mainStash, 'keep.txt'), 'utf8'),
        /keep-wip/,
        '非重叠 WIP 不应被 stash 带走'
      );
      const sharedAfter = fs.readFileSync(path.join(mainStash, 'shared.txt'), 'utf8');
      assert.match(sharedAfter, /from-branch|local-wip|<<<<<<</, `合入后 shared.txt 不应停在 base：${sharedAfter}`);
      gitS(['worktree', 'remove', '--force', wtS]);
      console.log('ok: mergeIsolate stashMain 重叠让路');
    }

    if (inShard(6)) {
      // 回归（2026-09-22 评审）：用户既有 stash 不得被误弹——stashMain 流程全程
      // 只动自己 push 的那条；冲突路径 abort+pop 后主仓无残留、文案如实。
      // 还原即红：porcelain 输出改回 trim（XY 首列被吃、重叠检测失灵→dirty-overlap 误拒）
      // 或 restoreStash 整个删掉（stash 滞留/WIP 不还原）即挂。tip 比对与 restoreStash 的
      // 一次性守卫防的是更窄的竞态/落穿路径，本 fixture 不构造其触发条件，属防御性实现。
      const mainStash2 = path.join(tmp, 'repo-stash-user');
      fs.mkdirSync(mainStash2, { recursive: true });
      const gitS2 = (args, cwd = mainStash2) =>
        execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
      gitS2(['init', '-b', 'main']);
      gitS2(['config', 'user.email', 't@t']);
      gitS2(['config', 'user.name', 't']);
      gitS2(['config', 'core.autocrlf', 'false']);
      fs.writeFileSync(path.join(mainStash2, 'shared.txt'), 'l1\nl2\nl3\n', 'utf8');
      fs.writeFileSync(path.join(mainStash2, 'mine.txt'), 'mine-base', 'utf8');
      gitS2(['add', '.']);
      gitS2(['commit', '-m', 'init']);
      // 用户自己先 stash 了一份改动（栈底是用户的，碰不得）
      fs.writeFileSync(path.join(mainStash2, 'mine.txt'), 'mine-wip', 'utf8');
      gitS2(['stash', 'push', '-m', 'user-own']);
      assert.match(gitS2(['stash', 'list']), /user-own/, '前置：用户 stash 已在栈上');

      const wtS2 = path.join(mainStash2, '.worktrees', 's2');
      fs.mkdirSync(path.dirname(wtS2), { recursive: true });
      gitS2(['worktree', 'add', '-b', 'ao/s2', wtS2, 'HEAD']);
      // 分支只在文件尾追加（与主仓 WIP 改首行是不相交 hunk，pop 可干净应用）
      fs.writeFileSync(path.join(wtS2, 'shared.txt'), 'l1\nl2\nl3\nfrom-branch\n', 'utf8');
      gitS2(['add', '.'], wtS2);
      gitS2(['commit', '-m', 'branch'], wtS2);
      // 主仓重叠 WIP（shared.txt 在 mergeFiles 里；只改首行）
      fs.writeFileSync(path.join(mainStash2, 'shared.txt'), 'l1-wip\nl2\nl3\n', 'utf8');
      const merged2 = await iso.mergeIsolateBranch({
        mainRepo: mainStash2,
        worktreePath: wtS2,
        branch: 'ao/s2',
        stashMain: true
      });
      assert.equal(merged2.ok, true, `stashMain 应让路合入：${merged2.message}`);
      const stashList = gitS2(['stash', 'list']);
      assert.doesNotMatch(stashList, /metaagent-integrate/, `metaagent 的 stash 已 pop 干净：${stashList}`);
      assert.match(stashList, /user-own/, `用户 stash 未被误弹/误用：${stashList}`);
      assert.match(fs.readFileSync(path.join(mainStash2, 'shared.txt'), 'utf8'), /l1-wip/, '重叠 WIP 已 pop 还原');
      gitS2(['worktree', 'remove', '--force', wtS2]);

      // 冲突 + stashMain：abort 后 pop 恢复 WIP，文案「主仓无残留」属实
      const mainStash3 = path.join(tmp, 'repo-stash-conflict');
      fs.mkdirSync(mainStash3, { recursive: true });
      const gitS3 = (args, cwd = mainStash3) =>
        execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
      gitS3(['init', '-b', 'main']);
      gitS3(['config', 'user.email', 't@t']);
      gitS3(['config', 'user.name', 't']);
      gitS3(['config', 'core.autocrlf', 'false']);
      fs.writeFileSync(path.join(mainStash3, 'shared.txt'), 'l1\nl2\nl3\n', 'utf8');
      gitS3(['add', '.']);
      gitS3(['commit', '-m', 'init']);
      // 分支先从 init 分叉，主仓再提交同区改动 → 两边真正分叉，merge 必冲突
      const wtS3 = path.join(mainStash3, '.worktrees', 's3');
      fs.mkdirSync(path.dirname(wtS3), { recursive: true });
      gitS3(['worktree', 'add', '-b', 'ao/s3', wtS3, 'HEAD']);
      fs.writeFileSync(path.join(wtS3, 'shared.txt'), 'branch-side\nl2\nl3\n', 'utf8');
      gitS3(['add', '.'], wtS3);
      gitS3(['commit', '-m', 'branch'], wtS3);
      fs.writeFileSync(path.join(mainStash3, 'shared.txt'), 'main-committed\nl2\nl3\n', 'utf8');
      gitS3(['add', '.']);
      gitS3(['commit', '-m', 'main-change']);
      // 主仓工作区把同一行改出第三种内容：既是重叠 WIP 又必然冲突
      fs.writeFileSync(path.join(mainStash3, 'shared.txt'), 'main-wip\nl2\nl3\n', 'utf8');
      const conflict2 = await iso.mergeIsolateBranch({
        mainRepo: mainStash3,
        worktreePath: wtS3,
        branch: 'ao/s3',
        stashMain: true
      });
      assert.equal(conflict2.ok, false, '冲突应失败');
      assert.equal(conflict2.blockReason, 'conflict');
      assert.match(conflict2.message, /主仓无残留/, `冲突文案：${conflict2.message}`);
      assert.equal(gitS3(['stash', 'list']).trim(), '', '冲突路径 stash 已 pop 干净');
      assert.match(fs.readFileSync(path.join(mainStash3, 'shared.txt'), 'utf8'), /main-wip/, '冲突路径重叠 WIP 已还原');
      gitS3(['worktree', 'remove', '--force', wtS3]);
      console.log('ok: mergeIsolate stashMain 用户 stash 幸存 + 冲突路径无残留');
    }

    if (inShard(7)) {
      // 回归（2026-09-23 评审 P1）：非 ASCII 路径的重叠检测——diff --name-only 默认
      // quotepath 输出带引号八进制转义，与 status 侧剥引号后的字面路径永不相等，
      // overlap 恒为空、stashMain:true 对中文文件名静默失效。还原即红：任一侧 -z 回退
      // （或改回逐行 trim 解析）后 overlap 恒为空 → 直接走 merge → 被 "would be
      // overwritten" 兜底拒绝。注意第一阶段断言在「仅回退 diff -z、保留 quotepath=false」
      // 的半回退态会经 parseOverwrittenFiles 兜底拿到同一字面路径而同形通过（黑盒不可
      // 区分）；独立的还原证据只有第二阶段 stashMain 让路合入。
      const mainCjk = path.join(tmp, 'repo-cjk-overlap');
      fs.mkdirSync(mainCjk, { recursive: true });
      const gitC = (args, cwd = mainCjk) =>
        execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
      gitC(['init', '-b', 'main']);
      gitC(['config', 'user.email', 't@t']);
      gitC(['config', 'user.name', 't']);
      gitC(['config', 'core.autocrlf', 'false']);
      const cjkFile = path.join(mainCjk, '中文 文件.txt');
      fs.writeFileSync(cjkFile, 'l1\nl2\nl3\n', 'utf8');
      gitC(['add', '.']);
      gitC(['commit', '-m', 'init']);
      const wtC = path.join(mainCjk, '.worktrees', 'cjk');
      fs.mkdirSync(path.dirname(wtC), { recursive: true });
      gitC(['worktree', 'add', '-b', 'ao/cjk', wtC, 'HEAD']);
      fs.writeFileSync(path.join(wtC, '中文 文件.txt'), 'l1\nl2\nl3\nfrom-branch\n', 'utf8');
      gitC(['add', '.'], wtC);
      gitC(['commit', '-m', 'branch'], wtC);
      // 主仓重叠 WIP：同一中文文件名未提交改动
      fs.writeFileSync(cjkFile, 'l1-wip\nl2\nl3\n', 'utf8');
      // 不带 stashMain：应在 merge 之前被 dirty-overlap 拦下，且重叠清单是字面中文路径
      const blocked = await iso.mergeIsolateBranch({
        mainRepo: mainCjk,
        worktreePath: wtC,
        branch: 'ao/cjk'
      });
      assert.equal(blocked.ok, false, `中文重叠应被拦：${blocked.message}`);
      assert.equal(blocked.blockReason, 'dirty-overlap');
      assert.ok(
        (blocked.dirtyOverlap ?? []).includes('中文 文件.txt'),
        `重叠清单须为字面中文路径（非八进制转义）：${JSON.stringify(blocked.dirtyOverlap)}`
      );
      // stashMain:true：中文路径重叠也能 stash 让路 → 合入 → pop 还原 WIP
      const mergedC = await iso.mergeIsolateBranch({
        mainRepo: mainCjk,
        worktreePath: wtC,
        branch: 'ao/cjk',
        stashMain: true
      });
      assert.equal(mergedC.ok, true, `stashMain 应让路合入：${mergedC.message}`);
      assert.doesNotMatch(gitC(['stash', 'list']), /metaagent-integrate/, '中文重叠 stash 已 pop 干净');
      assert.match(fs.readFileSync(cjkFile, 'utf8'), /l1-wip/, '中文重叠 WIP 已 pop 还原');
      gitC(['worktree', 'remove', '--force', wtC]);
      console.log('ok: mergeIsolate 非 ASCII 路径重叠检测（中文文件名 dirty-overlap + stashMain 让路）');
    }

    // P6：journal union — 两边追加合入后条目都不丢
    if (inShard(8)) {
      const mainJ = path.join(tmp, 'repo-journal-union');
      fs.mkdirSync(mainJ, { recursive: true });
      const gitJ = (args, cwd = mainJ) =>
        execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
      gitJ(['init', '-b', 'main']);
      gitJ(['config', 'user.email', 't@t']);
      gitJ(['config', 'user.name', 't']);
      fs.mkdirSync(path.join(mainJ, 'docs', 'journal'), { recursive: true });
      fs.writeFileSync(path.join(mainJ, '.gitattributes'), 'docs/journal/*.md merge=union\n', 'utf8');
      fs.writeFileSync(path.join(mainJ, 'docs', 'journal', '2026-09-15.md'), '# log\n\n## [A] 进行中\n- a\n', 'utf8');
      gitJ(['add', '.']);
      gitJ(['commit', '-m', 'init journal']);
      const wtJ = path.join(mainJ, '.worktrees', 'j');
      fs.mkdirSync(path.dirname(wtJ), { recursive: true });
      gitJ(['worktree', 'add', '-b', 'ao/j1', wtJ, 'HEAD']);
      fs.appendFileSync(path.join(wtJ, 'docs', 'journal', '2026-09-15.md'), '\n## [B] 已完成\n- b\n', 'utf8');
      gitJ(['add', '.'], wtJ);
      gitJ(['commit', '-m', 'journal B'], wtJ);
      fs.appendFileSync(path.join(mainJ, 'docs', 'journal', '2026-09-15.md'), '\n## [C] 已完成\n- c\n', 'utf8');
      gitJ(['add', '.']);
      gitJ(['commit', '-m', 'journal C']);
      const unioned = await iso.mergeIsolateBranch({
        mainRepo: mainJ,
        worktreePath: wtJ,
        branch: 'ao/j1'
      });
      assert.equal(unioned.ok, true, unioned.message);
      const journal = fs.readFileSync(path.join(mainJ, 'docs', 'journal', '2026-09-15.md'), 'utf8');
      assert.match(journal, /\[B\]/);
      assert.match(journal, /\[C\]/);
      gitJ(['worktree', 'remove', wtJ]);
      console.log('ok: mergeIsolate journal union');
    }

    // R9：message + noFf 出现在 merge 提交
    if (inShard(9)) {
      const mainM = path.join(tmp, 'repo-msg');
      fs.mkdirSync(mainM, { recursive: true });
      const gitMsg = (args, cwd = mainM) =>
        execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
      gitMsg(['init', '-b', 'main']);
      gitMsg(['config', 'user.email', 't@t']);
      gitMsg(['config', 'user.name', 't']);
      fs.writeFileSync(path.join(mainM, 'a.txt'), 'a\n', 'utf8');
      gitMsg(['add', '.']);
      gitMsg(['commit', '-m', 'init']);
      const wtMsg = path.join(mainM, '.worktrees', 'm');
      fs.mkdirSync(path.dirname(wtMsg), { recursive: true });
      gitMsg(['worktree', 'add', '-b', 'ao/m1', wtMsg, 'HEAD']);
      fs.writeFileSync(path.join(wtMsg, 'feat.txt'), 'f\n', 'utf8');
      gitMsg(['add', '.'], wtMsg);
      gitMsg(['commit', '-m', 'feat'], wtMsg);
      const withMsg = await iso.mergeIsolateBranch({
        mainRepo: mainM,
        worktreePath: wtMsg,
        branch: 'ao/m1',
        message: 'integrate P6 P8 R9',
        noFf: true
      });
      assert.equal(withMsg.ok, true, withMsg.message);
      const log = gitMsg(['log', '-1', '--pretty=%s']);
      assert.match(log, /integrate P6 P8 R9/);
      const parents = gitMsg(['rev-list', '--parents', '-n', '1', 'HEAD']).trim().split(/\s+/);
      assert.ok(parents.length >= 3, 'noFf 应为 merge commit（≥2 父）');
      gitMsg(['worktree', 'remove', wtMsg]);
      console.log('ok: mergeIsolate message/noFf');
    }

    // 校验闸：package.json 变了且 typecheck 红灯 → 默认告警不回滚
    if (inShard(10)) {
      const mainG = path.join(tmp, 'repo-gate');
      fs.mkdirSync(mainG, { recursive: true });
      const gitG = (args, cwd = mainG) =>
        execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
      gitG(['init', '-b', 'main']);
      gitG(['config', 'user.email', 't@t']);
      gitG(['config', 'user.name', 't']);
      fs.writeFileSync(
        path.join(mainG, 'package.json'),
        JSON.stringify({ name: 'g', scripts: { typecheck: 'node -e "process.exit(1)"' } }),
        'utf8'
      );
      gitG(['add', '.']);
      gitG(['commit', '-m', 'init']);
      const wtG = path.join(mainG, '.worktrees', 'g');
      fs.mkdirSync(path.dirname(wtG), { recursive: true });
      gitG(['worktree', 'add', '-b', 'ao/g1', wtG, 'HEAD']);
      const pkg = JSON.parse(fs.readFileSync(path.join(wtG, 'package.json'), 'utf8'));
      pkg.version = '2.0.0';
      fs.writeFileSync(path.join(wtG, 'package.json'), JSON.stringify(pkg), 'utf8');
      gitG(['add', '.'], wtG);
      gitG(['commit', '-m', 'bump'], wtG);
      const gated = await iso.mergeIsolateBranch({
        mainRepo: mainG,
        worktreePath: wtG,
        branch: 'ao/g1',
        skipNpmInstall: true
      });
      assert.equal(gated.ok, true, gated.message);
      assert.equal(gated.gates?.typecheck, 'failed');
      assert.match(gated.message, /typecheck 失败/);
      assert.ok(fs.existsSync(path.join(mainG, 'package.json')));
      const ver = JSON.parse(fs.readFileSync(path.join(mainG, 'package.json'), 'utf8')).version;
      assert.equal(ver, '2.0.0', '默认 onGateFail=warn 不回滚');
      gitG(['worktree', 'remove', wtG]);
      console.log('ok: mergeIsolate typecheck 闸告警');
    }

    // 纯函数：冲突分级 / porcelain / 依赖文件
    if (inShard(11)) {
      assert.deepEqual(iso.classifyConflictFiles(['docs/journal/x.md', 'src/foo.ts']), {
        mechanical: ['docs/journal/x.md'],
        judgment: ['src/foo.ts']
      });
      assert.deepEqual(iso.parsePorcelainPaths(' M shared.txt\n?? wip.txt\n'), ['shared.txt', 'wip.txt']);
      assert.equal(iso.mergeBlockedByLocalChanges('error: Your local changes to the following files would be overwritten by merge'), true);
      assert.deepEqual(
        iso.parseOverwrittenFiles(
          'error: Your local changes to the following files would be overwritten by merge:\n\tshared.txt\nPlease commit your changes or stash them before you merge.\nAborting\n'
        ),
        ['shared.txt']
      );
      assert.equal(iso.mergeTouchedDepFiles(['src/a.ts']), false);
      assert.equal(iso.mergeTouchedDepFiles(['package.json']), true);
      assert.deepEqual(iso.extractExportSymbols('export function foo() {}\nexport class Bar {}'), [
        'foo',
        'Bar'
      ]);
      console.log('ok: mergeIsolate 纯函数');
    }

    // deleteMergedBranch 兜底 + isBranchMergedIntoDefault：已合入非 HEAD 分支 / 未合入分支
    if (inShard(12)) {
      const main3 = path.join(tmp, 'repo-branchdel');
      fs.mkdirSync(main3, { recursive: true });
      const git3 = (args, cwd = main3) =>
        execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
      git3(['init', '-b', 'main']);
      git3(['config', 'user.email', 't@t']);
      git3(['config', 'user.name', 't']);
      fs.writeFileSync(path.join(main3, 'a.txt'), 'a\n', 'utf8');
      git3(['add', '.']);
      git3(['commit', '-m', 'init']);
      // HEAD 停在 feat；ao/dup 基于 feat 建树并提交，然后只合入 main（HEAD 不动）
      git3(['checkout', '-b', 'feat']);
      fs.writeFileSync(path.join(main3, 'feat.txt'), 'feat\n', 'utf8');
      git3(['add', '.']);
      git3(['commit', '-m', 'feat']);
      const wt3 = path.join(main3, '.worktrees', 'dup');
      fs.mkdirSync(path.dirname(wt3), { recursive: true });
      git3(['worktree', 'add', '-b', 'ao/dup', wt3, 'HEAD']);
      fs.writeFileSync(path.join(wt3, 'dup.txt'), 'dup\n', 'utf8');
      git3(['add', '.'], wt3);
      git3(['commit', '-m', 'dup'], wt3);
      git3(['checkout', 'main']);
      git3(['merge', '--no-edit', 'ao/dup']);
      git3(['checkout', 'feat']);

      assert.equal(
        await iso.isBranchMergedIntoDefault(main3, 'ao/dup'),
        true,
        '已合入 main 的分支应判为已合入'
      );
      // 真实流程里 deleteMergedBranch 都在 worktreeRemove 之后调用：先摘树再删分支
      git3(['worktree', 'remove', wt3]);
      const delFallback = await iso.deleteMergedBranch(main3, 'ao/dup');
      assert.equal(
        delFallback.ok,
        true,
        `HEAD 在 feat 时删已合入 main 的分支应走 merge-base 兜底：${delFallback.message ?? ''}`
      );
      assert.equal(git3(['branch', '--list', 'ao/dup']).trim(), '', '兜底删除成功');

      const wt4 = path.join(main3, '.worktrees', 'stale');
      git3(['worktree', 'add', '-b', 'ao/stale', wt4, 'HEAD']);
      fs.writeFileSync(path.join(wt4, 'stale.txt'), 'stale\n', 'utf8');
      git3(['add', '.'], wt4);
      git3(['commit', '-m', 'stale'], wt4);
      assert.equal(
        await iso.isBranchMergedIntoDefault(main3, 'ao/stale'),
        false,
        '未合入分支应判为未合入'
      );
      git3(['worktree', 'remove', wt4]);
      const delStale = await iso.deleteMergedBranch(main3, 'ao/stale');
      assert.equal(delStale.ok, false, '未合入分支拒绝删除');
      assert.equal(delStale.unmerged, true, '失败原因可辨因为 unmerged');
      assert.ok(git3(['branch', '--list', 'ao/stale']).trim(), '未合入分支保留');
      console.log('ok: deleteMergedBranch 兜底 / isBranchMergedIntoDefault');
    }

    // R-18 target 对称语义（从哪建回哪）：主仓 HEAD 在 feature 分支建树（ao 基于 feature），
    // integrate 缺省 target（=只带会话 worktreeBaseBranch）合回 feature——
    // feature 领先提交与 worker 提交都不搭车进 main。
    // 还原本改动（target 解析去掉 baseBranch）→ 缺省合到 main、feature 领先提交被搭车进 main，下面断言转红。
    if (inShard(13)) {
      const mainSym = path.join(tmp, 'repo-base-sym');
      fs.mkdirSync(mainSym, { recursive: true });
      const gitSym = (args, cwd = mainSym) =>
        execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
      gitSym(['init', '-b', 'main']);
      gitSym(['config', 'user.email', 't@t']);
      gitSym(['config', 'user.name', 't']);
      fs.writeFileSync(path.join(mainSym, 'base.txt'), 'base\n', 'utf8');
      gitSym(['add', '.']);
      gitSym(['commit', '-m', 'init']);
      // 用户 HEAD 停在 feature 且领先 main 一个提交（搭车风险现场）
      gitSym(['checkout', '-b', 'feature']);
      fs.writeFileSync(path.join(mainSym, 'feat.txt'), 'feat\n', 'utf8');
      gitSym(['add', '.']);
      gitSym(['commit', '-m', 'feat ahead']);
      // 模拟 addSessionWorktree 正常路径：HEAD 正常（feature、非 ao/*）→
      // git worktree add -b ao/<id> <dir> HEAD，会话记录 worktreeBaseBranch='feature'
      const wtSym = path.join(mainSym, '.worktrees', 'sym1');
      fs.mkdirSync(path.dirname(wtSym), { recursive: true });
      gitSym(['worktree', 'add', '-b', 'ao/sym1', wtSym, 'HEAD']);
      ensureWorktreesExclude(mainSym);
      fs.writeFileSync(path.join(wtSym, 'worker.txt'), 'w\n', 'utf8');
      gitSym(['add', '.'], wtSym);
      gitSym(['commit', '-m', 'worker change'], wtSym);

      const sym = await iso.mergeIsolateBranch({
        mainRepo: mainSym,
        worktreePath: wtSym,
        branch: 'ao/sym1',
        baseBranch: 'feature'
      });
      assert.equal(sym.ok, true, sym.message);
      assert.equal(sym.target, 'feature', '缺省 target=建树 base（从哪建回哪）');
      const featureLog = gitSym(['log', 'feature', '--oneline']);
      const mainLog = gitSym(['log', 'main', '--oneline']);
      assert.match(featureLog, /worker change/, 'worker 提交合回 feature');
      assert.match(featureLog, /feat ahead/);
      assert.doesNotMatch(mainLog, /worker change/, 'worker 提交不得进 main');
      assert.doesNotMatch(mainLog, /feat ahead/, 'feature 领先提交不得搭车进 main');

      // 显式 targetBranch 仍最优先（不被会话 baseBranch 覆盖）
      gitSym(['checkout', 'main']);
      const wtSym2 = path.join(mainSym, '.worktrees', 'sym2');
      gitSym(['worktree', 'add', '-b', 'ao/sym2', wtSym2, 'HEAD']);
      fs.writeFileSync(path.join(wtSym2, 'w2.txt'), 'w2\n', 'utf8');
      gitSym(['add', '.'], wtSym2);
      gitSym(['commit', '-m', 'worker 2'], wtSym2);
      const explicit = await iso.mergeIsolateBranch({
        mainRepo: mainSym,
        worktreePath: wtSym2,
        branch: 'ao/sym2',
        targetBranch: 'feature',
        baseBranch: 'main'
      });
      assert.equal(explicit.ok, true, explicit.message);
      assert.equal(explicit.target, 'feature', '显式 targetBranch > baseBranch');
      gitSym(['worktree', 'remove', wtSym2]);

      // 旧会话无 worktreeBaseBranch → 回落默认分支（向后兼容）
      const wtSym3 = path.join(mainSym, '.worktrees', 'sym3');
      gitSym(['worktree', 'add', '-b', 'ao/sym3', wtSym3, 'HEAD']);
      fs.writeFileSync(path.join(wtSym3, 'w3.txt'), 'w3\n', 'utf8');
      gitSym(['add', '.'], wtSym3);
      gitSym(['commit', '-m', 'worker 3'], wtSym3);
      const legacy = await iso.mergeIsolateBranch({
        mainRepo: mainSym,
        worktreePath: wtSym3,
        branch: 'ao/sym3'
      });
      assert.equal(legacy.ok, true, legacy.message);
      assert.equal(legacy.target, 'main', '旧会话无 base 记录 → 默认分支');
      gitSym(['worktree', 'remove', wtSym3]);
      gitSym(['worktree', 'remove', wtSym]);
      console.log('ok: R-18 target 对称语义（base 缺省/显式优先/旧会话回落）');
    }

    // R-18 守卫场景：HEAD 在别的 ao/* 分支（review 残留）→ 起点与记录的 base 均回落默认分支，
    // 合入也回默认分支（detached 同路径）
    if (inShard(14)) {
      const mainGuard = path.join(tmp, 'repo-guard-base');
      fs.mkdirSync(mainGuard, { recursive: true });
      const gitGuard = (args, cwd = mainGuard) =>
        execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
      gitGuard(['init', '-b', 'main']);
      gitGuard(['config', 'user.email', 't@t']);
      gitGuard(['config', 'user.name', 't']);
      fs.writeFileSync(path.join(mainGuard, 'a.txt'), 'a\n', 'utf8');
      gitGuard(['add', '.']);
      gitGuard(['commit', '-m', 'init']);
      gitGuard(['checkout', '-b', 'ao/oldresidue']);
      fs.writeFileSync(path.join(mainGuard, 'residue.txt'), 'r\n', 'utf8');
      gitGuard(['add', '.']);
      gitGuard(['commit', '-m', 'residue']);
      assert.equal(
        await iso.resolveDefaultBranch(mainGuard),
        'main',
        'HEAD 在 ao/* 残留 → 守卫回落默认分支'
      );
      // 模拟守卫后的建树：baseRef=resolveDefaultBranch → git worktree add -b ao/<id> <dir> main
      const wtGuard = path.join(mainGuard, '.worktrees', 'guard1');
      fs.mkdirSync(path.dirname(wtGuard), { recursive: true });
      gitGuard(['worktree', 'add', '-b', 'ao/guard1', wtGuard, 'main']);
      ensureWorktreesExclude(mainGuard);
      fs.writeFileSync(path.join(wtGuard, 'guard.txt'), 'g\n', 'utf8');
      gitGuard(['add', '.'], wtGuard);
      gitGuard(['commit', '-m', 'guard work'], wtGuard);
      const guardMerged = await iso.mergeIsolateBranch({
        mainRepo: mainGuard,
        worktreePath: wtGuard,
        branch: 'ao/guard1',
        baseBranch: 'main'
      });
      assert.equal(guardMerged.ok, true, guardMerged.message);
      assert.equal(guardMerged.target, 'main', '守卫场景记录默认分支 → 合入回默认分支');
      assert.match(gitGuard(['log', 'main', '--oneline']), /guard work/);
      assert.doesNotMatch(gitGuard(['log', 'main', '--oneline']), /residue/, 'ao 残留提交不得随守卫路径进 main');
      gitGuard(['worktree', 'remove', wtGuard]);
      console.log('ok: R-18 base 守卫场景（ao 残留回落默认分支）');
    }
  }
}

// R-18 接线守卫：service 上报守卫后的实际起点、sessions 记录并在 integrate 缺省透传
// （electron 依赖链无法离线直跑，按 integrate-approval / select-workspace-isolate 的源码接线断言模式）
// 2026-09-26 sessions.ts 拆分：建树记录接线在 sessions/createTerminal.ts，合入透传在 git/worktreeIntegrate.ts
{
  const createTerminalSrc = fs.readFileSync(path.join(root, 'src', 'main', 'sessions', 'createTerminal.ts'), 'utf8');
  assert.match(
    createTerminalSrc,
    /worktreeBaseBranch = res\.baseBranch/,
    '建树成功后必须把实际起点分支记进会话（worktreeBaseBranch）'
  );
  const integrateSrc = fs.readFileSync(path.join(root, 'src', 'main', 'git', 'worktreeIntegrate.ts'), 'utf8');
  assert.match(
    integrateSrc,
    /baseBranch: s\.worktreeBaseBranch/,
    'integrateWorktree 必须把会话 base 传给 mergeIsolateBranch（缺省 target 来源）'
  );
  const serviceSrc = fs.readFileSync(path.join(root, 'src', 'main', 'git', 'service.ts'), 'utf8');
  assert.match(
    serviceSrc,
    /res\.baseBranch = baseRef \?\? head/,
    'addSessionWorktree 必须上报实际起点分支名（守卫回落=默认分支，正常=当时 HEAD 分支）'
  );
  console.log('ok: R-18 接线守卫（记录/透传）');
}

function compileMergeIsolate() {
  // 树式转译：mergeIsolate 及其依赖（./worktree、shared/i18n…）自动镜像带上
  const file = compile('main/git/mergeIsolate.ts');
  return import(pathToFileURL(file).href);
}

function pathKeyEq(a, b) {
  return a.replace(/[/\\]+/g, '/').toLowerCase() === b.replace(/[/\\]+/g, '/').toLowerCase();
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('[ok] git-worktree');
