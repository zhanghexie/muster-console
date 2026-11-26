import { randomUUID } from 'node:crypto';
import type { AppContext } from '../context';
import type { DelegateTaskInput, DelegateTaskResult } from './delegate';
import { countActiveCodingWorkers, resolveMaxConcurrentWorkers, shouldQueueByCount } from '../../shared/sessionQuery';
import { readWorkspaceFile } from '../metaAgent/workspaceFile';
import { isSchedulerInvocation, runAsSchedulerTool } from '../agent/agentScope';
import { t } from '../../shared/i18n';
import { localizeGuiHostError } from '../../shared/guiHostError';
import { controlRootFor, defaultRootFor, requireSourceRoot } from '../../shared/workspaceRoots';
import { requireWorkspace, sourcePathKey } from '../workspacePaths';
import { captureWorktreeSelectionSources } from '../git/worktreeSelectionSources';

export type QueuedDelegateItem = {
  queueId: string;
  workspaceId: string;
  enqueuedAt: number;
  name?: string;
  /** 入队时捕获的派活身份：drain 在游离 promise 链外执行，ALS 传不过去，
   *  凭此旗标重包 runAsSchedulerTool，让 delegateTask 内的编排打标照常生效 */
  orchestrated: boolean;
  /** 已尝试次数：drain 失败重试的封顶依据，防止确定性失败项每次槽位释放都重来 */
  attempts: number;
  /** run 已请求取消（r1-W3）：在途（launching）项标记后，创建失败不再回插重试，直接 dropped 结算 */
  cancelRequested?: boolean;
  input: DelegateTaskInput;
  ctx: AppContext;
};

/** Creation failures without a retained session may retry; committed creations never repeat. */
const DELEGATE_RETRY_MAX = 3;

const queues = new Map<string, QueuedDelegateItem[]>();
const launching = new Map<string, QueuedDelegateItem>();
const drainChains = new Map<string, Promise<void>>();
let runDelegate: ((ctx: AppContext, input: DelegateTaskInput) => Promise<DelegateTaskResult>) | null =
  null;

export function bindDelegateRunner(
  fn: (ctx: AppContext, input: DelegateTaskInput) => Promise<DelegateTaskResult>
): void {
  runDelegate = fn;
}

export function resetDelegateQueueForTests(): void {
  queues.clear();
  launching.clear();
  drainChains.clear();
  slotFreedListener = null;
  drainedListeners.clear();
}

export function listDelegateQueue(workspaceId: string): Array<{
  queueId: string;
  name?: string;
  enqueuedAt: number;
}> {
  return (queues.get(workspaceId) ?? []).map((x) => ({
    queueId: x.queueId,
    name: x.name,
    enqueuedAt: x.enqueuedAt
  }));
}

/**
 * 撤销排队派活（工作流 run 取消时收回，W3）：只按 queueId 精确移除，
 * 未出队的项直接删掉（drain 不再看到它）；已开始创建（launching）的删不掉——标记
 * cancelRequested 后返回 false：随后创建若失败，drain 不再回插重试（r1-W5），
 * 以 dropped 结算让调用方清 pending 记账。不碰其他项，也不抢占正在创建的资源。
 */
export function cancelQueuedDelegate(queueId: string): boolean {
  for (const [ws, list] of queues) {
    const idx = list.findIndex((x) => x.queueId === queueId);
    if (idx === -1) continue;
    list.splice(idx, 1);
    if (!list.length) queues.delete(ws);
    return true;
  }
  const launchingItem = launching.get(queueId);
  if (launchingItem) launchingItem.cancelRequested = true;
  return false;
}

/** Includes shifted items until the runner settles; never expose mutable queued input. */
export function listDelegateSourceUses(workspaceId: string) {
  return [...(queues.get(workspaceId) ?? []), ...launching.values()]
    .filter(item => item.workspaceId === workspaceId)
    .map(item => ({ queueId: item.queueId, workspaceId: item.workspaceId, name: item.name,
      sourceRoot: structuredClone(item.input.capturedSource), sourceRoots: structuredClone(item.input.capturedIsolationSources), cwd: item.input.cwd }));
}

export function readMaxConcurrentWorkers(ctx: AppContext, workspaceId: string): number {
  const cfg = ctx.config.get();
  const ws = requireWorkspace(cfg, workspaceId);
  const file = readWorkspaceFile(controlRootFor(ws));
  return resolveMaxConcurrentWorkers(file.maxConcurrentWorkers);
}

export function activeWorkerCount(ctx: AppContext, workspaceId: string): number {
  return countActiveCodingWorkers(ctx.sessions.listByWorkspace(workspaceId));
}

export function shouldQueueDelegate(ctx: AppContext, workspaceId: string): boolean {
  const max = readMaxConcurrentWorkers(ctx, workspaceId);
  return shouldQueueByCount(activeWorkerCount(ctx, workspaceId), max);
}

export function enqueueDelegate(
  ctx: AppContext,
  workspaceId: string,
  input: DelegateTaskInput
): { queueId: string; position: number; maxConcurrentWorkers: number; activeWorkers: number } {
  if (typeof input.isolate !== 'boolean') throw new Error('isolate 必须显式为 true 或 false，才能入队。');
  if (input.isolationGroups) {
    const selection = captureWorktreeSelectionSources(ctx.config.get(), { ...input, workspaceId, isolationGroups: input.isolationGroups });
    input = { ...input, isolationGroups: selection.selections, capturedIsolationSources: selection.sources };
  }
  const workspace = requireWorkspace(ctx.config.get(), workspaceId);
  const root = input.rootId !== undefined ? requireSourceRoot(workspace, input.rootId) : defaultRootFor(workspace);
  const source = input.capturedSource ?? { rootId: root.id, path: root.path, cwd: input.cwd ?? root.path, physicalPath: sourcePathKey(root.path) };
  const capturedInput: DelegateTaskInput = structuredClone({ ...input, workspaceId, rootId: root.id, cwd: input.cwd ?? source.cwd, capturedSource: source, rootsRevision: undefined });
  const maxConcurrentWorkers = readMaxConcurrentWorkers(ctx, workspaceId);
  const activeWorkers = activeWorkerCount(ctx, workspaceId);
  const list = queues.get(workspaceId) ?? [];
  if (input.desktopUserInstruction && input.creationKey) {
    const index = list.findIndex(item => item.input.creationKey === input.creationKey);
    if (index >= 0) return { queueId: list[index].queueId, position: index + 1, maxConcurrentWorkers, activeWorkers };
  }
  const item: QueuedDelegateItem = {
    queueId: randomUUID(),
    workspaceId,
    enqueuedAt: Date.now(),
    name: input.name,
    orchestrated: isSchedulerInvocation(),
    attempts: 0,
    input: capturedInput,
    ctx
  };
  list.push(item);
  queues.set(workspaceId, list);
  return {
    queueId: item.queueId,
    position: list.length,
    maxConcurrentWorkers,
    activeWorkers
  };
}

let slotFreedListener: ((workspaceId: string) => void) | null = null;

/** R1：并发位释放后通知事件泵（index 装配；避免与 orchestrator/events 循环依赖） */
export function setDelegateSlotFreedListener(fn: ((workspaceId: string) => void) | null): void {
  slotFreedListener = fn;
}

export function notifyDelegateSlotFreed(workspaceId: string): void {
  if (!workspaceId) return;
  try {
    slotFreedListener?.(workspaceId);
  } catch (err) {
    console.error('[delegate-queue] slot listener failed', err);
  }
  const prev = drainChains.get(workspaceId) ?? Promise.resolve();
  const next = prev.then(
    () => drainDelegateQueue(workspaceId),
    () => drainDelegateQueue(workspaceId)
  );
  drainChains.set(workspaceId, next);
  void next.finally(() => {
    if (drainChains.get(workspaceId) === next) drainChains.delete(workspaceId);
  });
}

export type DelegateDrainedOutcome =
  | { ok: true; result: DelegateTaskResult }
  /** dropped=已停止重试（否则仍在队里）；sessionId=出口已建出且保留的会话
   *  （r2-W1：结构化失败贯穿队列/桥，调用方据此补关/记账，不丢资源标识） */
  | { ok: false; error: string; dropped: boolean; sessionId?: string };

const drainedListeners = new Set<(queueId: string, workspaceId: string, outcome: DelegateDrainedOutcome) => void>();

/** 排队项出队执行后的回调（工作流 wf.delegate 据 queueId 等到真正拉起）；返回退订函数 */
export function addDelegateDrainedListener(
  fn: (queueId: string, workspaceId: string, outcome: DelegateDrainedOutcome) => void
): () => void {
  drainedListeners.add(fn);
  return () => drainedListeners.delete(fn);
}

function emitDrained(queueId: string, workspaceId: string, outcome: DelegateDrainedOutcome): void {
  for (const fn of [...drainedListeners]) {
    try {
      fn(queueId, workspaceId, outcome);
    } catch (err) {
      console.error('[delegate-queue] drained listener failed', err);
    }
  }
}

export async function drainDelegateQueue(workspaceId: string): Promise<void> {
  const runner = runDelegate;
  if (!runner) return;
  for (;;) {
    const list = queues.get(workspaceId);
    if (!list?.length) return;
    const head = list[0]!;
    // Closing a workspace must reach the normal failure/report path, not strand the queue.
    if (head.ctx.config.get().workspaces.some((w) => w.id === workspaceId && !w.rootsError) && shouldQueueDelegate(head.ctx, workspaceId)) return;
    list.shift();
    launching.set(head.queueId, head);
    if (!list.length) queues.delete(workspaceId);
    else queues.set(workspaceId, list);
    try {
      const run = () => runner(head.ctx, { ...head.input, isCancelled: () => head.cancelRequested === true });
      const result = await (head.orchestrated ? runAsSchedulerTool(run) : run());
      emitDrained(head.queueId, workspaceId, { ok: true, result });
    } catch (err) {
      console.error('[delegate-queue] drain failed', head.queueId, err);
      // 出口已建出且保留的会话（delegate.ts 投递阶段结构化失败）随 outcome 贯穿，
      // 不在队列/桥上丢弃——调用方（workflow runtime）据此补关/记账（r2-W1）
      const failedSessionId = (err as { sessionId?: unknown } | null)?.sessionId;
      const resource = typeof failedSessionId === 'string' && failedSessionId ? { sessionId: failedSessionId } : {};
      // run 已请求取消（r1-W5）：不重试、不回插——以 dropped 结算，调用方（bridge →
      // workflow runtime）收到 rejection 后清 pending 占位/计数，不会再派出第二个会话
      if (head.cancelRequested) {
        emitDrained(head.queueId, workspaceId, {
          ok: false,
          error: t('工作流 run 已取消，派活不再重试'),
          dropped: true,
          ...resource
        });
        return;
      }
      const routed = head.input.capturedRoute !== undefined;
      emitDrained(head.queueId, workspaceId, {
        ok: false,
        error: String((err as Error)?.message ?? err),
        dropped: routed || !!resource.sessionId || head.attempts + 1 > DELEGATE_RETRY_MAX,
        ...resource
      });
      // No retained session: retry creation at the tail, within the existing bound.
      // Retained session: preserve its id and stop; another creation would duplicate work.
      const attempts = head.attempts + 1;
      if (routed || resource.sessionId || attempts > DELEGATE_RETRY_MAX) {
        head.ctx.notify?.push({
          workspaceId,
          sessionId: resource.sessionId ?? `delegate-queue:${head.queueId}`,
          sessionName: head.name ?? t('派活队列'),
          kind: 'error',
          text: resource.sessionId ? t('派活投递失败，原会话 {{id}} 已保留；未自动重复创建。{{error}}', { id: resource.sessionId, error: localizeGuiHostError(String((err as Error)?.message ?? err)) }) : routed ? String((err as Error)?.message ?? err) : t('派活任务「{{name}}」连续 {{n}} 次失败，已停止重试', {
            name: head.name ?? head.input.task.slice(0, 40),
            n: DELEGATE_RETRY_MAX
          }),
          update: true,
          updateKey: `delegate-queue-drop:${head.queueId}`,
          toast: true
        });
      } else {
        head.attempts = attempts;
        const cur = queues.get(workspaceId) ?? [];
        cur.push(head);
        queues.set(workspaceId, cur);
      }
      const left = queues.get(workspaceId);
      if (left && !left.length) queues.delete(workspaceId);
      return;
    } finally {
      launching.delete(head.queueId);
    }
  }
}
