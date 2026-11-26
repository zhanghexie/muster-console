import type { NativeConfigChoice, NativeConfigState } from '../../../../shared/nativeSessionConfig';
import { NdjsonRpcResponseError } from '../acp/jsonRpc';

const modes = ['allowAll', 'promptUnmatched', 'onRequest', 'denyUnmatched'] as const;
type ApprovalMode = typeof modes[number];

export function isMuseApprovalMode(value: unknown): value is ApprovalMode {
  return modes.some(mode => mode === value);
}

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

export async function readMuseProfiles(request: (method: string, params: Record<string, unknown>) => Promise<unknown>, sessionId?: string): Promise<NativeConfigChoice[] | undefined> {
  let result: unknown;
  try { result = await request('permissionProfile/list', sessionId ? { sessionId } : {}); }
  catch (error) {
    if (error instanceof NdjsonRpcResponseError && error.code === -32601) return undefined;
    throw error;
  }
  const profiles = record(result).profiles;
  if (!Array.isArray(profiles)) return undefined;
  return profiles.slice(0, 128).flatMap(raw => {
    const row = record(raw);
    const value = row.profileId;
    if (typeof value !== 'string' || !value || value.length > 512 || typeof row.available !== 'boolean') return [];
    const description = [row.description, ...(Array.isArray(row.unavailableReasons) ? row.unavailableReasons : [])]
      .filter(item => typeof item === 'string').join('\n').slice(0, 4096);
    return [{ value, name: typeof row.label === 'string' ? row.label.slice(0, 512) : value,
      description: description || undefined, disabled: !row.available }];
  });
}

export function museNativeConfig(value?: unknown, limits?: unknown, profiles?: NativeConfigChoice[], permissionState?: unknown): NativeConfigState {
  const state: NativeConfigState = { status: 'ready', catalogSource: 'versioned-adapter', options: [{
    id: 'approvalMode', name: 'Approval Mode', category: 'permissions', type: 'select', changePolicy: 'live',
    currentValue: isMuseApprovalMode(value) ? value : undefined,
    choices: modes.map(value => ({ value, name: value }))
  }] };
  if (limits && typeof limits === 'object' && !Array.isArray(limits)) {
    state.options.push({ id: 'limits', name: 'Session Limits', type: 'select', changePolicy: 'read-only',
      currentValue: JSON.stringify(limits) });
  }
  const permission = record(permissionState);
  if (profiles) state.options.push({
    id: 'permissionProfile', name: 'Permission Profile', category: 'permissions', type: 'select', changePolicy: 'live',
    choices: profiles, currentValue: typeof permission.profileId === 'string' ? permission.profileId : undefined
  });
  if (typeof permission.reviewerAuthority === 'string') state.options.push({
    id: 'reviewerAuthority', name: 'Reviewer Authority', category: 'permissions', type: 'select', changePolicy: 'read-only',
    currentValue: permission.reviewerAuthority
  });
  const axes = record(permission.axes);
  for (const axis of ['filesystem', 'network']) {
    if (axes[axis] !== undefined) state.options.push({
      id: axis, name: axis === 'filesystem' ? 'Filesystem' : 'Network', category: 'permissions',
      type: 'select', changePolicy: 'read-only', currentValue: typeof axes[axis] === 'string' ? axes[axis] as string : JSON.stringify(axes[axis])
    });
  }
  return state;
}
