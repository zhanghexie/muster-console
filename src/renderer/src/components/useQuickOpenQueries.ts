import { randomUuid } from '../../../shared/randomUuid';
import { useEffect, useRef, useState } from 'react';
import type { WorkspaceListedFile, WorkspaceQueryResult, WorkspaceSearchHit } from '../../../shared/types';
import { CONTENT_SEARCH_DEBOUNCE_MS, CONTENT_SEARCH_MAX_RESULTS } from '../../../shared/commandPalette';

type FileResult = WorkspaceQueryResult<WorkspaceListedFile>;
type Lease = { promise: Promise<FileResult>; users: number; settled: boolean; abandoned: boolean; requestId: string };
const inFlightFiles = new Map<string, Lease>();

/** 跨开合的枚举结果缓存（scope = workspaceId + rootsRevision）。hook 实例缓存随
 *  QuickOpen 卸载即丢，每次打开都得重新枚举（主进程 rg 子进程 + IPC 往返，首开
 *  100ms+）；这里以模块级缓存承接——同 scope 再次打开先立刻出旧结果（stale-
 *  while-revalidate：后台照常拉新，到达后覆盖）。容量上限防多工作区长期驻留。 */
const RESULT_CACHE_MAX = 6;
const resultCache = new Map<string, FileResult>();
function rememberResult(scope: string, result: FileResult): void {
  if (result.cancelled) return;
  resultCache.delete(scope);
  resultCache.set(scope, result);
  while (resultCache.size > RESULT_CACHE_MAX) {
    const oldest = resultCache.keys().next().value;
    if (oldest === undefined) break;
    resultCache.delete(oldest);
  }
}

/** 空闲预热：把当前工作区的文件枚举提前到后台（rg 在主进程侧跑，不占渲染层），
 *  palette 首开直接命中缓存。同一 scope 已有缓存或在途则不重复拉。 */
export function prewarmQuickOpenFiles(workspaceId: string, revision: number): void {
  const scope = JSON.stringify([workspaceId, revision]);
  if (resultCache.has(scope) || inFlightFiles.has(scope)) return;
  const lease = acquireFiles(workspaceId, scope);
  void lease.promise
    .then(result => { if (result.rootsRevision === revision) rememberResult(scope, result); })
    .catch(() => {})
    .finally(() => lease.release());
}

/** 同根版本的在途枚举共享；最后一个消费者退出才取消。 */
function acquireFiles(workspaceId: string, scope: string): { promise: Promise<FileResult>; isAbandoned: () => boolean; release: () => void } {
  let lease = inFlightFiles.get(scope);
  if (!lease) {
    const requestId = randomUuid();
    let created: Lease;
    const promise = (async () => window.api.fs.listFiles(workspaceId, { max: 8000, requestId }))()
      .finally(() => {
        created.settled = true;
        if (inFlightFiles.get(scope) === created) inFlightFiles.delete(scope);
      });
    created = { users: 0, settled: false, abandoned: false, requestId, promise };
    lease = created;
    inFlightFiles.set(scope, lease);
  }
  lease.users++;
  const acquired = lease;
  let released = false;
  return { promise: acquired.promise, isAbandoned: () => acquired.abandoned, release: () => {
    if (released) return;
    released = true;
    acquired.users--;
    // 同一提交中的卸载/重挂允许新消费者接手；不保留无人使用的查询。
    queueMicrotask(() => {
      if (acquired.users || acquired.settled) return;
      acquired.abandoned = true;
      if (inFlightFiles.get(scope) === acquired) inFlightFiles.delete(scope);
      Promise.resolve(window.api.fs.cancelQuery(workspaceId, acquired.requestId))
        .catch(err => console.warn('[quick-open] cancel file query failed', err));
    });
  } };
}

interface QueryState<T> { scope: string; loading: boolean; result?: WorkspaceQueryResult<T>; error?: string }
function empty<T>(scope: string): QueryState<T> { return { scope, loading: false }; }

export function useQuickOpenFiles(workspaceId: string, revision: number, enabled: boolean): QueryState<WorkspaceListedFile> {
  const scope = JSON.stringify([workspaceId, revision]);
  const [state, setState] = useState<QueryState<WorkspaceListedFile>>(() => empty(scope));
  const cached = useRef<QueryState<WorkspaceListedFile>>();
  useEffect(() => {
    if (!enabled) return;
    if (cached.current?.scope === scope) { setState(cached.current); return; }
    // 模块级缓存命中：先出旧结果（loading=false），后台 revalidate 到达后覆盖
    const warm = resultCache.get(scope);
    if (warm) {
      const s = { scope, loading: false, result: warm };
      setState(s);
    }
    const lease = acquireFiles(workspaceId, scope);
    let alive = true;
    if (!warm) setState({ scope, loading: true });
    void lease.promise.then(result => {
      // A canceled request may still resolve; it must not replace a newer result.
      if (!lease.isAbandoned() && result.rootsRevision === revision) rememberResult(scope, result);
      if (!alive || result.cancelled || result.rootsRevision !== revision) return;
      cached.current = { scope, loading: false, result };
      setState(cached.current);
    }).catch(err => {
      if (!alive) return;
      cached.current = { scope, loading: false, error: err instanceof Error ? err.message : String(err) };
      setState(cached.current);
    }).finally(() => {
      if (alive) setState(value => value.scope === scope ? { ...value, loading: false } : value);
    });
    return () => { alive = false; lease.release(); };
  }, [workspaceId, revision, scope, enabled]);
  return state.scope === scope ? { ...state, loading: enabled && state.loading } : { scope, loading: enabled };
}

export function useQuickOpenContent(workspaceId: string, revision: number, enabled: boolean,
  query: string, caseSensitive: boolean): QueryState<WorkspaceSearchHit> {
  const scope = JSON.stringify([workspaceId, revision, query, caseSensitive]);
  const [state, setState] = useState<QueryState<WorkspaceSearchHit>>(() => empty(scope));
  useEffect(() => {
    if (!enabled || !query) { setState(empty(scope)); return; }
    let alive = true;
    const requestId = randomUuid();
    setState({ scope, loading: true });
    const timer = window.setTimeout(() => {
      void window.api.fs.searchFiles(workspaceId, { query, caseSensitive, max: CONTENT_SEARCH_MAX_RESULTS, requestId })
        .then(result => {
          if (!alive || result.cancelled || result.rootsRevision !== revision) return;
          setState({ scope, loading: false, result });
        }).catch(err => {
          if (alive) setState({ scope, loading: false, error: err instanceof Error ? err.message : String(err) });
        }).finally(() => {
          if (alive) setState(value => value.scope === scope ? { ...value, loading: false } : value);
        });
    }, CONTENT_SEARCH_DEBOUNCE_MS);
    return () => {
      alive = false;
      window.clearTimeout(timer);
      Promise.resolve(window.api.fs.cancelQuery(workspaceId, requestId))
        .catch(err => console.warn('[quick-open] cancel content query failed', err));
    };
  }, [workspaceId, revision, scope, enabled, query, caseSensitive]);
  return state.scope === scope ? state : { scope, loading: enabled && !!query };
}
