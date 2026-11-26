import { createHash } from 'node:crypto';
import path from 'node:path';
import { createControlledChild } from '../../process/controlledChild';
import { boundedAcpRequest } from '../../processReclamation';
import { NdjsonRpc, NdjsonRpcResponseError } from '../acp/jsonRpc';
import type { NativeApprovalChoice, NativeConfigChoice, NativeConfigOption, NativeConfigState, NativeConfigValue } from '../../../../shared/nativeSessionConfig';
import { nativeOptionAccepts } from '../../../../shared/nativeSessionConfig';
import { WORKER_CODEX_PERMISSION_PROFILES } from '../../../../shared/workerRouting';

type Obj = Record<string, unknown>;
const object = (value: unknown): Obj => value && typeof value === 'object' && !Array.isArray(value) ? value as Obj : {};
const text = (value: unknown): string | undefined => typeof value === 'string' && value.length <= 1024 ? value : undefined;

export type CodexConfigRequest = (method: string, params: Obj) => Promise<unknown>;
export type CodexConfigCatalog = { profiles: NativeConfigChoice[]; collaboration: NativeConfigChoice[]; requirements: Obj };
type Selection = { id: string; value: NativeConfigValue };

export async function readCodexConfigCatalog(request: CodexConfigRequest, cwd: string): Promise<CodexConfigCatalog> {
  const profiles: NativeConfigChoice[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 16; page++) {
    const result = object(await request('permissionProfile/list', { cwd, limit: 100, ...(cursor ? { cursor } : {}) }));
    if (!Array.isArray(result.data)) throw new Error('Codex returned an invalid permission profile directory.');
    for (const value of result.data) {
      const row = object(value);
      const id = text(row.id);
      if (id && typeof row.allowed === 'boolean' && !profiles.some(profile => profile.value === id)) {
        profiles.push({ value: id, name: id, description: text(row.description), disabled: !row.allowed });
      }
    }
    cursor = text(result.nextCursor);
    if (!cursor) break;
    if (cursors.has(cursor) || page === 15) throw new Error('Codex permission profile pagination failed.');
    cursors.add(cursor);
  }
  const modeResult = object(await request('collaborationMode/list', {}));
  const collaboration = (Array.isArray(modeResult.data) ? modeResult.data.slice(0, 128) : []).flatMap(value => {
    const row = object(value);
    const mode = text(row.mode);
    return mode ? [{ value: mode, name: text(row.name) ?? mode }] : [];
  });
  const requirements = object(object(await request('configRequirements/read', {})).requirements);
  return { profiles, collaboration, requirements };
}

function observed(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') return JSON.stringify(value);
  return undefined;
}

export function codexNativeConfig(catalog: CodexConfigCatalog, settings?: Obj): NativeConfigState {
  const choices = (known: string[], allowed: unknown) => known
    .filter(value => !Array.isArray(allowed) || allowed.includes(value)).map(value => ({ value, name: value }));
  const options: NativeConfigOption[] = [{
    id: 'permissions', name: 'Permission Profile', category: 'permissions', type: 'select',
    choices: catalog.profiles, changePolicy: 'idle', currentValue: text(object(settings?.activePermissionProfile).id)
  }, {
    id: 'approvalPolicy', name: 'Approval Policy', category: 'permissions', type: 'select',
    choices: choices(['untrusted', 'on-request', 'never'], catalog.requirements.allowedApprovalPolicies),
    changePolicy: 'idle', currentValue: observed(settings?.approvalPolicy)
  }, {
    id: 'approvalsReviewer', name: 'Approvals Reviewer', category: 'permissions', type: 'select',
    choices: choices(['user', 'auto_review'], catalog.requirements.allowedApprovalsReviewers),
    changePolicy: 'idle', currentValue: text(settings?.approvalsReviewer)
  }, {
    id: 'collaborationMode', name: 'Collaboration Mode', category: 'mode', type: 'select',
    choices: catalog.collaboration, changePolicy: 'idle', currentValue: text(object(settings?.collaborationMode).mode)
  }];
  const sandbox = settings?.sandboxPolicy ?? settings?.sandbox;
  if (sandbox) options.push({ id: 'sandboxPolicy', name: 'Sandbox Policy', type: 'select',
    category: 'permissions', currentValue: observed(sandbox), changePolicy: 'read-only' });
  return { status: 'ready', options };
}

export function codexNativeStartOverrides(catalog: CodexConfigCatalog, selections: readonly Selection[]): Obj {
  const state = codexNativeConfig(catalog);
  const overrides: Obj = {};
  for (const { id, value } of selections) {
    const option = state.options.find(option => option.id === id);
    if (!option || !nativeOptionAccepts(option, value) || option.changePolicy === 'read-only') {
      throw new Error('Codex did not advertise the selected native setting.');
    }
    if (id !== 'collaborationMode') overrides[id] = value;
  }
  return overrides;
}

export async function queryCodexNativeConfig(executable: string, cwd: string, env: NodeJS.ProcessEnv,
  verify: (init: unknown) => void): Promise<CodexConfigCatalog> {
  return withCodexConfigRequest(executable, cwd, env, verify, request => readCodexConfigCatalog(request, cwd));
}

const workerPermissionIds = ['permissions', 'approvalPolicy', 'approvalsReviewer'] as const;

/** Only built-in profiles can be compared through the native sandbox response. */
export function codexWorkerPermissionSnapshot(settings: Obj, cwd: string, selections: readonly Selection[]): string {
  const values = new Map(selections.map(({ id, value }) => [id, value]));
  const profile = values.get('permissions');
  const policy = values.get('approvalPolicy');
  const reviewer = values.get('approvalsReviewer');
  const expectedSandbox = profile === ':read-only' ? 'readOnly' : profile === ':workspace' ? 'workspaceWrite' : 'dangerFullAccess';
  const effective = object(settings.sandboxPolicy ?? settings.sandbox);
  const actualProfile = object(settings.activePermissionProfile);
  const directoryKey = (value: string) => process.platform === 'win32' ? path.normalize(value).toLowerCase() : path.normalize(value);
  const sameDirectory = (value: unknown) => typeof value === 'string' && path.isAbsolute(value) && directoryKey(value) === directoryKey(cwd);
  const knownSandboxFields = new Set(expectedSandbox === 'workspaceWrite' ? ['type', 'networkAccess', 'excludeSlashTmp', 'excludeTmpdirEnvVar', 'writableRoots']
    : expectedSandbox === 'readOnly' ? ['type', 'networkAccess'] : ['type']);
  const roots = effective.writableRoots ?? [];
  if (selections.length !== workerPermissionIds.length || workerPermissionIds.some(id => typeof values.get(id) !== 'string') ||
      !WORKER_CODEX_PERMISSION_PROFILES.some(item => item === profile) || actualProfile.id !== profile || actualProfile.extends !== null ||
      settings.approvalPolicy !== policy || settings.approvalsReviewer !== reviewer || !sameDirectory(settings.cwd) ||
      !Array.isArray(settings.runtimeWorkspaceRoots) || settings.runtimeWorkspaceRoots.length !== 1 || !settings.runtimeWorkspaceRoots.every(sameDirectory) ||
      effective.type !== expectedSandbox || Object.keys(effective).some(key => !knownSandboxFields.has(key)) ||
      ['networkAccess', 'excludeSlashTmp', 'excludeTmpdirEnvVar'].some(key => effective[key] !== undefined && typeof effective[key] !== 'boolean') ||
      !Array.isArray(roots) || !roots.every(sameDirectory)) {
    throw new Error('Codex did not confirm the selected Worker permissions for this directory. Choose a built-in profile and check the effective policy.');
  }
  return createHash('sha256').update(JSON.stringify([profile, policy, reviewer, expectedSandbox,
    effective.networkAccess ?? false, effective.excludeSlashTmp ?? false, effective.excludeTmpdirEnvVar ?? false, roots.length > 0])).digest('hex');
}

export async function queryCodexWorkerPermission(executable: string, cwd: string, env: NodeJS.ProcessEnv,
  verify: (init: unknown) => void, selections: readonly Selection[]): Promise<string> {
  return withCodexConfigRequest(executable, cwd, env, verify, async request => {
    const catalog = await readCodexConfigCatalog(request, cwd);
    const overrides = codexNativeStartOverrides(catalog, selections);
    const response = object(await request('thread/start', { cwd, ephemeral: true, ...overrides }));
    if (object(response.thread).ephemeral !== true) throw new Error('Codex did not create an ephemeral permission preview.');
    return codexWorkerPermissionSnapshot(response, cwd, selections);
  });
}

async function withCodexConfigRequest<T>(executable: string, cwd: string, env: NodeJS.ProcessEnv,
  verify: (init: unknown) => void, inspect: (request: CodexConfigRequest) => Promise<T>): Promise<T> {
  const owner = createControlledChild(executable, ['app-server'], { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const child = owner.child;
  const rpc = new NdjsonRpc(child.stdin, child.stdout, { omitJsonRpcVersion: true });
  child.stderr.resume();
  child.on('error', error => rpc.failExternal(error));
  rpc.on('message', message => { if (message.id != null) rpc.respondError(message.id, 'Config discovery does not handle requests.', -32601); });
  const request: CodexConfigRequest = (method, params) => boundedAcpRequest(rpc.request(method, params), 8000, `Codex ${method}`);
  try {
    await boundedAcpRequest(owner.ready, 8000, 'Codex 原生设置进程启动');
    verify(await request('initialize', { clientInfo: { name: 'muster_native_config', version: '1' }, capabilities: { experimentalApi: true } }));
    rpc.notify('initialized');
    return await inspect(async (method, params) => {
      try { return await request(method, params); }
      catch (error) {
        if (method !== 'configRequirements/read' || !(error instanceof NdjsonRpcResponseError) || error.code !== -32601) throw error;
        return {};
      }
    });
  } finally {
    rpc.close();
    await owner.reclaim();
  }
}

export function codexNativeApproval(method: string, params: Obj): Array<{ view: NativeApprovalChoice; result: Obj }> {
  if (method === 'item/permissions/requestApproval') {
    const permissions = object(params.permissions);
    const denied = { view: { id: 'decline', name: 'Deny', kind: 'reject_once' }, result: { permissions: {}, scope: 'turn' } };
    if (!Object.keys(permissions).length) return [denied];
    return [
      { view: { id: 'turn', name: 'Allow for this turn', kind: 'allow_once', scope: 'once' }, result: { permissions, scope: 'turn' } },
      { view: { id: 'session', name: 'Allow for this session', kind: 'allow_session', scope: 'session' }, result: { permissions, scope: 'session' } },
      denied
    ];
  }
  const decisions = Array.isArray(params.availableDecisions) ? params.availableDecisions.slice(0, 24)
    : ['accept', 'acceptForSession', 'decline', 'cancel'];
  return decisions.flatMap((decision, index) => {
    const id = typeof decision === 'string' ? decision : `amendment-${index}`;
    let view: NativeApprovalChoice | undefined;
    if (decision === 'accept') view = { id, name: 'Allow once', kind: 'allow_once', scope: 'once' };
    if (decision === 'acceptForSession') view = { id, name: 'Allow for this session', kind: 'allow_session', scope: 'session' };
    if (decision === 'decline') view = { id, name: 'Deny', kind: 'reject_once', scope: 'once' };
    if (decision === 'cancel') view = { id, name: 'Deny and interrupt', kind: 'reject_once', scope: 'once' };
    const entry = object(decision);
    if (entry.acceptWithExecpolicyAmendment) view = { id, name: 'Allow and update the command rule', kind: 'allow_always',
      scope: 'persistent', description: JSON.stringify(entry.acceptWithExecpolicyAmendment) };
    if (entry.applyNetworkPolicyAmendment) {
      const amendment = object(object(entry.applyNetworkPolicyAmendment).network_policy_amendment);
      const action = text(amendment.action);
      if (action === 'allow' || action === 'deny') view = { id, name: action === 'allow' ? 'Always allow network access' : 'Always deny network access',
        kind: action === 'allow' ? 'allow_always' : 'reject_always', scope: 'persistent', description: text(amendment.host) };
    }
    return view ? [{ view, result: { decision } }] : [];
  });
}
