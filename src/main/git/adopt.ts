/**
 * hunk 级原子采纳（T5.5，参考 wmux TaskAdoptService 五性质）：
 * 把隔离 worktree 的部分改动（按 hunk 勾选）落到主仓，默认 staged 不 commit。
 *
 * 五性质（test/git-hunk-adopt.mjs 逐条守卫，还原任一即红）：
 * 1. diff 基取 merge-base（主仓 HEAD ∩ worktree HEAD），不是主仓 HEAD——否则主仓
 *    分叉后的提交会以「反向 diff」混进 patch，先采纳的会被后采纳回滚。
 * 2. `git apply --check` 先行；真 apply 仍失败时还原被触碰路径（reset+checkout+clean），
 *    目标永不半应用。
 * 3. 默认 staged 不 commit：`apply --3way --index` 写入 index，HEAD 不动，由人决定去留。
 * 4. diff 在临时 GIT_INDEX_FILE 上生成（read-tree + add -A -N），不往 Worker 的
 *    worktree 索引里写 intent-to-add 残留。
 * 5. 按目标仓串行闸：干净检查与 apply 隔着多次 git 调用，并发采纳会互相叠写。
 *
 * 无 electron 依赖，真 git 回归走 test/git-hunk-adopt.mjs（createSharedCompiler 直挂）。
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { GitAdoptHunkKey, GitAdoptHunksResult, GitAdoptPreviewResult } from '../../shared/types';
import { adoptHunkKeyId } from '../../shared/gitAdopt';
import { t } from '../../shared/i18n';
import { readGitDirectories, resolveRegisteredWorktree, type RepoIdentity } from './repoIdentity';
import { pathKey } from '../pathKey';
import { gitCommandEnvironment } from './gitEnvironment';
import { beginWorktreeRepositoryOperation } from './worktreeTaskOperation';

const execFileAsync = promisify(execFile);

/** 单次 git 调用超时 / 输出上限（与 mergeIsolate 对齐，diff 上限放宽到 64MB） */
const GIT_TIMEOUT_MS = 60_000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

/** 可注入 git（真 git 回归测试用它做时序/失败注入）；env 承载 GIT_INDEX_FILE */
export type AdoptGit = (
  args: string[],
  cwd: string,
  env?: Record<string, string>
) => Promise<{ code: number; stdout: string; stderr: string }>;

/** 默认 git：argv only、cwd 固定、永不 throw——非零退出是调用方分支用的数据 */
const defaultGit: AdoptGit = async (args, cwd, env) => {
  try {
    const { stdout, stderr } = await execFileAsync('git', ['--work-tree', path.resolve(cwd), ...args], {
      cwd,
      windowsHide: true,
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      env: { ...gitCommandEnvironment(), ...env }
    });
    return { code: 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') };
  } catch (e) {
    const err = e as { stdout?: string | Buffer; stderr?: string | Buffer; code?: number };
    return {
      stdout: String(err.stdout ?? ''),
      stderr: String(err.stderr ?? '') || String((e as Error).message ?? e),
      code: typeof err.code === 'number' ? err.code : 1
    };
  }
};

/** hunk 键序列化：`file|oldStart,oldLines,newStart,newLines`（与渲染层 shared/gitAdopt 同源） */
export { adoptHunkKeyId };

// ---------- unified diff 解析（hunk 抽取用，与渲染层 react-diff-view 的 hunk 头对齐） ----------

interface ParsedHunk {
  /** @@ 头整行 */
  header: string;
  key: GitAdoptHunkKey;
  /** hunk 正文行（含 `\ No newline` 行，到下一个 @@ / diff --git / EOF） */
  body: string[];
}

interface ParsedFile {
  /** b/ 侧路径（react-diff-view newPath 同源），删除文件退化 a/ 侧 */
  path: string;
  /** `diff --git` 到首个 @@ 的全部头行（mode/rename/---/+++，apply 需要完整保留） */
  header: string[];
  hunks: ParsedHunk[];
  /** GIT binary patch 段：无 @@ hunk，hunk 级采纳不可选（边界，见 isolate-worktree.md） */
  binary: boolean;
}

/** @@ -oldStart[,oldLines] +newStart[,newLines] @@ → 四元组（省略时 lines=1） */
export function parseHunkHeader(line: string): GitAdoptHunkKey | null {
  const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
  if (!m) return null;
  return {
    file: '',
    oldStart: Number(m[1]),
    oldLines: m[2] === undefined ? 1 : Number(m[2]),
    newStart: Number(m[3]),
    newLines: m[4] === undefined ? 1 : Number(m[4])
  };
}

/** 剥 `+++ b/xxx` / `--- a/xxx` 前缀与引号包裹；`/dev/null` 返回 null */
function stripDiffPath(line: string, prefix: 'a' | 'b'): string | null {
  const m = line.match(new RegExp(`^${prefix === 'a' ? '---' : '\\+\\+\\+'} (.+)$`));
  if (!m) return null;
  let p = m[1]!.replace(/\t.*$/, '').trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
  if (p === `/dev/null`) return null;
  // `a/`、`b/` 前缀一并剥（保留 b/ 后的原始路径）；“--stdin 无前缀”形态不会出现在 diff 输出
  if (p.startsWith(`${prefix}/`)) p = p.slice(2);
  return p;
}

/** 完整 unified diff → 文件段/hunk 结构。坏输入返回 []（调用方按 empty/stale 分支） */
export function parseUnifiedDiff(diffText: string): ParsedFile[] {
  const lines = diffText.split('\n');
  const files: ParsedFile[] = [];
  let cur: ParsedFile | null = null;
  let curHunk: ParsedHunk | null = null;

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      cur = { path: '', header: [line], hunks: [], binary: false };
      files.push(cur);
      curHunk = null;
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('@@ ')) {
      const k = parseHunkHeader(line);
      if (k) {
        curHunk = { header: line, key: k, body: [] };
        cur.hunks.push(curHunk);
      } else {
        curHunk = null;
      }
      continue;
    }
    if (line.startsWith('GIT binary patch')) {
      cur.binary = true;
      curHunk = null;
      continue;
    }
    if (line === '\\ No newline at end of file') {
      // 属于上一 change 行，跟在当前 hunk 正文尾部
      curHunk?.body.push(line);
      continue;
    }
    if (curHunk) {
      curHunk.body.push(line);
      continue;
    }
    // 文件头区（---/+++/rename/mode/index）
    if (cur.path === '') {
      const np = stripDiffPath(line, 'b');
      if (np) cur.path = np;
    }
    if (cur.path === '') {
      const op = stripDiffPath(line, 'a');
      if (op) cur.path = op;
    }
    cur.header.push(line);
  }
  // 尾部空行噪声：body 最后一行可能是 ''（diff 末尾换行 split 产物），只在 EOF 处丢弃
  for (const f of files) {
    for (const h of f.hunks) {
      while (h.body.length > 0 && h.body[h.body.length - 1] === '') h.body.pop();
    }
  }
  return files;
}

/** 从全量 diff 抽取选中 hunk 重组子 patch；任何键对不上（diff 已变）→ stale 拒绝 */
export function filterPatchByHunks(
  diffText: string,
  keys: GitAdoptHunkKey[]
): { patch: string; files: string[] } | { stale: string[] } {
  // 入口规范化：file 剥 git 可能携带的引号包裹（渲染层透传与主进程解析统一为 canonical）
  const norm = (file: string): string =>
    file.length >= 2 && file.startsWith('"') && file.endsWith('"')
      ? file.slice(1, -1)
      : file;
  const wanted = new Set(keys.map((k) => adoptHunkKeyId({ ...k, file: norm(k.file) })));
  const matched = new Set<string>();
  const files = new Set<string>();
  const out: string[] = [];

  for (const f of parseUnifiedDiff(diffText)) {
    const picked = f.hunks.filter((h) => {
      const id = adoptHunkKeyId({ ...h.key, file: f.path });
      if (wanted.has(id)) {
        matched.add(id);
        files.add(f.path);
        return true;
      }
      return false;
    });
    if (picked.length === 0) continue;
    out.push(...f.header, ...picked.flatMap((h) => [h.header, ...h.body]));
  }

  const missing = [...wanted].filter((id) => !matched.has(id));
  if (missing.length > 0) {
    // diff 与预览时已不一致（Worker 又写了 / 勾选了过期键）——宁可拒绝也不应用看过的以外内容
    return { stale: missing };
  }
  return { patch: `${out.join('\n')}\n`, files: [...files] };
}

// ---------- 采纳服务 ----------

export interface AdopterOptions {
  /** 注入点：真 git 回归测试做时序/失败注入（其余 argv 全真跑） */
  git?: AdoptGit;
  resolveIdentity?: (worktreePath: string) => Promise<RepoIdentity | null>;
  /** Recheck the request owner after preview/check and before the first real apply. */
  beforeApply?: (targetRepo: string) => Promise<void>;
  /** 临时 index / 临时 patch 的目录工厂（默认 os.tmpdir 私有目录） */
  makeTempDir?: () => string;
}

/** `--porcelain=v1 -z` → 条目数（脏检查用，非零即脏） */
function porcelainEntryCount(stdout: string): number {
  return stdout.split('\0').filter((rec) => rec.length >= 4).length;
}

/** Pin physical Git ownership through preview/check; a gitfile swap cannot redirect writes. */
function adoptionIdentity(worktree: string, source: string, expectedCommon: string): string {
  const physical = (value: string) => pathKey(fs.realpathSync(value));
  const common = physical(expectedCommon);
  const repos = [worktree, source].map((root, index) => {
    const dirs = readGitDirectories(root);
    if (!dirs || physical(dirs.commonDir) !== common) throw new Error('worktree adoption repository identity changed');
    const gitDir = physical(dirs.gitDir), checkout = physical(root);
    if (index === 0) {
      const back = fs.readFileSync(path.join(dirs.gitDir, 'gitdir'), 'utf8').trim();
      if (!gitDir.startsWith(`${common}/worktrees/`) || !path.isAbsolute(back)
        || physical(path.dirname(back)) !== checkout || path.basename(back) !== '.git') throw new Error('worktree adoption registration changed');
    } else if (gitDir !== common) throw new Error('worktree adoption source is not the primary checkout');
    for (const directory of new Set([dirs.gitDir, dirs.commonDir])) {
      for (const marker of ['locked', 'index.lock', 'HEAD.lock', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer']) {
        if (fs.existsSync(path.join(directory, marker))) throw new Error(`repository has an active Git operation: ${marker}`);
      }
    }
    return [checkout, gitDir, fs.readFileSync(path.join(dirs.gitDir, 'HEAD'), 'utf8')];
  });
  return JSON.stringify([common, repos]);
}

export function createAdopter(opts: AdopterOptions = {}) {
  const git: AdoptGit = opts.git ?? defaultGit;
  const makeTempDir =
    opts.makeTempDir ??
    (() => fs.mkdtempSync(path.join(os.tmpdir(), 'muster-adopt-')));

  /** 按目标仓串行闸（性质五）：每仓一条 promise 链，失败不断链 */
  const repoLocks = new Map<string, Promise<unknown>>();
  function withRepoLock<T>(repo: string, work: () => Promise<T>): Promise<T> {
    const key = path.resolve(repo).toLowerCase();
    const prior = repoLocks.get(key) ?? Promise.resolve();
    const run = prior.then(work, work);
    repoLocks.set(
      key,
      run.then(
        () => undefined,
        () => undefined
      )
    );
    return run;
  }

  /** worktree → { 主仓 toplevel, 主仓 HEAD }；worktree 本身是主 checkout 时拒绝 */
  async function resolveTarget(
    worktreePath: string
  ): Promise<{ ok: true; targetRepo: string; commonDir: string } | { ok: false; message: string }> {
    if (!readGitDirectories(worktreePath)) return { ok: false, message: t('无法解析 {{path}} 对应的主仓库', { path: worktreePath }) };
    const identity = await (opts.resolveIdentity ?? resolveRegisteredWorktree)(worktreePath);
    if (!identity) return { ok: false, message: t('无法解析 {{path}} 对应的主仓库', { path: worktreePath }) };
    const targetRepo = identity.mainRepo;
    if (!identity.linked) {
      return {
        ok: false,
        message: t('{{path}} 就是主 checkout，没有可采纳的主仓', { path: worktreePath })
      };
    }
    if (pathKey(identity.root) !== pathKey(path.resolve(worktreePath))) return { ok: false, message: t('无法解析 {{path}} 对应的主仓库', { path: worktreePath }) };
    return { ok: true, targetRepo, commonDir: identity.commonDir };
  }

  /** 临时 GIT_INDEX_FILE 上生成「worktree 全部工作（含未提交/未跟踪）vs base」的 diff（性质四） */
  async function buildWorktreeDiff(
    worktreePath: string,
    base: string
  ): Promise<
    | { ok: true; diff: string; files: string[] }
    | { ok: false; message: string; kind: 'error' | 'empty' }
  > {
    const dir = makeTempDir();
    const env = { GIT_INDEX_FILE: path.join(dir, 'index') };
    try {
      const wtHead = await git(['rev-parse', 'HEAD'], worktreePath);
      const head = wtHead.code === 0 ? wtHead.stdout.trim() : '';
      if (!head) {
        return { ok: false, kind: 'error', message: t('worktree 没有 HEAD 提交') };
      }
      const seed = await git(['read-tree', head], worktreePath, env);
      if (seed.code !== 0) {
        return {
          ok: false,
          kind: 'error',
          message: t('临时索引初始化失败：{{err}}', { err: seed.stderr.trim() })
        };
      }
      const added = await git(['add', '-A', '-N'], worktreePath, env);
      if (added.code !== 0) {
        return {
          ok: false,
          kind: 'error',
          message: t('暂存 worktree 新文件失败：{{err}}', { err: added.stderr.trim() })
        };
      }
      const diff = await git(['diff', '--binary', base], worktreePath, env);
      if (diff.code !== 0) {
        return {
          ok: false,
          kind: 'error',
          message: t('生成 worktree diff 失败：{{err}}', { err: diff.stderr.trim() })
        };
      }
      if (diff.stdout.trim().length === 0) {
        return { ok: false, kind: 'empty', message: t('worktree 相对共享基线没有可采纳的改动') };
      }
      const names = await git(['diff', '--name-only', '-z', base], worktreePath, env);
      const files = names.stdout.split('\0').map((l) => l.trim()).filter(Boolean);
      return { ok: true, diff: diff.stdout, files };
    } finally {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  }

  /** 解析 base（性质一）：merge-base(主仓 HEAD, worktree HEAD)，无共享提交则拒绝 */
  async function resolveBase(
    targetRepo: string,
    worktreePath: string
  ): Promise<{ ok: true; base: string } | { ok: false; message: string }> {
    const parentHead = await git(['rev-parse', 'HEAD'], targetRepo);
    const wtHead = await git(['rev-parse', 'HEAD'], worktreePath);
    if (parentHead.code !== 0 || !parentHead.stdout.trim()) {
      return { ok: false, message: t('主仓没有 HEAD 提交，无法采纳') };
    }
    if (wtHead.code !== 0 || !wtHead.stdout.trim()) {
      return { ok: false, message: t('worktree 没有 HEAD 提交') };
    }
    const mb = await git(
      ['merge-base', parentHead.stdout.trim(), wtHead.stdout.trim()],
      targetRepo
    );
    const base = mb.code === 0 ? mb.stdout.trim() : '';
    if (!base) {
      return {
        ok: false,
        message: t('worktree 与主仓没有共享提交（历史被改写？），请先 rebase 再采纳')
      };
    }
    return { ok: true, base };
  }

  /** 预览：worktree 相对 merge-base 的完整 diff（渲染层 parseDiff 出 hunk 勾选） */
  async function adoptPreview(worktreePath: string): Promise<GitAdoptPreviewResult> {
    const target = await resolveTarget(worktreePath);
    if (!target.ok) return { ok: false, message: target.message };
    const identity = adoptionIdentity(worktreePath, target.targetRepo, target.commonDir);
    const base = await resolveBase(target.targetRepo, worktreePath);
    if (!base.ok) return { ok: false, message: base.message };
    const diff = await buildWorktreeDiff(worktreePath, base.base);
    if (!diff.ok) return { ok: false, message: diff.message };
    if (adoptionIdentity(worktreePath, target.targetRepo, target.commonDir) !== identity) throw new Error('worktree adoption repository identity changed');
    return { ok: true, targetRepo: target.targetRepo, base: base.base, diff: diff.diff };
  }

  /** 撤销半应用：unstage + 还工作树 + 清 untracked，仅限 patch 自己的路径（literal pathspec） */
  async function restore(targetRepo: string, files: string[]): Promise<void> {
    if (files.length === 0) return;
    const specs = files.map((f) => `:(literal)${f}`);
    await git(['reset', '-q', '--', ...specs], targetRepo);
    await git(['checkout', '--', ...specs], targetRepo);
    await git(['clean', '-qfd', '--', ...specs], targetRepo);
  }

  /** 采纳勾选的 hunk 到主仓（性质二/三/五在这里落地） */
  async function adoptHunks(
    worktreePath: string,
    keys: GitAdoptHunkKey[]
  ): Promise<GitAdoptHunksResult> {
    if (keys.length === 0) {
      return { ok: false, message: t('未勾选任何 hunk') };
    }
    const target = await resolveTarget(worktreePath);
    if (!target.ok) return { ok: false, message: target.message };

    return withRepoLock(target.targetRepo, async () => {
      let release: () => void;
      try { release = beginWorktreeRepositoryOperation(pathKey(fs.realpathSync(target.commonDir))); }
      catch (error) { return { ok: false, message: String(error) }; }
      try {
      const identity = adoptionIdentity(worktreePath, target.targetRepo, target.commonDir);
      const heads = await Promise.all([worktreePath, target.targetRepo].map(root => git(['rev-parse', 'HEAD'], root)));
      if (heads.some(head => head.code !== 0)) return { ok: false, message: 'worktree adoption HEAD read failed' };
      const assertIdentity = () => {
        if (adoptionIdentity(worktreePath, target.targetRepo, target.commonDir) !== identity) throw new Error('worktree adoption repository identity changed');
      };
      assertIdentity();
      // 目标必须干净：apply --3way 需要干净基线，还原逻辑也以 HEAD 为锚
      const status = await git(['status', '--porcelain=v1', '-z'], target.targetRepo);
      if (status.code !== 0) {
        return {
          ok: false,
          message: t('读取主仓状态失败：{{err}}', { err: status.stderr.trim() })
        };
      }
      if (porcelainEntryCount(status.stdout) > 0) {
        return {
          ok: false,
          message: t(
            '主仓有未提交改动（含上次采纳留下的 staged），先提交或还原后再采纳'
          )
        };
      }

      const base = await resolveBase(target.targetRepo, worktreePath);
      if (!base.ok) return { ok: false, message: base.message };

      const diff = await buildWorktreeDiff(worktreePath, base.base);
      if (!diff.ok) return { ok: false, message: diff.message };

      const filtered = filterPatchByHunks(diff.diff, keys);
      if ('stale' in filtered) {
        return {
          ok: false,
          message: t(
            'diff 与预览时已不一致（{{n}} 个 hunk 对不上，worktree 可能又被改过），请刷新预览后重选',
            { n: filtered.stale.length }
          )
        };
      }

      const patchDir = makeTempDir();
      const patchFile = path.join(patchDir, 'adopt.patch');
      try {
        fs.writeFileSync(patchFile, filtered.patch, { mode: 0o600 });

        // 性质二：--check 先行，失败时尚未写任何东西
        const check = await git(
          ['apply', '--check', '--3way', '--index', '--whitespace=nowarn', patchFile],
          target.targetRepo
        );
        if (check.code !== 0) {
          return {
            ok: false,
            message: t('改动无法干净地应用到主仓（冲突）：{{err}}', {
              err: check.stderr.trim()
            })
          };
        }

        await opts.beforeApply?.(target.targetRepo);
        assertIdentity();
        const currentHeads = await Promise.all([worktreePath, target.targetRepo].map(root => git(['rev-parse', 'HEAD'], root)));
        assertIdentity();
        if (currentHeads.some((head, index) => head.code !== 0 || head.stdout.trim() !== heads[index]!.stdout.trim())) {
          return { ok: false, message: 'worktree adoption HEAD changed; refresh the preview' };
        }
        const currentStatus = await git(['status', '--porcelain=v1', '-z'], target.targetRepo);
        assertIdentity();
        if (currentStatus.code !== 0 || porcelainEntryCount(currentStatus.stdout)) return { ok: false,
          message: t('主仓有未提交改动（含上次采纳留下的 staged），先提交或还原后再采纳') };
        const applied = await git(
          ['apply', '--3way', '--index', '--whitespace=nowarn', patchFile],
          target.targetRepo
        );
        if (applied.code !== 0) {
          // --check 过了仍失败：树可能被半写入，还原被触碰路径（永不半应用）
          await restore(target.targetRepo, filtered.files);
          return {
            ok: false,
            message: t('应用失败，已还原主仓被触碰的路径：{{err}}', {
              err: applied.stderr.trim()
            })
          };
        }
      } finally {
        try {
          fs.rmSync(patchDir, { recursive: true, force: true });
        } catch {
          /* best effort */
        }
      }

      // 性质三：落到这里就是 staged 待审，不 commit——HEAD 未动，主仓 diff --cached 即采纳内容
      return {
        ok: true,
        targetRepo: target.targetRepo,
        base: base.base,
        files: filtered.files,
        message: t('已采纳 {{n}} 个 hunk 到主仓（staged，未提交）', { n: keys.length })
      };
      } finally { release(); }
    });
  }

  return { adoptPreview, adoptHunks };
}

export type Adopter = ReturnType<typeof createAdopter>;
