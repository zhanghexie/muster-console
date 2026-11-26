/**
 * 质量门禁（git 钩子的实际逻辑；scripts/githooks/* 只是一行 exec 薄壳）。
 *
 *   --mode staged  提交门禁（pre-commit）：全源码 i18n 审计 + 类型检查全量 + 只跑受暂存改动影响的自测
 *                  （离线按依赖闭包、组件单测走 vitest related），典型 5~15s。
 *   --mode full    合入门禁（pre-merge-commit）/ 每晚定时：类型检查 + 离线全量 + 组件单测全套。
 *
 * 测的是「这次真正要提交的内容」而不是工作区：工作区里有未暂存/未跟踪改动时，
 * 先把暂存区导出到 .tmp/gate-<pid>/ 再测。否则漏 add 的新文件照样能过，
 * 并发 Agent 的半成品也会把别人的提交弄红。快照里没有 node_modules，
 * 依赖按 node 解析规则向上找到真仓那份。不用 git stash：会把别的 Agent 正在改的文件收走。
 *
 * 跳过：git commit --no-verify，或 SKIP_TESTS=1。只改文档/本地状态的提交自动放行。
 * E2E 不进门禁（要 build + 起 Electron + 本机 Worker CLI），见 docs/features/testing.md。
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { testDeadline } from '../test/helpers/resources.mjs';
import { acquireTestLease } from '../test/helpers/lease.mjs';

/**
 * git 跑钩子时注入的仓库定位变量。读暂存区时必须保留（`git commit -a` / `git commit <paths>`
 * 的 GIT_INDEX_FILE 指向临时索引，丢了就测错内容）；跑测试前必须抹掉——
 * 否则测试在临时目录建的仓库会被指回本仓 .git（git-worktree 直接 status 128）。
 */
export const GIT_ENV_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_PREFIX',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_INDEX_VERSION',
  'GIT_REFLOG_ACTION',
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_AUTHOR_DATE',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
  'GIT_COMMITTER_DATE'
];

/** 不影响行为的路径：只改这些的提交整单放行；工作区里只有这些脏也不必导快照 */
export function isIgnorable(f) {
  const p = f.replace(/\\/g, '/');
  // .muster/ 是当前工作区本地状态命名空间（scaffold 契约），.metaAgent/ 为改名前的旧名，两者都放行
  return (
    p.startsWith('docs/') || p.startsWith('.muster/') || p.startsWith('.metaAgent/') ||
    p.startsWith('.tmp/') || p.endsWith('.md')
  );
}

export function stripGitEnv(env) {
  const next = { ...env };
  for (const v of GIT_ENV_VARS) delete next[v];
  return next;
}

/** NUL 分隔的 git 输出 → 路径数组 */
export function splitZ(out) {
  return out.split('\0').filter(Boolean);
}

/**
 * @param staged  暂存区相对 HEAD 的改动（含删除）
 * @param dirty   工作区相对暂存区的改动 + 未跟踪文件
 * @returns { skip: string } | { snapshot: boolean, runnerArgs: string[] }
 */
export function planGate({ mode, staged, dirty }) {
  if (staged.length === 0) return { skip: '暂存区为空' };
  if (staged.every(isIgnorable)) return { skip: '仅文档/本地状态改动' };
  return {
    snapshot: dirty.some((f) => !isIgnorable(f)),
    runnerArgs: mode === 'full' ? ['--full'] : ['--changed-files']
  };
}

function run(cmd, args, opts) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, opts);
    let out = '';
    child.stdout?.on('data', (b) => (out += b));
    child.stderr?.on('data', (b) => (out += b));
    child.on('error', (e) => resolve({ code: 1, out: String(e) }));
    child.on('close', (code) => resolve({ code: code ?? 1, out }));
  });
}

async function main() {
  const mode = process.argv.includes('--mode') ? process.argv[process.argv.indexOf('--mode') + 1] : 'staged';
  if (mode !== 'staged' && mode !== 'full') {
    console.error(`gate: 未知 --mode ${mode}（staged | full）`);
    return 1;
  }
  const label = mode === 'full' ? '合入门禁（全量）' : '提交门禁（快档）';
  if (process.env.SKIP_TESTS === '1') {
    console.log(`${label}: SKIP_TESTS=1，跳过`);
    return 0;
  }

  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  try { acquireTestLease(repoRoot); }
  catch (error) { console.error(error.message); return 1; }
  // 这几条 git 调用必须带着钩子注入的环境跑（见 GIT_ENV_VARS 说明）
  const git = (args) => execFileSync('git', args, { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 }).toString();
  // --no-renames：改名拆成「删旧 + 加新」，删除类改动才能被影响面分析识别（退化全跑）
  const staged = splitZ(git(['diff', '--cached', '--name-only', '-z', '--no-renames', '--diff-filter=ACMRD']));
  const dirty = [
    ...splitZ(git(['diff', '--name-only', '-z', '--no-renames'])),
    ...splitZ(git(['ls-files', '--others', '--exclude-standard', '-z']))
  ];
  const plan = planGate({ mode, staged, dirty });
  if ('skip' in plan) {
    console.log(`${label}: ${plan.skip}，跳过`);
    return 0;
  }

  const tmpRoot = path.join(repoRoot, '.tmp');
  fs.mkdirSync(tmpRoot, { recursive: true });
  let tree = repoRoot;
  if (plan.snapshot) {
    const rel = `.tmp/gate-${process.pid}/`;
    tree = path.join(repoRoot, rel);
    fs.rmSync(tree, { recursive: true, force: true });
    // 快照里 tsc 无增量缓存（冷跑单套 ~7s）：node_modules 解析到上层真仓库，复制 tsbuildinfo 过来也会整体失效
    git(['checkout-index', '-a', '-f', `--prefix=${rel}`]);
  }
  const changedList = path.join(tmpRoot, `gate-${process.pid}.changed.txt`);
  fs.writeFileSync(changedList, staged.join('\n'));

  const env = { ...stripGitEnv(process.env), TEST_TIMINGS: path.join(tmpRoot, 'test-timings.json') };
  const runnerArgs = plan.runnerArgs[0] === '--changed-files' ? ['--changed-files', changedList] : plan.runnerArgs;

  console.log(
    `${label}: ${staged.length} 个暂存文件，${plan.snapshot ? '工作区有未暂存改动 → 在暂存快照里测' : '工作区与暂存区一致 → 原地测'}`
  );
  console.log('      跳过请用 git commit --no-verify\n');

  const started = Date.now();
  env.TEST_DEADLINE = String(testDeadline(175_000, env, started));
  try {
    const i18n = await run(process.execPath, [path.join(tree, 'test', 'i18n-coverage.mjs'), '--audit'], {
      cwd: tree,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    if (i18n.out.trim()) console.log(i18n.out.trimEnd());
    if (i18n.code !== 0) {
      console.log(`\n${label}: 全源码 i18n 审计失败（${((Date.now() - started) / 1000).toFixed(1)}s），已中止。`);
      console.log('      请迁移用户可见文本，或在 test/i18n-audit-policy.mjs 登记带分类和理由的精确例外。');
      return 1;
    }
    const tc = await run(process.execPath, [path.join(tree, 'scripts', 'typecheck.mjs'), '--cwd', tree], {
      cwd: tree,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    // 离线自测放前台：逐文件打点充当进度条
    const tr = await run(process.execPath, [path.join(tree, 'test', 'run.mjs'), ...runnerArgs], {
      cwd: tree,
      env,
      stdio: ['ignore', 'inherit', 'inherit']
    });
    console.log('');
    console.log(tc.out.trimEnd());
    const ok = tc.code === 0 && i18n.code === 0 && tr.code === 0;
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    if (!ok) {
      console.log(`\n${label}: 未通过（${secs}s）——${tc.code ? '类型检查 ' : ''}${tr.code ? '测试' : ''}失败，已中止。`);
      console.log('      确需先提交请用 git commit --no-verify。');
      return 1;
    }
    console.log(`\n${label}: 全部通过（${secs}s）`);
    return 0;
  } finally {
    fs.rmSync(changedList, { force: true });
    if (plan.snapshot && !process.env.GATE_KEEP_SNAPSHOT) {
      fs.rmSync(tree, { recursive: true, force: true, maxRetries: 5 });
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main());
}
