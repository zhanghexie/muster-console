import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { AppContext } from '../context';
import type { SessionTarget } from '../sessions/targets';
import type { WorkerRouteReason, WorkerRoutingChanged, WorkerTargetConfig } from '../../shared/workerRouting';
import { RuntimePreflightError } from '../../shared/runtimePreflight';

export type WorkerRuntimeFailure = { reason: WorkerRouteReason; retryAfterMs?: number; scope?: 'account' };

const nativeCodes = new Map<string, WorkerRouteReason>([
  ['insufficient_quota', 'quota'], ['quota_exceeded', 'quota'], ['credits_exhausted', 'quota'],
  ['billing_hard_limit_reached', 'quota'], ['billing_not_active', 'quota'], ['usage_limit_reached', 'quota'],
  ['usage_limit_exceeded', 'quota'],
  ['rate_limit_exceeded', 'rate-limit'], ['rate_limit_error', 'rate-limit'], ['rate_limited', 'rate-limit'],
  ['authentication_error', 'authentication'], ['invalid_api_key', 'authentication'], ['invalid_authentication', 'authentication'],
  ['engine_unavailable', 'engine-unavailable'], ['model_not_available', 'engine-unavailable'], ['service_unavailable', 'temporary-service'],
  ['overloaded_error', 'temporary-service'], ['server_overloaded', 'temporary-service']
]);

/** Only structured adapter/server fields can identify a failure class. Never inspect prose, tool output, or HTTP 429 alone for quota. */
export function classifyWorkerRuntimeFailure(error: unknown): WorkerRuntimeFailure | undefined {
  if (error instanceof RuntimePreflightError && ['not_installed', 'not_configured', 'script_missing', 'disabled'].includes(error.preflight.status)) {
    return { reason: 'engine-unavailable' };
  }
  const seen = new Set<unknown>();
  const chain = [error];
  let generic: WorkerRuntimeFailure | undefined;
  let inheritedDelay: number | undefined;
  for (let index = 0; index < chain.length && index < 12; index++) {
    const item = chain[index];
    if (!item || typeof item !== 'object' || seen.has(item)) continue;
    seen.add(item);
    const value = item as Record<string, unknown>;
    const status = value.statusCode ?? value.status ?? value.httpStatusCode;
    const codex = value.codexErrorInfo;
    const code = typeof value.code === 'string' ? value.code : value.type ?? (typeof codex === 'string' ? codex : undefined);
    const normalizedCode = typeof code === 'string' ? code.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[- ]/g, '_').toLowerCase() : '';
    const reason = nativeCodes.get(normalizedCode);
    const delay = value.retryAfterMs;
    if (typeof delay === 'number' && Number.isFinite(delay)) inheritedDelay ??= Math.max(0, Math.min(900_000, delay));
    const retryAfterMs = inheritedDelay;
    if (reason) return { reason, retryAfterMs, ...(value.scope === 'account' || normalizedCode === 'invalid_api_key' ? { scope: 'account' as const } : {}) };
    if (status === 429) generic ??= { reason: 'rate-limit', retryAfterMs };
    if (status === 503) generic ??= { reason: 'temporary-service', retryAfterMs };
    if (status === 401) generic ??= { reason: 'authentication' };
    for (const child of [value.error, value.data, value.cause, value.codexErrorInfo]) if (child && typeof child === 'object') chain.push(child);
  }
  return generic;
}

const WAIT_MS: Partial<Record<WorkerRouteReason, number>> = {
  quota: 15 * 60_000, 'rate-limit': 30_000, 'engine-unavailable': 60_000, authentication: 60_000, 'temporary-service': 5_000
};
type Cooldown = { until: number; retryAt: number; reason: WorkerRouteReason };
const stores = new WeakMap<AppContext, Map<string, Cooldown>>();

function keys(ctx: AppContext, target: SessionTarget, config: WorkerTargetConfig): { candidate: string; account?: string } {
  const candidate = JSON.stringify([target.workspaceId, target.sourceKey, target.sourceRoot.cwd, config]);
  // For native CLI/ACP the host has no trustworthy account identifier. For Core
  // credential+endpoint equality proves aliases share the same configured account.
  const provider = config.runtimeId === 'pi' && config.model && ctx.config.get().llm?.providers.find(p => p.id === config.model!.providerId);
  return { candidate, ...(provider && provider.apiKey ? { account: `core:${createHash('sha256').update(JSON.stringify([provider.baseUrl, provider.apiKey])).digest('hex')}` } : {}) };
}

export function cooldownFor(ctx: AppContext, target: SessionTarget, config: WorkerTargetConfig, now = performance.now()): { retryAt: number; reason: WorkerRouteReason } | undefined {
  const store = stores.get(ctx);
  if (!store) return;
  const identity = keys(ctx, target, config);
  const candidates = [identity.candidate, identity.account].flatMap(key => {
    const cooldown = key ? store.get(key) : undefined;
    if (key && cooldown && cooldown.until <= now) store.delete(key);
    return cooldown && cooldown.until > now ? [cooldown] : [];
  });
  const latest = candidates.sort((a, b) => b.until - a.until)[0];
  return latest && { retryAt: latest.retryAt, reason: latest.reason };
}

export function publishWorkerRoutingChanged(ctx: AppContext, event: WorkerRoutingChanged): void {
  try { ctx.getWindow()?.webContents.send('workerRouting:changed', event); }
  catch (error) { console.warn('[worker-routing] settings notification failed:', error); }
}

export function recordWorkerCooldown(ctx: AppContext, target: SessionTarget, config: WorkerTargetConfig, failure: WorkerRuntimeFailure,
  now = performance.now(), wall = Date.now()): void {
  const defaultMs = WAIT_MS[failure.reason];
  if (!defaultMs) return;
  const delay = Math.max(defaultMs, failure.retryAfterMs ?? 0);
  let store = stores.get(ctx);
  if (!store) stores.set(ctx, store = new Map());
  for (const [key, value] of store) if (value.until <= now) store.delete(key);
  const identity = keys(ctx, target, config);
  const account = failure.scope === 'account' && identity.account;
  const key = account || identity.candidate;
  if ((store.get(key)?.until ?? 0) < now + delay) store.set(key, { until: now + delay, retryAt: wall + delay, reason: failure.reason });
  publishWorkerRoutingChanged(ctx, account ? { kind: 'cooldown' } : { kind: 'cooldown', workspaceId: target.workspaceId });
}

export function resetWorkerCooldown(ctx: AppContext, target: SessionTarget, config: WorkerTargetConfig): void {
  const store = stores.get(ctx);
  const identity = keys(ctx, target, config);
  store?.delete(identity.candidate);
  const account = identity.account && store?.delete(identity.account);
  publishWorkerRoutingChanged(ctx, account ? { kind: 'cooldown' } : { kind: 'cooldown', workspaceId: target.workspaceId });
}
