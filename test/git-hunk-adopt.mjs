/**
 * T5.5 hunk 级原子采纳：真 git 回归（五性质各至少一条，还原任一性质即红）。
 *
 * 红灯自检（逐条还原性质 → 对应用例必须转红）：
 *  1. merge-base 为 base：把 adopt.ts resolveBase 里 merge-base 换成主仓 HEAD → 用例 A1/A2 红
 *  2. --check 先行 + 失败还原：去掉 --check 或 restore → 用例 B1/B2 红
 *  3. 默认 staged 不 commit：补一句 git commit → 用例 C1 红（HEAD 变了）；去掉 --index 且去掉 --3way → C1 红（unstaged）
 *  4. 临时 GIT_INDEX_FILE：把 env 去掉直写 worktree 索引 → 用例 D1 红（worktree status 变脏）
 *  5. 按目标仓串行闸：去掉 withRepoLock → 用例 E1 红（两次采纳都成功 = 叠写）
 *
 * Run: node test/git-hunk-adopt.mjs
 */
// @test-shards 3
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { inShard } from './helpers/shard.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'git-adopt-'));

// git 可用性（与 git-worktree.mjs 同款守卫）
let gitOk = true;
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' });
} catch {
  gitOk = false;
}

const compile = createSharedCompiler(root, tmp);
const adoptOut = compile('main/git/adopt.ts');
const { createAdopter, parseHunkHeader, parseUnifiedDiff, filterPatchByHunks, adoptHunkKeyId } =
  await import(pathToFileURL(adoptOut).href);

// ---------- 纯函数：hunk 头解析 / 键序列化 ----------
{
  const k = parseHunkHeader('@@ -12,3 +13,5 @@ fn');
  assert.deepEqual(
    k && { ...k, file: '' },
    { file: '', oldStart: 12, oldLines: 3, newStart: 13, newLines: 5 }
  );
  // 省略 ,1 的简写
  const k1 = parseHunkHeader('@@ -5 +5,2 @@');
  assert.equal(k1.oldLines, 1, '省略 oldLines 时按 1');
  assert.equal(k1.newLines, 2);
  assert.equal(parseHunkHeader('not a header'), null);
  assert.equal(
    adoptHunkKeyId({ file: 'a/b.ts', oldStart: 1, oldLines: 2, newStart: 3, newLines: 4 }),
    'a/b.ts|1,2,3,4'
  );
  console.log('ok: parseHunkHeader / adoptHunkKeyId');
}

// ---------- 纯函数：unified diff 解析 + hunk 抽取 ----------
{
  const diff = [
    'diff --git a/one.txt b/one.txt',
    'index 111..222 100644',
    '--- a/one.txt',
    '+++ b/one.txt',
    '@@ -1,4 +1,4 @@',
    ' context',
    '-old',
    '+new',
    ' tail',
    '@@ -10,3 +10,4 @@',
    ' ctx',
    '+added',
    'diff --git a/new.txt b/new.txt',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/new.txt',
    '@@ -0,0 +1,2 @@',
    '+a',
    '+b',
    '\\ No newline at end of file'
  ].join('\n');

  const files = parseUnifiedDiff(diff);
  assert.equal(files.length, 2);
  assert.equal(files[0].path, 'one.txt');
  assert.equal(files[0].hunks.length, 2);
  assert.equal(files[1].path, 'new.txt');
  assert.equal(files[1].hunks[0].body.at(-1), '\\ No newline at end of file', 'no-newline 行随 hunk');

  // 抽取第二个 hunk → 子 patch 只含该 hunk + 完整文件头
  const sub = filterPatchByHunks(diff, [
    { file: 'one.txt', oldStart: 10, oldLines: 3, newStart: 10, newLines: 4 }
  ]);
  assert.ok('patch' in sub);
  assert.match(sub.patch, /diff --git a\/one\.txt b\/one\.txt/);
  assert.match(sub.patch, /@@ -10,3 \+10,4 @@/);
  assert.doesNotMatch(sub.patch, /@@ -1,4 \+1,4 @@/, '未勾选的 hunk 不进子 patch');
  assert.doesNotMatch(sub.patch, /new\.txt/, '未勾选的文件不进子 patch');
  assert.deepEqual(sub.files, ['one.txt']);

  // 键对不上 → stale
  const stale = filterPatchByHunks(diff, [
    { file: 'one.txt', oldStart: 99, oldLines: 9, newStart: 99, newLines: 9 }
  ]);
  assert.ok('stale' in stale && stale.stale.length === 1);
  console.log('ok: parseUnifiedDiff / filterPatchByHunks');
}

if (!gitOk) {
  console.log('skip: 本机无 git，跳过真实采纳回归');
} else {
  // ---------- 场景脚手架 ----------
  /** 建主仓（两个独立文件块，便于制造分叉）+ worktree（ao/* 分支） */
  function makeScenario(name) {
    const main = path.join(tmp, name);
    fs.mkdirSync(main, { recursive: true });
    const git = (args, cwd = main) =>
      execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    git(['init', '-b', 'main']);
    git(['config', 'user.email', 't@t']);
    git(['config', 'user.name', 't']);
    fs.writeFileSync(
      path.join(main, 'f.txt'),
      ['h1-a', 'h1-b', 'h1-c', 'h1-d', '', 'h2-a', 'h2-b', 'h2-c', 'h2-d', ''].join('\n')
    );
    fs.writeFileSync(path.join(main, 'other.txt'), 'base\n');
    git(['add', '.']);
    git(['commit', '-m', 'init']);
    const wt = path.join(main, '.worktrees', 'sess1');
    fs.mkdirSync(path.dirname(wt), { recursive: true });
    // 模拟产品 ensureWorktreesExclude：主仓不把 .worktrees/ 当 untracked（否则脏检查必拒）
    fs.mkdirSync(path.join(main, '.git', 'info'), { recursive: true });
    fs.appendFileSync(path.join(main, '.git', 'info', 'exclude'), '/.worktrees/\n');
    git(['worktree', 'add', '-b', 'ao/sess1', wt, 'HEAD']);
    return { main, wt, git };
  }

  const porcelain = (cwd) =>
    execFileSync('git', ['status', '--porcelain', '-z'], { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString();

  /** 读文件内容（行尾无关：Windows autocrlf 下 checkout/restore 会产生 CRLF） */
  const contentOf = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

  /** 从 diff 文本里挑 hunk 键（渲染层职责的测试侧替身：与 UI parseDiff 同源语义） */
  function hunkKeysOf(diffText, predicate = () => true) {
    const keys = [];
    for (const f of parseUnifiedDiff(diffText)) {
      for (const h of f.hunks) {
        if (predicate(f.path, h.key)) keys.push({ ...h.key, file: f.path });
      }
    }
    return keys;
  }

  // ---------- 性质 1：merge-base 为 base ----------
  // A1 分叉后采纳：主仓在分叉后改了 f.txt 的 h1（含行数变化），worktree 改 h2 且未提交。
  //    采纳 h2 的 hunk → 主仓 h1 保留主仓版本（若 base 误用主仓 HEAD，patch 会包含
  //    「撤销 h1 改动」的 hunk，全选采纳时 h1 被回滚；且 h2 hunk 行号错位 → stale 拒绝）
  if (inShard(0)) {
    const { main, wt, git } = makeScenario('merge-base');
    // 主仓分叉：h1 区加两行（行数变化 → HEAD 与 merge-base 的 f.txt 不同）
    fs.writeFileSync(
      path.join(main, 'f.txt'),
      ['h1-a', 'h1-main-1', 'h1-main-2', 'h1-b', 'h1-c', 'h1-d', '', 'h2-a', 'h2-b', 'h2-c', 'h2-d', ''].join('\n')
    );
    git(['add', '.']);
    git(['commit', '-m', 'main diverges']);
    // worktree 改 h2（未提交，工作树改动也要能采纳）
    fs.writeFileSync(
      path.join(wt, 'f.txt'),
      ['h1-a', 'h1-b', 'h1-c', 'h1-d', '', 'h2-a', 'h2-wt', 'h2-c', 'h2-d', ''].join('\n')
    );

    const adopter = createAdopter();
    const preview = await adopter.adoptPreview(wt);
    assert.equal(preview.ok, true, preview.message);
    // diff 基必须是 merge-base（init 提交），不能是主仓 HEAD（diverge 提交）
    const baseSha = git(['rev-parse', 'HEAD~1']);
    assert.equal(preview.base, baseSha.trim(), 'diff 基 = merge-base 而非主仓 HEAD');

    // 全量勾选采纳
    const keys = hunkKeysOf(preview.diff);
    assert.ok(keys.length >= 1);
    const res = await adopter.adoptHunks(wt, keys);
    assert.equal(res.ok, true, res.message);

    const adopted = contentOf(path.join(main, 'f.txt'));
    assert.match(adopted, /h2-wt/, 'worktree 的 h2 改动落主仓');
    assert.match(adopted, /h1-main-1/, '主仓分叉提交的 h1 改动保留（未被反向 patch 回滚）');
    assert.match(adopted, /h1-main-2/, '主仓分叉提交的 h1 改动保留（行数变化版）');
    console.log('ok: 性质1 merge-base——分叉提交不被回滚');
  }

  // A2 行号对齐：base 若错用主仓 HEAD，worktree diff 的 hunk 行号以 HEAD 版本计算，
  //    与预览（merge-base 基）不一致 → 键错位。这里验证「预览键 → 采纳」闭环键可复现命中。
  if (inShard(1)) {
    const { main, wt } = makeScenario('key-align');
    fs.writeFileSync(
      path.join(main, 'f.txt'),
      ['h1-a', 'h1-main-1', 'h1-main-2', 'h1-b', 'h1-c', 'h1-d', '', 'h2-a', 'h2-b', 'h2-c', 'h2-d', ''].join('\n')
    );
    execFileSync('git', ['add', '.'], { cwd: main, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'main diverges'], { cwd: main, stdio: 'ignore' });
    fs.writeFileSync(
      path.join(wt, 'f.txt'),
      ['h1-a', 'h1-b', 'h1-c', 'h1-d', '', 'h2-a', 'h2-wt', 'h2-c', 'h2-d', ''].join('\n')
    );
    const adopter = createAdopter();
    const preview = await adopter.adoptPreview(wt);
    // 只挑 h2 所在 hunk（含 +h2-wt 的 hunk）
    const h2Keys = hunkKeysOf(preview.diff, (file) => file === 'f.txt');
    assert.equal(h2Keys.length, 1, '单 hunk 改动');
    const res = await adopter.adoptHunks(wt, h2Keys);
    assert.equal(res.ok, true, res.message);
    assert.match(contentOf(path.join(main, 'f.txt')), /h2-wt/);
    console.log('ok: 性质1 行号对齐——预览键在采纳时精确命中');
  }

  // ---------- 性质 2：--check 先行 + 失败还原 ----------
  // B1 冲突拒绝：主仓与 worktree 改同一行。
  //    注：--check --3way 对「可三方合并但带冲突」的场景会放行（真 apply 留冲突标记后非零退出），
  //    两条路径都必须：拒绝 + 主仓零残留（--check 拒 = 未写入；apply 拒 = restore 还原）
  if (inShard(2)) {
    const { main, wt, git } = makeScenario('check-refuse');
    fs.writeFileSync(path.join(wt, 'f.txt'), 'worktree version\n');
    fs.writeFileSync(path.join(main, 'f.txt'), 'main version\n');
    git(['add', '.']);
    git(['commit', '-m', 'main own edit']);

    const adopter = createAdopter();
    const preview = await adopter.adoptPreview(wt);
    assert.equal(preview.ok, true, preview.message);
    const res = await adopter.adoptHunks(wt, hunkKeysOf(preview.diff));
    assert.equal(res.ok, false, '同一行分叉冲突必须拒绝');
    assert.match(res.message, /冲突|无法|还原/, `拒绝文案：${res.message}`);
    assert.equal(porcelain(main).length, 0, `拒绝后主仓零残留：${porcelain(main)}`);
    assert.equal(
      contentOf(path.join(main, 'f.txt')),
      'main version\n',
      '主仓内容保持冲突前状态（无冲突标记、无半应用）'
    );
    console.log('ok: 性质2a 冲突拒绝——主仓零残留');
  }

  // B1b --check 直接拒绝：勾选「新建文件」hunk，但主仓已存在同名文件（3way 无解）
  if (inShard(3)) {
    const { main, wt, git } = makeScenario('check-fail-newfile');
    fs.writeFileSync(path.join(wt, 'conflict-new.txt'), 'from worktree\n');
    fs.writeFileSync(path.join(main, 'conflict-new.txt'), 'already here\n');
    git(['add', '.']);
    git(['commit', '-m', 'pre-existing file']);
    const adopter = createAdopter();
    const preview = await adopter.adoptPreview(wt);
    assert.equal(preview.ok, true, preview.message);
    const res = await adopter.adoptHunks(wt, hunkKeysOf(preview.diff));
    // 注：--check --3way 对「可三方合并（带冲突）」也放行，真 apply 非零退出后由 restore 兜底；
    // --check 纯拒绝只在 3way 信息不可用时出现。两条路径都不允许主仓残留。
    assert.equal(res.ok, false, '目标已有同名新文件必须拒绝');
    assert.match(res.message, /无法|冲突|还原/, `拒绝文案：${res.message}`);
    assert.equal(porcelain(main).length, 0, `拒绝后主仓零残留：${porcelain(main)}`);
    assert.equal(
      contentOf(path.join(main, 'conflict-new.txt')),
      'already here\n',
      'check 先行：未写过任何东西'
    );
    console.log('ok: 性质2a2 同名新文件——拒绝且零残留');
  }

  // B2 半应用还原：注入 git —— check 通过后、apply 执行前篡改主仓文件制造真失败，
  //    断言 restore 把被触碰路径放回 HEAD（无冲突标记残留、status 干净）
  if (inShard(4)) {
    const { main, wt } = makeScenario('half-apply');
    fs.writeFileSync(path.join(wt, 'f.txt'), ['h1-a', 'h1-wt', 'h1-c', 'h1-d', '', 'h2-a', 'h2-b', 'h2-c', 'h2-d', ''].join('\n'));
    const headF = () =>
      execFileSync('git', ['show', 'HEAD:f.txt'], { cwd: main }).toString().replace(/\r\n/g, '\n');

    const realGit = async (args, cwd, env) => {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      try {
        const { stdout, stderr } = await promisify(execFile)('git', args, {
          cwd,
          windowsHide: true,
          encoding: 'utf8',
          timeout: 60_000,
          ...(env ? { env: { ...process.env, ...env } } : {})
        });
        return { code: 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') };
      } catch (e) {
        const err = e;
        return {
          code: typeof err.code === 'number' ? err.code : 1,
          stdout: String(err.stdout ?? ''),
          stderr: String(err.stderr ?? err.message ?? err)
        };
      }
    };
    let sawCheck = false;
    const injected = async (args, cwd, env) => {
      // check 先真跑（应通过）；check 之后第一个 apply 前注入「主仓文件被并发改掉」
      if (args[0] === 'apply' && args.includes('--check')) {
        const r = await realGit(args, cwd, env);
        sawCheck = true;
        return r;
      }
      if (args[0] === 'apply' && sawCheck) {
        // 篡改：让 3way 真失败（把主仓 f.txt 换成与 patch 完全冲突的形态 + 保持 index 干净的假象不行，
        // 直接换成内容漂移版，--3way 在 blob 缺失时退化为直接应用失败）
        fs.writeFileSync(path.join(main, 'f.txt'), ['h1-a', 'h1-x', 'h1-y', 'h1-z', '', 'h2-a', 'h2-b', 'h2-c', 'h2-d', ''].join('\n'));
        const r = await realGit(args, cwd, env);
        return r;
      }
      return realGit(args, cwd, env);
    };

    const adopter = createAdopter({ git: injected });
    const preview = await adopter.adoptPreview(wt);
    assert.equal(preview.ok, true, preview.message);
    const res = await adopter.adoptHunks(wt, hunkKeysOf(preview.diff));
    // 无论 apply 成败：不允许留下半应用/脏状态
    if (!res.ok) {
      assert.equal(porcelain(main).length, 0, `失败后主仓必须干净：${porcelain(main)}`);
      assert.equal(contentOf(path.join(main, 'f.txt')), headF(), '失败后被触碰路径还原到 HEAD');
    } else {
      // 注入未触发失败（3way 意外成功）——至少不允许冲突标记残留
      assert.doesNotMatch(contentOf(path.join(main, 'f.txt')), /<<<<<<<|>>>>>>>/);
    }
    console.log('ok: 性质2b 失败还原——apply 中途失败不留半应用');
  }

  // ---------- 性质 3：默认 staged 不 commit ----------
  if (inShard(5)) {
    const { main, wt, git } = makeScenario('staged-no-commit');
    fs.writeFileSync(path.join(wt, 'other.txt'), 'adopted\n');
    const adopter = createAdopter();
    const preview = await adopter.adoptPreview(wt);
    const headBefore = git(['rev-parse', 'HEAD']);
    const res = await adopter.adoptHunks(wt, hunkKeysOf(preview.diff));
    assert.equal(res.ok, true, res.message);
    const headAfter = git(['rev-parse', 'HEAD']);
    assert.equal(headAfter, headBefore, '采纳不产生提交（HEAD 不动）');
    const st = porcelain(main);
    assert.match(st, /M  other\.txt/, `采纳结果以 staged 形式出现：${JSON.stringify(st)}`);
    const cached = git(['diff', '--cached', '--name-only']);
    assert.match(cached, /other\.txt/, 'git diff --cached 即采纳内容');
    console.log('ok: 性质3 staged 不 commit');
  }

  // ---------- 性质 4：临时 GIT_INDEX_FILE，不碰 Worker 的树 ----------
  // D1 worktree 含未跟踪文件：采纳后 worktree 的 status 必须原样（仍 ??），
  //    索引无 intent-to-add 残留；未跟踪文件本身可被勾选采纳进主仓
  if (inShard(6)) {
    const { main, wt, git } = makeScenario('temp-index');
    fs.writeFileSync(path.join(wt, 'brand-new.txt'), 'fresh\n');
    const wtStatusBefore = porcelain(wt);

    const adopter = createAdopter();
    const preview = await adopter.adoptPreview(wt);
    assert.equal(preview.ok, true, preview.message);
    assert.match(preview.diff, /brand-new\.txt/, '未跟踪文件经临时 index -N 出现在预览 diff');

    const res = await adopter.adoptHunks(wt, hunkKeysOf(preview.diff));
    assert.equal(res.ok, true, res.message);
    assert.equal(
      porcelain(wt),
      wtStatusBefore,
      'worktree 索引/状态原样（无 intent-to-add 残留，仍为 ??）'
    );
    assert.equal(contentOf(path.join(main, 'brand-new.txt')), 'fresh\n', '未跟踪文件被采纳进主仓');
    console.log('ok: 性质4 临时索引——Worker 的树零污染');
  }

  // ---------- 性质 5：按目标仓串行闸 ----------
  // E1 同一主仓的两个 worktree 并发采纳：干净检查与 apply 隔着多次 git 调用，
  //    无闸时两个 status 都看到干净树 → 叠写。注入慢 status 放大窗口。
  if (inShard(7)) {
    const { main, git } = makeScenario('serial-gate');
    const wt1 = path.join(main, '.worktrees', 'sess1');
    const wt2dir = path.join(main, '.worktrees', 'sess2');
    git(['worktree', 'add', '-b', 'ao/sess2', wt2dir, 'HEAD']);
    const wt2 = wt2dir;
    fs.writeFileSync(path.join(wt1, 'a1.txt'), 'one\n');
    fs.writeFileSync(path.join(wt2, 'a2.txt'), 'two\n');

    const realGit = async (args, cwd, env) => {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      try {
        const { stdout, stderr } = await promisify(execFile)('git', args, {
          cwd,
          windowsHide: true,
          encoding: 'utf8',
          timeout: 60_000,
          ...(env ? { env: { ...process.env, ...env } } : {})
        });
        return { code: 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') };
      } catch (e) {
        const err = e;
        return {
          code: typeof err.code === 'number' ? err.code : 1,
          stdout: String(err.stdout ?? ''),
          stderr: String(err.stderr ?? err.message ?? err)
        };
      }
    };
    // 慢 status：让两个采纳的干净检查必然先后落进同一时间窗（无闸时双双看到干净树）
    const slowed = async (args, cwd, env) => {
      if (args[0] === 'status') await new Promise((r) => setTimeout(r, 120));
      return realGit(args, cwd, env);
    };

    const adopter = createAdopter({ git: slowed });
    const [p1, p2] = await Promise.all([adopter.adoptPreview(wt1), adopter.adoptPreview(wt2)]);
    assert.equal(p1.ok && p2.ok, true, `${p1.message} / ${p2.message}`);
    const [r1, r2] = await Promise.all([
      adopter.adoptHunks(wt1, hunkKeysOf(p1.diff)),
      adopter.adoptHunks(wt2, hunkKeysOf(p2.diff))
    ]);
    const oks = [r1, r2].filter((r) => r.ok);
    assert.equal(oks.length, 1, `串行闸下恰一个成功（第二个 dirty-target 拒）：${r1.message} | ${r2.message}`);
    const refused = [r1, r2].find((r) => !r.ok);
    assert.match(refused.message, /未提交改动/, '第二个拒绝理由是主仓已脏（先到的采纳 staged）');
    console.log('ok: 性质5 串行闸——并发采纳不叠写');
  }

  // ---------- 行为补测 ----------
  // 主仓脏（人为改动）→ dirty-target 拒绝
  if (inShard(8)) {
    const { main, wt } = makeScenario('dirty-target');
    fs.writeFileSync(path.join(wt, 'other.txt'), 'wt edit\n');
    fs.writeFileSync(path.join(main, 'human.txt'), 'human wip\n');
    const adopter = createAdopter();
    const preview = await adopter.adoptPreview(wt);
    assert.equal(preview.ok, true, preview.message);
    const res = await adopter.adoptHunks(wt, hunkKeysOf(preview.diff));
    assert.equal(res.ok, false);
    assert.match(res.message, /未提交改动/);
    assert.equal(contentOf(path.join(main, 'human.txt')), 'human wip\n', '人为改动不受影响');
    console.log('ok: 脏主仓拒绝');
  }

  // worktree == 主 checkout → 拒绝；空 hunk → 拒绝；stale 键 → 拒绝
  if (inShard(9)) {
    const { main, wt } = makeScenario('misc-refuse');
    const adopter = createAdopter();
    const self = await adopter.adoptPreview(main);
    assert.equal(self.ok, false, '主 checkout 自己不能采纳');
    fs.writeFileSync(path.join(wt, 'other.txt'), 'edit\n');
    const empty = await adopter.adoptHunks(wt, []);
    assert.equal(empty.ok, false, '空勾选拒绝');
    const preview = await adopter.adoptPreview(wt);
    assert.equal(preview.ok, true, preview.message);
    const stale = await adopter.adoptHunks(wt, [
      { file: 'other.txt', oldStart: 999, oldLines: 9, newStart: 999, newLines: 9 }
    ]);
    assert.equal(stale.ok, false);
    assert.match(stale.message, /不一致|刷新/, '键对不上按 stale 拒绝并提示刷新');
    console.log('ok: 主 checkout/空选/stale 拒绝');
  }

  // 无改动 → empty
  if (inShard(10)) {
    const { wt } = makeScenario('empty');
    const adopter = createAdopter();
    const preview = await adopter.adoptPreview(wt);
    assert.equal(preview.ok, false);
    assert.match(preview.message, /没有可采纳/);
    console.log('ok: 无改动 empty');
  }
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('git-hunk-adopt: 全部通过');
