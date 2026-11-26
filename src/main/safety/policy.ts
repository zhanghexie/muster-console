import { createHash } from 'node:crypto';
import type { SafetyOperation } from '../../shared/safety';
export const SAFETY_POLICY_VERSION = 'business-approval-v3';
/** Explicit business catalog. Engine permissions and dangerous metadata are independent. */
export function safetyRisk(op: SafetyOperation): 'routine' | 'high' {
  const action = op.action;
  if (action === 'browser.fileAssignment') return 'high';
  if (action === 'runtimes.update') return Object.keys(op.args).some(key => !['id', 'label', 'summary', 'confirmNote'].includes(key) && op.args[key] !== undefined) ? 'high' : 'routine';
  if (action === 'automations.update') return Object.keys(op.args).some(key => !['automationId', 'name'].includes(key) && op.args[key] !== undefined) ? 'high' : 'routine';
  if (/^(?:sessions\.(?:integrate|integrateWorktree|delete|deletePermanent|restartConversation)|workflow\.trust|extensions\.(?:trust|install|execute)|apps\.(?:install|update|enable|saveMailbox)|runtimes\.update|llm\.(?:upsertProvider|setDefault)|automations\.(?:create|update))$/.test(action)) return 'high';
  if (action === 'apps.setEnabled') return op.args.enabled === true ? 'high' : 'routine';
  if (action === 'extensions.run') return op.targetFingerprint ? 'high' : 'routine';
  return 'routine';
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
  return value;
}
export function operationFingerprint(op: SafetyOperation): string {
  return createHash('sha256').update(JSON.stringify(canonical({ workspaceId: op.workspaceId, actorId: op.actorId, action: op.action,
    args: op.args, source: op.source, dangerous: op.dangerous, permissionClass: op.permissionClass, targetFingerprint: op.targetFingerprint, policy: SAFETY_POLICY_VERSION }))).digest('hex');
}
