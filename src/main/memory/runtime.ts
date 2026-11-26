/** Independent reminder lifecycle. Knowledge learning is handled only by explicit curator candidates. */
import type {AppContext} from '../context';
import {controlRootFor} from '../../shared/workspaceRoots';
import {pathKey} from '../pathKey';
import {getMemoryService} from './serviceRef';
export {getMemoryService,setMemoryService} from './serviceRef';
export {getUserProfileFilePath,setUserProfileFilePath} from './userProfile';
import {formatIntentEventNotice,runIntentEventScan,type IntentEventInput} from './intents';
import {setMemoryIntentListener,type MemoryIntentEvent} from './intentEvents';
/** 记忆库根：显式传入优先 → workspaceId 查配置 → 活跃工作区（无则 null） */
export function resolveMemoryWorkspaceRoot(
  ctx: AppContext,
  workspaceId?: string,
  explicit?: string
): string | null {
  if (explicit?.trim()) return explicit.trim();
  try {
    const cfg = ctx.config.get();
    const id = workspaceId === undefined ? cfg.activeWorkspaceId : workspaceId.trim();
    const meta = cfg.workspaces.find((w) => w.id === id);
    return meta && !meta.rootsError ? controlRootFor(meta) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 意图事件面消费（memory-refactor §9，B7）：事件缝（intentEvents）→ 工作区库扫描
// → 命中发系统通知（事件面没有「对应回合」可注入——通知即注入形态；点击直达
// 记忆中心意图页签，决策 #9 同款不占 needs_you）。内部全兜底。
// ---------------------------------------------------------------------------

let intentListenerBound = false;

/** boot 装配（index.ts 事件段调用；幂等）：注册意图事件缝消费者 */
export function bindMemoryIntentEvents(ctx: AppContext): void {
  if (intentListenerBound) return;
  intentListenerBound = true;
  setMemoryIntentListener((e) => {
    const router = ctx.eventRouter;
    if (!router) return handleMemoryIntentEvent(ctx, e);
    const workspaceId = e.workspaceId || ctx.workspaces.list().find(w => e.root && pathKey(controlRootFor(w)) === pathKey(e.root))?.id;
    if (!workspaceId) throw new Error('Intent event workspace unavailable');
    const subject = `system:intent:${workspaceId}`;
    if (!router.log.subscriptions(subject).some(s => s.source === 'intent')) router.log.subscribe({ subject, workspaceId,
      source: 'intent', types: [], scope: '', mode: 'instant', createdAt: Date.now(), expiresAt: null });
    router.publish({ source: 'intent', type: e.kind, scope: e.sessionId ?? '', workspaceId,
      receivedAt: Date.now(), summary: e.kind, payload: JSON.stringify(e) });
  });
}

export function handleMemoryIntentEvent(ctx: AppContext, e: MemoryIntentEvent): void {
  try {
    const svc = getMemoryService();
    if (!svc) throw new Error('Memory service unavailable');
    const root = e.root || resolveMemoryWorkspaceRoot(ctx, e.workspaceId);
    if (!root) throw new Error('Intent workspace unavailable');
    const db = svc.init(root);
    const evt: IntentEventInput = {
      kind: e.kind,
      trigger: e.trigger,
      branch: e.branch,
      repo: e.repo
    };
    const r = runIntentEventScan(db, evt);
    if (r.hits.length === 0) return;
    const workspaceId = ((): string | undefined => {
      if (e.workspaceId) return e.workspaceId;
      try {
        const cfg = ctx.config.get();
        const norm = pathKey(root);
        return cfg.workspaces.find((w) => !w.rootsError && pathKey(controlRootFor(w)) === norm)?.id;
      } catch {
        return undefined;
      }
    })();
    for (const hit of r.hits) {
      try {
        ctx.ui.notify('前瞻意图触发', formatIntentEventNotice(hit), {
          ...(workspaceId ? { workspaceId } : {}),
          openPanel: { panel: 'memory', tab: 'intent' }
        });
      } catch (error) {
        throw error;
      }
    }
  } catch (err) {
    console.warn('[memory-intents] 事件处理失败', err);
    throw err;
  }
}
