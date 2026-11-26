/**
 * 调度角色默认订阅集：工作区首次出现时挂到 orchestrator:<wsId>。
 * 播种一次；events.unsubscribe 后退订不复活。Worker 不受影响。
 */
import type { FactSubscription } from '../../shared/runtimeFactsSubscribe';
import type { RuntimeAwarenessStore } from './store';

export function ensureSchedulerDefaultSubscriptions(
  store: RuntimeAwarenessStore,
  workspaceIds: readonly string[],
  now = Date.now()
): { workspaceId: string; added: FactSubscription[] }[] {
  const out: { workspaceId: string; added: FactSubscription[] }[] = [];
  for (const raw of workspaceIds) {
    const workspaceId = raw.trim();
    if (!workspaceId) continue;
    const { added } = store.ensureOrchestratorDefaults(workspaceId, now);
    out.push({ workspaceId, added });
  }
  return out;
}
