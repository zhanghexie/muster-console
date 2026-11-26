/**
 * 隔离 worktree 合入主仓：一律在主仓 cwd 执行 git merge。
 * Worker 的 cwd 就是 worktree，不能在里面 git worktree remove（尤其 Windows 目录锁）。
 * 无 electron 依赖，离线单测走 test/git-worktree.mjs。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import type { GitMergeIsolateResult, MergeIsolateOptions } from '../../shared/types';
import { t } from '../../shared/i18n';
import { parseOriginHeadRef, pickDefaultBranch } from './worktree';
import { filterTaskGitlinkOverlaps, type TaskGitlinkMerge } from './submoduleMergeState';
import { gitCommandEnvironment } from './gitEnvironment';
import { saveIntegrateSnapshot, restoreIntegrateSnapshot } from './integrateSnapshot';

const execFileAsync = promisify(execFile);

export type MergeIsolateBranchOpts = {
  mainRepo: string;
  worktreePath: string;
  branch: string;
  targetBranch?: string;
  /** 建树时记录的起点分支（会话 worktreeBaseBranch）：target 缺省时「从哪建回哪」，旧会话无记录回落默认分支 */
  baseBranch?: string;
  /** Host-only task guard, immediately before each merge write. */
  beforeWrite?: (stage: 'checkout' | 'stash' | 'merge') => Promise<void>;
  /** Task preflight pins the source commit, independent of a later ref update. */
  sourceCommit?: string;
  sourceGitlinks?: readonly TaskGitlinkMerge[];
} & MergeIsolateOptions;

/** 仓库可挂 pre-merge-commit 门禁（跑全量测试），merge 本身不能套通用的 60s 超时 */
const MERGE_TIMEOUT_MS = 15 * 60_000;

async function git(cwd: string, args: string[], timeout = 60_000): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    env: gitCommandEnvironment(),
    windowsHide: true,
    encoding: 'utf8',
    timeout,
    maxBuffer: 4 * 1024 * 1024
  });
  return String(stdout ?? '').trim();
}

/** 原样 stdout（不 trim）：porcelain 首行行首空格是 XY 状态列语义（' M '=未暂存改动），
 *  trim 掉会让 parsePorcelainPaths 把首个路径错切一位（实测解析出 'hared.txt'）。 */
async function gitRaw(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    env: gitCommandEnvironment(),
    windowsHide: true,
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024
  });
  return String(stdout ?? '');
}

async function gitAllowFail(
  cwd: string,
  args: string[],
  timeout?: number
): Promise<{ ok: boolean; out: string; err: string }> {
  try {
    const out = await git(cwd, args, timeout);
    return { ok: true, out, err: '' };
  } catch (e) {
    const err = e as { stderr?: string; stdout?: string; message?: string };
    const stderr = typeof err.stderr === 'string' ? err.stderr.trim() : '';
    const stdout = typeof err.stdout === 'string' ? err.stdout.trim() : '';
    return { ok: false, out: stdout, err: stderr || String(err.message ?? e) };
  }
}

export function posixPath(p: string): string {
  return p.replace(/\\/g, '/');
}

function stripQuotes(p: string): string {
  if (p.startsWith('"') && p.endsWith('"') && p.length >= 2) return p.slice(1, -1);
  return p;
}

/** git status --porcelain 路径（含重命名两侧；兼容 -z） */
export function parsePorcelainPaths(out: string): string[] {
  const paths: string[] = [];
  if (out.includes('\0')) {
    // -z 侧路径原样取值（git 不加引号也无行界，trim/剥引号反而会在「首尾带空格/
    // 引号的文件名」上与 diff -z 侧失配），与上方 diff -z 输出同为字面路径
    const parts = out.split('\0').filter((p) => p.length > 0);
    for (let i = 0; i < parts.length; i += 1) {
      const rec = parts[i];
      const rest = rec.length >= 3 ? rec.slice(3) : rec;
      const xy = rec.slice(0, 2);
      if ((xy[0] === 'R' || xy[0] === 'C') && i + 1 < parts.length) {
        if (rest) paths.push(posixPath(rest));
        i += 1;
        paths.push(posixPath(parts[i]));
      } else if (rest.includes(' -> ')) {
        const [a, b] = rest.split(' -> ');
        if (a) paths.push(posixPath(a));
        if (b) paths.push(posixPath(b));
      } else {
        paths.push(posixPath(rest));
      }
    }
    return [...new Set(paths)].filter(Boolean);
  }
  for (const line of out.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const rest = line.length >= 3 ? line.slice(3) : line;
    if (rest.includes(' -> ')) {
      const [a, b] = rest.split(' -> ');
      if (a) paths.push(posixPath(stripQuotes(a.trim())));
      if (b) paths.push(posixPath(stripQuotes(b.trim())));
    } else {
      paths.push(posixPath(stripQuotes(rest.trim())));
    }
  }
  return [...new Set(paths)].filter(Boolean);
}

export function parseOverwrittenFiles(err: string): string[] {
  const lines = err.split(/\r?\n/);
  const out: string[] = [];
  let grab = false;
  for (const line of lines) {
    if (/would be overwritten|local changes to the following files/i.test(line)) {
      grab = true;
      continue;
    }
    if (grab) {
      if (!line.trim() || /please commit|please stash|aborting/i.test(line)) {
        if (/please commit|please stash|aborting/i.test(line)) grab = false;
        continue;
      }
      const p = posixPath(line.trim());
      if (p && !p.endsWith(':')) out.push(p);
    }
  }
  return [...new Set(out)];
}

export function mergeBlockedByLocalChanges(err: string): boolean {
  const s = err.toLowerCase();
  return s.includes('local changes') || s.includes('would be overwritten') || s.includes('uncommitted');
}

function dirtyOverlapResult(
  branch: string,
  target: string,
  overlap: string[],
  note = ''
): GitMergeIsolateResult {
  return {
    ok: false,
    branch,
    target,
    blockReason: 'dirty-overlap',
    dirtyOverlap: overlap.slice(0, 20),
    message: t(
      '主仓有未提交改动与待合入文件重叠，已拒绝合入（不是合并冲突）。重叠 {{count}} 个：\n{{files}}\n请提交/挪开这些文件，或传 stashMain:true 暂存让路。{{note}}',
      { count: overlap.length, files: overlap.slice(0, 20).join('\n'), note: note ? `\n${note}` : '' }
    )
  };
}

export function intersectPaths(a: string[], b: string[]): string[] {
  const set = new Set(a.map(posixPath));
  return [...new Set(b.map(posixPath))].filter((p) => set.has(p));
}

/** journal / README / MEMORY：append-only，可走 union 或视为机械冲突 */
export function isMechanicalMergePath(file: string): boolean {
  const p = posixPath(file);
  return (
    /^docs\/journal\/.+\.md$/i.test(p) ||
    p === 'docs/README.md' ||
    p === 'docs/memory/MEMORY.md'
  );
}

export function classifyConflictFiles(files: string[]): {
  mechanical: string[];
  judgment: string[];
} {
  const mechanical: string[] = [];
  const judgment: string[] = [];
  for (const f of files) {
    if (isMechanicalMergePath(f)) mechanical.push(f);
    else judgment.push(f);
  }
  return { mechanical, judgment };
}

export function extractExportSymbols(source: string): string[] {
  const names: string[] = [];
  const re =
    /export\s+(?:async\s+)?(?:function|class|const|let|var|type|interface|enum)\s+([A-Za-z_$][\w$]*)/g;
  for (const m of source.matchAll(re)) {
    if (m[1]) names.push(m[1]);
  }
  return [...new Set(names)].slice(0, 8);
}

async function porcelainDirty(cwd: string): Promise<boolean> {
  const out = await git(cwd, ['status', '--porcelain', '-z']);
  return out.length > 0;
}

async function localBranches(cwd: string): Promise<string[]> {
  const out = await git(cwd, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
  return out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

export async function resolveDefaultBranch(mainRepo: string): Promise<string> {
  const origin = await gitAllowFail(mainRepo, ['symbolic-ref', 'refs/remotes/origin/HEAD']);
  const current = await gitAllowFail(mainRepo, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return pickDefaultBranch({
    originHead: origin.ok ? parseOriginHeadRef(origin.out) : null,
    localBranches: await localBranches(mainRepo),
    current: current.ok ? current.out : null
  });
}

function defaultMergeMessage(branch: string, target: string): string {
  return t('合入 {{branch}} 到 {{target}}', { branch, target });
}

async function collectCallSites(
  mainRepo: string,
  branch: string,
  files: string[]
): Promise<{ file: string; hits: string[] }[]> {
  const out: { file: string; hits: string[] }[] = [];
  for (const file of files.slice(0, 8)) {
    if (!/\.(ts|tsx|js|mjs|cjs)$/i.test(file)) continue;
    const show = await gitAllowFail(mainRepo, ['show', `${branch}:${file}`]);
    const symbols = show.ok ? extractExportSymbols(show.out) : [];
    const hits: string[] = [];
    for (const sym of symbols.slice(0, 5)) {
      const g = await gitAllowFail(mainRepo, [
        'grep',
        '-n',
        '-I',
        '--max-count',
        '8',
        '-e',
        sym,
        '--',
        '*.ts',
        '*.tsx',
        '*.js',
        '*.mjs'
      ]);
      if (g.ok && g.out) {
        for (const line of g.out.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (trimmed && !trimmed.startsWith(`${file}:`)) hits.push(trimmed);
          if (hits.length >= 8) break;
        }
      }
      if (hits.length >= 8) break;
    }
    out.push({ file, hits: hits.slice(0, 8) });
  }
  return out;
}

const DEP_PATHS = new Set(['package.json', 'package-lock.json', 'npm-shrinkwrap.json']);

export function mergeTouchedDepFiles(changed: string[]): boolean {
  return changed.some((f) => DEP_PATHS.has(posixPath(f)));
}

async function runCmd(
  cwd: string,
  command: string,
  args: string[],
  timeout: number
): Promise<{ ok: boolean; out: string; err: string }> {
  try {
    // .cmd 不是可直接 execFile 的可执行文件；固定 npm 子命令经 cmd 执行。
    // cwd 单独传入，不能插入 shell 文本（路径可能含空格和元字符）。
    const windowsNpm = process.platform === 'win32' && command === 'npm';
    const bin = windowsNpm ? (process.env.ComSpec || 'cmd.exe') : command;
    const commandArgs = windowsNpm ? ['/d', '/s', '/c', `npm ${args.join(' ')}`] : args;
    const { stdout, stderr } = await execFileAsync(bin, commandArgs, {
      cwd,
      env: gitCommandEnvironment(),
      windowsHide: true,
      encoding: 'utf8',
      timeout,
      maxBuffer: 8 * 1024 * 1024
    });
    return { ok: true, out: String(stdout ?? '').trim(), err: String(stderr ?? '').trim() };
  } catch (e) {
    const err = e as { stderr?: string; stdout?: string; message?: string };
    return {
      ok: false,
      out: typeof err.stdout === 'string' ? err.stdout.trim() : '',
      err: (typeof err.stderr === 'string' ? err.stderr.trim() : '') || String(err.message ?? e)
    };
  }
}

export async function runPostMergeGates(
  mainRepo: string,
  changedFiles: string[],
  opts: Pick<MergeIsolateOptions, 'skipNpmInstall' | 'skipTypecheck' | 'onGateFail'>
): Promise<{
  warnings: string[];
  gates: NonNullable<GitMergeIsolateResult['gates']>;
  abort: boolean;
}> {
  const warnings: string[] = [];
  const gates: NonNullable<GitMergeIsolateResult['gates']> = {};
  const pkgPath = path.join(mainRepo, 'package.json');
  let pkg: { scripts?: Record<string, string> } | null = null;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { scripts?: Record<string, string> };
  } catch {
    pkg = null;
  }

  const wantInstall = !opts.skipNpmInstall && mergeTouchedDepFiles(changedFiles);
  if (!wantInstall) {
    gates.npmInstall = 'skipped';
  } else {
    const r = await runCmd(mainRepo, 'npm', ['install'], 10 * 60_000);
    gates.npmInstall = r.ok ? 'ok' : 'failed';
    if (!r.ok) {
      warnings.push(t('合入后 npm install 失败（仅告警，未回滚）：{{err}}', { err: r.err.slice(0, 400) }));
    }
  }

  const wantTypecheck = !opts.skipTypecheck && Boolean(pkg?.scripts?.typecheck);
  if (!wantTypecheck) {
    gates.typecheck = 'skipped';
  } else {
    const r = await runCmd(mainRepo, 'npm', ['run', 'typecheck'], 5 * 60_000);
    gates.typecheck = r.ok ? 'ok' : 'failed';
    if (!r.ok) {
      warnings.push(
        t('合入后 typecheck 失败（仅告警，未回滚）：{{err}}', { err: (r.err || r.out).slice(0, 600) })
      );
    }
  }

  const abort =
    opts.onGateFail === 'abort' && (gates.npmInstall === 'failed' || gates.typecheck === 'failed');
  return { warnings, gates, abort };
}

export async function mergeIsolateBranch(opts: MergeIsolateBranchOpts): Promise<GitMergeIsolateResult> {
  const mainRepo = opts.mainRepo;
  const worktreePath = opts.worktreePath;
  const branch = opts.branch.trim();
  if (!branch) return { ok: false, message: t('缺少来源分支') };

  if (await porcelainDirty(worktreePath)) {
    return {
      ok: false,
      branch,
      blockReason: 'dirty-worktree',
      message: t('worktree 有未提交改动。请先在隔离目录提交，再合入。')
    };
  }

  // target 对称语义（R-18）：显式 targetBranch ＞ 建树 base（从哪建回哪，防 feature 提交搭车进默认分支）＞ 默认分支
  const target = (
    opts.targetBranch?.trim() ||
    opts.baseBranch?.trim() ||
    (await resolveDefaultBranch(mainRepo))
  ).trim();
  const current = await git(mainRepo, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (current !== target) {
    await opts.beforeWrite?.('checkout');
    const co = await gitAllowFail(mainRepo, [...(opts.sourceGitlinks?.length ? ['-c', 'submodule.recurse=false'] : []), 'checkout', target]);
    if (!co.ok) {
      return { ok: false, branch, target, message: t('无法切到 {{target}}：{{error}}', { target, error: co.err }) };
    }
  }

  const ancestor = await gitAllowFail(mainRepo, ['merge-base', '--is-ancestor', branch, 'HEAD']);
  if (ancestor.ok) {
    return {
      ok: true,
      branch,
      target,
      alreadyMerged: true,
      message: t('{{branch}} 已在 {{target}} 上，无需再 merge', { branch, target })
    };
  }

  const mergeBase = await gitAllowFail(mainRepo, ['merge-base', 'HEAD', branch]);
  const range = mergeBase.ok ? `${mergeBase.out}...${branch}` : `HEAD...${branch}`;
  // -z：NUL 分隔且路径不做 quotepath 引号转义——非 ASCII 文件名（如中文）按字面值
  // 输出，才能与 status 侧 parsePorcelainPaths 的结果对上（带引号转义形式永不相等，
  // 重叠检测会恒为空、stashMain 静默失效）
  const mergeFilesOut = await gitAllowFail(mainRepo, ['diff', '--name-only', '-z', range]);
  const mergeFiles = mergeFilesOut.out
    ? mergeFilesOut.out.split('\0').map((l) => posixPath(l)).filter(Boolean)
    : [];
  // status 同样走 -z：NUL 分隔且路径不做 quotepath 引号转义，与上方 diff 侧
  // 输出同一形态（stripQuotes 只剥引号、不解八进制转义，非 ASCII 路径两侧才能对上）
  const dirtyOut = await gitRaw(mainRepo, ['status', '--porcelain', '-z']);
  const dirtyPaths = parsePorcelainPaths(dirtyOut);
  const overlap = await filterTaskGitlinkOverlaps(mainRepo, opts.sourceCommit ?? `refs/heads/${branch}`,
    intersectPaths(dirtyPaths, mergeFiles), opts.sourceGitlinks);

  let snapshot = '';
  if (overlap.length) {
    if (!opts.stashMain) return dirtyOverlapResult(branch, target, overlap);
    await opts.beforeWrite?.('stash');
    try {
      snapshot = await saveIntegrateSnapshot(mainRepo, [...overlap]);
    } catch (error) {
      return { ok: false, branch, target, blockReason: 'dirty-overlap',
        dirtyOverlap: overlap.slice(0, 20),
        message: t('stashMain 暂存主仓失败：{{err}}', { err: String(error) }) };
    }
  }
  let restoreNote = '';
  const restoreStash = async (): Promise<void> => {
    if (!snapshot) return;
    const ref = snapshot;
    snapshot = '';
    try { await restoreIntegrateSnapshot(mainRepo, ref, overlap); }
    catch (error) { restoreNote = t('主仓改动保留在私有快照 {{ref}}（恢复失败：{{err}}）', { ref, err: String(error) }); }
  };

  const mergeArgs = ['merge'];
  const msg = opts.message?.trim();
  const forceNoFf = Boolean(opts.noFf || msg);
  if (forceNoFf) mergeArgs.push('--no-ff');
  if (msg) mergeArgs.push('-m', msg);
  else if (opts.noFf) mergeArgs.push('-m', defaultMergeMessage(branch, target));
  else mergeArgs.push('--no-edit');
  mergeArgs.push(opts.sourceCommit ?? branch);

  // quotepath=false：merge/diff 的错误文案与文件清单按字面输出非 ASCII 路径，
  // parseOverwrittenFiles/changedFiles 拿到的不再是八进制转义乱码
  try {
    await opts.beforeWrite?.('merge');
  } catch (error) {
    // A changed source identity cannot authorize popping into the replacement checkout.
    return { ok: false, branch, target, message: snapshot
      ? t('合入守卫拒绝继续，主仓改动保留在私有快照 {{ref}}：{{reason}}', { ref: snapshot, reason: String(error) })
      : String(error) };
  }
  const merged = await gitAllowFail(
    mainRepo,
    ['-c', 'core.quotepath=false', ...(opts.sourceGitlinks?.length ? ['-c', 'submodule.recurse=false'] : []), ...mergeArgs],
    MERGE_TIMEOUT_MS
  );
  if (!merged.ok) {
    const mergeErr = `${merged.err}\n${merged.out}`;
    const conflicts = await gitAllowFail(mainRepo, [
      '-c',
      'core.quotepath=false',
      'diff',
      '--name-only',
      '--diff-filter=U'
    ]);
    const conflictFiles = conflicts.ok
      ? conflicts.out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 20)
      : [];
    // 三方合并已完成（MERGE_HEAD 在、无未解决冲突）却没提交：只可能是仓库的 pre-merge-commit
    // 钩子拒绝了。按 git 状态判定而非匹配提示文案——git 可能是中文本地化输出。
    const mergeHead = await gitAllowFail(mainRepo, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']);
    if (conflicts.ok && conflictFiles.length === 0 && mergeHead.ok) {
      await gitAllowFail(mainRepo, [...(opts.sourceGitlinks?.length ? ['-c', 'submodule.recurse=false'] : []), 'merge', '--abort']);
      await restoreStash();
      return {
        ok: false,
        branch,
        target,
        blockReason: 'gate-failed',
        gates: { mergeHook: 'failed' },
        message: t('合入 {{target}} 被仓库的 pre-merge-commit 门禁拦下，已 abort（{{mainNote}}）。门禁输出末尾：\n{{tail}}', {
          target,
          mainNote: restoreNote || t('主仓无残留'),
          tail: mergeErr.trim().slice(-1500)
        })
      };
    }
    if (!conflictFiles.length) {
      const fromErr = parseOverwrittenFiles(mergeErr);
      const listed = [
        ...new Set([
          ...(overlap.length ? overlap : dirtyPaths),
          ...fromErr
        ])
      ].slice(0, 20);
      await gitAllowFail(mainRepo, [...(opts.sourceGitlinks?.length ? ['-c', 'submodule.recurse=false'] : []), 'merge', '--abort']);
      await restoreStash();
      if (listed.length || mergeBlockedByLocalChanges(mergeErr)) {
        return dirtyOverlapResult(branch, target, listed, restoreNote);
      }
    }
    const classified = classifyConflictFiles(conflictFiles);
    const callSites =
      classified.judgment.length > 0
        ? await collectCallSites(mainRepo, branch, classified.judgment)
        : [];
    const ahead = await gitAllowFail(mainRepo, ['rev-list', '--count', `HEAD..${branch}`]);
    const aheadCount = ahead.ok ? Number.parseInt(ahead.out, 10) : NaN;
    await gitAllowFail(mainRepo, [...(opts.sourceGitlinks?.length ? ['-c', 'submodule.recurse=false'] : []), 'merge', '--abort']);
    await restoreStash();
    const conflictNote = conflictFiles.length
      ? t('冲突文件 {{count}} 个：\n{{files}}', {
          count: conflictFiles.length,
          files: conflictFiles.slice(0, 20).join('\n')
        })
      : t('未能列出冲突文件（{{err}}）', { err: conflicts.err || 'git diff 失败' });
    const classNote =
      conflictFiles.length > 0
        ? t('；机械可解 {{mech}} 个、需裁定 {{judge}} 个', {
            mech: classified.mechanical.length,
            judge: classified.judgment.length
          })
        : '';
    const siteNote =
      callSites.some((c) => c.hits.length)
        ? t('；调用点：{{hits}}', {
            hits: callSites
              .filter((c) => c.hits.length)
              .map((c) => `${c.file} ← ${c.hits.slice(0, 3).join(' | ')}`)
              .join('；')
              .slice(0, 800)
          })
        : '';
    const aheadNote =
      Number.isFinite(aheadCount) && aheadCount > 0
        ? t('；隔离分支领先 {{target}} {{count}} 个提交', { target, count: aheadCount })
        : '';
    return {
      ok: false,
      branch,
      target,
      blockReason: 'conflict',
      ...(conflictFiles.length ? { conflicts: conflictFiles } : {}),
      conflictClass: classified,
      ...(callSites.length ? { callSites } : {}),
      message: t('合入 {{target}} 冲突，已 abort（{{mainNote}}）。{{conflictNote}}{{aheadNote}}。请在隔离分支解决后重试。', {
        target,
        mainNote: restoreNote || t('主仓无残留'),
        conflictNote: `${conflictNote}${classNote}${siteNote}`,
        aheadNote
      })
    };
  }

  const mergedCommit = await git(mainRepo, ['rev-parse', 'HEAD']);
  await restoreStash();
  if (restoreNote) {
    return { ok: true, mergedCommit, branch, target, warnings: [restoreNote],
      message: `${t('已将 {{branch}} 合入 {{target}}', { branch, target })}。${restoreNote}` };
  }

  const changedOut = await gitAllowFail(mainRepo, [
    '-c',
    'core.quotepath=false',
    'diff',
    '--name-only',
    'ORIG_HEAD',
    'HEAD'
  ]);
  const changedFiles = merged.ok
    ? (changedOut.ok
        ? changedOut.out.split(/\r?\n/).map((l) => posixPath(l.trim())).filter(Boolean)
        : mergeFiles)
    : [];

  const gate = await runPostMergeGates(mainRepo, changedFiles, {
    skipNpmInstall: opts.skipNpmInstall,
    skipTypecheck: opts.skipTypecheck,
    onGateFail: opts.onGateFail
  });

  if (gate.abort) {
    await gitAllowFail(mainRepo, [...(opts.sourceGitlinks?.length ? ['-c', 'submodule.recurse=false'] : []), 'reset', '--hard', 'ORIG_HEAD']);
    return {
      ok: false,
      branch,
      target,
      blockReason: 'gate-failed',
      gates: gate.gates,
      warnings: gate.warnings,
      message: t('合入后校验闸失败，已回滚 merge（onGateFail=abort）。{{detail}}', {
        detail: gate.warnings.join(' ')
      })
    };
  }

  const baseMsg = t('已将 {{branch}} 合入 {{target}}', { branch, target });
  if (opts.sourceGitlinks?.length) {
    const remaining = parsePorcelainPaths(await gitRaw(mainRepo, ['status', '--porcelain', '-z']));
    for (const link of opts.sourceGitlinks) {
      if (remaining.includes(link.relativePath)) gate.warnings.push(t('子模块 {{path}} 的源检出仍领先父仓 gitlink，请确认后整理。', { path: link.relativePath }));
    }
  }
  return {
    ok: true,
    mergedCommit,
    branch,
    target,
    warnings: gate.warnings.length ? gate.warnings : undefined,
    gates: gate.gates,
    message: gate.warnings.length ? `${baseMsg}。${gate.warnings.join(' ')}` : baseMsg
  };
}

/**
 * ao/* 分支相对默认分支是否已无未合入提交。
 * 判不了（默认分支解析失败 / merge-base 失败）按未合入处理：宁可保留也不误删。
 */
export async function isBranchMergedIntoDefault(
  mainRepo: string,
  branch: string,
  targetBranch?: string
): Promise<boolean> {
  const name = branch.trim();
  if (!name) return true;
  let target: string | null = null;
  try {
    target = targetBranch?.trim() || await resolveDefaultBranch(mainRepo);
  } catch {
    target = null;
  }
  if (!target) return false;
  const anc = await gitAllowFail(mainRepo, ['merge-base', '--is-ancestor', name, target]);
  return anc.ok;
}

/**
 * worktree 删掉后尝试删已合入的 ao/* 本地分支；未合入则保留。
 * `branch -d` 只认「已合入 HEAD 或 upstream」——HEAD 停在别的分支时，改用
 * merge-base 对默认分支做祖先校验，验证提交全部可达才允许 `-D`（等价安全）。
 */
export async function deleteMergedBranch(
  mainRepo: string,
  branch: string,
  targetBranch?: string
): Promise<{ ok: boolean; unmerged?: boolean; message?: string }> {
  const name = branch.trim();
  if (!name) return { ok: false, message: t('空分支名') };
  // An explicit integration target is authoritative, even when HEAD/upstream differs.
  if (targetBranch && !(await isBranchMergedIntoDefault(mainRepo, name, targetBranch))) {
    return { ok: false, unmerged: true, message: t('分支尚未合入目标，已保留') };
  }
  const r = await gitAllowFail(mainRepo, ['branch', '-d', name]);
  if (r.ok) return { ok: true };
  let target: string | null = null;
  try {
    target = targetBranch?.trim() || await resolveDefaultBranch(mainRepo);
  } catch {
    target = null;
  }
  if (target) {
    const anc = await gitAllowFail(mainRepo, ['merge-base', '--is-ancestor', name, target]);
    if (anc.ok) {
      const force = await gitAllowFail(mainRepo, ['branch', '-D', name]);
      if (force.ok) return { ok: true };
      return { ok: false, message: force.err };
    }
  }
  return { ok: false, unmerged: true, message: r.err };
}

/** Delete a local branch after its owning worktree has already been removed. */
export async function deleteBranchForce(
  mainRepo: string,
  branch: string
): Promise<{ ok: boolean; message?: string }> {
  const name = branch.trim();
  if (!name) return { ok: false, message: t('空分支名') };
  const result = await gitAllowFail(mainRepo, ['branch', '-D', name]);
  return result.ok ? { ok: true } : { ok: false, message: result.err };
}
