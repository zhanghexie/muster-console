import type { AppContext } from '../context';
import { assertSessionTargetCurrent, registeredWorktreeSession, resolveSessionTarget } from './targets';

/** Bounded facts and a UI suggestion only; execution requires an explicit choice. */
export async function isolationRecommendation(ctx: AppContext, workspaceId: string, cwd?: string, rootId?: string, rootsRevision?: number) {
  const inherited = registeredWorktreeSession(ctx.sessions.listByWorkspace(workspaceId), cwd, workspaceId);
  const target = await resolveSessionTarget(ctx.config.get(), { workspaceId, cwd, rootId, rootsRevision }, inherited);
  if (inherited) return { isolate: false, dirty: null, repo: null, resolved: true, target };
  let dirty: boolean | null = null;
  let repo: string | null = null;
  let resolved = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const probe = async () => {
      repo = await ctx.git.resolveMainRepoFor(target.cwd, target.wsPath);
      resolved = true;
      return repo ? await ctx.git.probeDirty(repo) : null;
    };
    dirty = await Promise.race([probe(), new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 3000); })]);
  } catch { /* inaccessible Git state remains unknown */ }
  finally { if (timer) clearTimeout(timer); }
  assertSessionTargetCurrent(ctx.config.get(), target);
  return { isolate: dirty === true, dirty, repo, resolved, target };
}
