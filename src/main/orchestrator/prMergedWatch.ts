/**
 * PR merged → 收口提醒（R-19）：PR 页轮询「我开的 open PR」列表，
 * 某 PR 从列表消失时逐个通过 GitHub API 复核，MERGED 即经 settleNotify
 * 缝提醒调度「对应会话/任务待收口」。只提醒不自动收口——人工/调度核对后结（保守）。
 *
 * 会话映射：headRefName === SessionMeta.worktreeBranch（events.ts 合入受阻事件的
 * 同款先例）；关联经会话 worktreeBranch 反查。防重报：已提醒过的 PR（repo+number）
 * 进程内不再提；检测依赖 PR 页轮询，应用未开轮询期间发生的合并不补报。
 */
import type { AppContext } from '../context';
import type { PrSummary } from '../../shared/githubPr';
import { pathKey } from '../../shared/pathKey';
import { diffVanishedPrNumbers } from '../../shared/prMergeWatch';
import { notifySettleWarn } from './settleNotify';
import { emitMemoryIntentEvent } from '../memory/intentEvents';
import { mergeNotificationTarget } from '../git/mergeNotificationTarget';

interface RepoWatch {
  /** 上轮 open PR（number → headRefName/title，供消失者反查分支） */
  seen: Map<number, Pick<PrSummary, 'headRefName' | 'title'>>;
  /** 已提醒过 merged 的 PR（repo+number 进程内不重提） */
  reported: Set<number>;
  /** 同仓串行：防并发轮询交叉差分误报 */
  chain: Promise<void>;
}

const repoWatches = new Map<string, RepoWatch>();

export function resetPrMergedWatchForTest(): void {
  repoWatches.clear();
}

/**
 * 每轮 open 列表快照：差分消失者 → 复核 state → MERGED 提醒。
 * stateOf 按调用方解析出的远端仓库与当前 GitHub 账号复核。
 */
export async function notePrOpenSnapshot(
  ctx: AppContext,
  opts: {
    cwd?: string;
    identity?: string;
    prs: Pick<PrSummary, 'number' | 'headRefName' | 'title'>[];
    stateOf: (pr: number) => Promise<string>;
  }
): Promise<void> {
  const key = JSON.stringify([opts.identity ?? '', pathKey(opts.cwd ?? '')]);
  const watch = repoWatches.get(key) ?? { seen: new Map(), reported: new Set(), chain: Promise.resolve() };
  repoWatches.set(key, watch);
  const run = (): Promise<void> =>
    applySnapshot(ctx, watch, opts.cwd, opts.prs, opts.stateOf);
  const next = watch.chain.then(run, run);
  watch.chain = next.then(
    () => undefined,
    () => undefined
  );
  await next;
}

async function applySnapshot(
  ctx: AppContext,
  watch: RepoWatch,
  cwd: string | undefined,
  prs: Pick<PrSummary, 'number' | 'headRefName' | 'title'>[],
  stateOf: (pr: number) => Promise<string>
): Promise<void> {
  // 上轮 open 为空（含首轮）时无基线：没有可消失者，也不会把历史 merged PR 误报
  const vanished = diffVanishedPrNumbers(
    watch.seen.size > 0 ? [...watch.seen.keys()] : null,
    prs.map((p) => p.number)
  );
  const carry = new Map<number, { headRefName: string; title: string }>();
  for (const n of vanished) {
    if (watch.reported.has(n)) continue;
    const meta = watch.seen.get(n);
    const state = await stateOf(n).catch(() => '');
    if (state === 'MERGED') {
      watch.reported.add(n);
      notifyMergedPr(ctx, cwd, {
        number: n,
        title: meta?.title ?? '',
        headRefName: meta?.headRefName ?? ''
      });
    } else if (state === '') {
      // 复核失败：保留到下一轮，避免该次合并永久漏报。
      carry.set(n, meta ?? { headRefName: '', title: '' });
    }
    // CLOSED 等：静默消失，不提醒；重新 open 会再次进 seen，后续仍可检测
  }
  watch.seen = new Map([
    ...prs.map((p) => [p.number, { headRefName: p.headRefName, title: p.title }] as const),
    ...carry
  ]);
}

function notifyMergedPr(
  ctx: AppContext,
  cwd: string | undefined,
  pr: { number: number; title: string; headRefName: string }
): void {
  let target: ReturnType<typeof mergeNotificationTarget>;
  try {
    const cfg = ctx.config.get(), workspaces = ctx.workspaces.list();
    if (cwd?.trim()) {
      target = mergeNotificationTarget({ workspaces },
        id => ctx.sessions.listByWorkspace(id), cwd, pr.headRefName);
    } else {
      const workspace = workspaces.find(w => w.id === cfg.activeWorkspaceId && !w.rootsError);
      if (workspace) {
        const matches = ctx.sessions.listByWorkspace(workspace.id).filter(s => s.worktreeBranch === pr.headRefName ||
          s.worktreeGroups?.groups.some(group => group.branch === pr.headRefName || group.repos.some(repo => repo.branch === pr.headRefName)));
        target = { workspaceId: workspace.id, session: matches.length === 1 ? matches[0] : undefined };
      }
    }
  } catch (err) {
    console.error('[pr-merged-watch] 会话反查失败', err);
  }
  if (!target) return;
  const { workspaceId, session } = target;
  const titleBit = pr.title.trim() ? `「${pr.title.trim()}」` : '';
  const tailBit = session
      ? `会话 ${session.name} 待核对收口`
      : '未找到对应会话，请核对收口';
  // B7 意图事件面：PR merged → 意图谓词扫描（缝内全兜底）
  emitMemoryIntentEvent({
    kind: 'pr_merged',
    workspaceId,
    branch: pr.headRefName,
    repo: cwd
  });
  notifySettleWarn({
    workspaceId,
    ...(session ? { sessionId: session.id, sessionName: session.name } : {}),
    detail: `PR #${pr.number}${titleBit}已合并，${tailBit}`
  });
}
