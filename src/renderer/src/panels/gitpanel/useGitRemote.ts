import { useCallback, useEffect, useRef } from 'react';
import type { GitRepoStatus } from '../../../../shared/types';
import { pathKey } from '../../../../shared/pathKey';
import { useScopedGit } from './GitWorkspaceScope';
import { beginRemote, finishRemote, remoteSnapshot, useRemoteSnapshot, dismissRemote, type RemoteKind } from './gitRemoteState';

/** Check only the visible repository, at most once per two minutes while focused. */
export const REMOTE_CHECK_INTERVAL_MS = 120_000;
export function useGitRemote({ scopeKey, repoPath, active, busy, status, refreshStatus }: {
  scopeKey: string; repoPath: string | null; active: boolean; busy: boolean;
  status: GitRepoStatus | null; refreshStatus: (path: string | null, quiet?: boolean) => Promise<void>;
}) {
  const git = useScopedGit();
  const key = JSON.stringify([scopeKey, pathKey(repoPath ?? '')]);
  const snapshot = useRemoteSnapshot(key);
  const identity = JSON.stringify([status?.branch, status?.tracking]);
  const check = snapshot.checkIdentity === identity ? snapshot.check : status?.remoteCheck;
  const current = useRef({ key, active, busy, status, refreshStatus });
  current.current = { key, active, busy, status, refreshStatus };
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const run = useCallback(async (kind: RemoteKind, automatic = false) => {
    const context = current.current;
    if (!repoPath || context.key !== key || context.busy) return;
    const operation = { kind, branch: context.status?.branch ?? 'HEAD', tracking: context.status?.tracking ?? null, startedAt: Date.now(), automatic };
    if (!beginRemote(key, operation)) return;
    try {
      const result = await git[kind](repoPath);
      finishRemote(key, operation, result);
    } catch (error) {
      finishRemote(key, operation, { ok: false, message: String(error) });
    }
    // A failed status refresh must never rewrite the remote operation's result.
    if (mounted.current && current.current.key === key && current.current.active) {
      // The data hook owns read errors. Its failure cannot reclassify this result.
      await current.current.refreshStatus(repoPath, true).catch(() => undefined);
    }
  }, [git, key, repoPath]);
  useEffect(() => {
    if (!active || !repoPath || !status?.tracking) return;
    let focused = document.hasFocus();
    const check = () => {
      const context = current.current;
      const state = remoteSnapshot(key);
      const identity = JSON.stringify([context.status?.branch, context.status?.tracking]);
      const checked = (state.checkIdentity === identity ? state.check?.attemptedAt : undefined) ?? context.status?.remoteCheck?.attemptedAt;
      if (!focused || document.visibilityState === 'hidden' || context.busy || state.running) return;
      if (checked && Date.now() - checked < REMOTE_CHECK_INTERVAL_MS) return;
      void run('fetch', true);
    };
    const focus = () => { focused = true; check(); };
    const blur = () => { focused = false; };
    const visible = () => { if (document.visibilityState === 'visible') check(); };
    // Give restored data and local actions priority over background network work.
    const start = window.setTimeout(check, 1_000);
    const timer = window.setInterval(check, REMOTE_CHECK_INTERVAL_MS);
    window.addEventListener('focus', focus); window.addEventListener('blur', blur);
    document.addEventListener('visibilitychange', visible);
    return () => {
      window.clearTimeout(start); window.clearInterval(timer);
      window.removeEventListener('focus', focus); window.removeEventListener('blur', blur);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [active, key, repoPath, status?.tracking, run]);
  return { key, snapshot, check, run, pending: !!snapshot.running, dismiss: () => dismissRemote(key) };
}
export type GitRemoteApi = ReturnType<typeof useGitRemote>;
