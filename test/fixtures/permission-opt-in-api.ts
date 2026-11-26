import type { AgentRuntimeEntry, WorkspaceInfo } from '../../src/shared/types';

export const runtimes = [{ id: 'acp', label: 'ACP', enabled: true, builtin: true, surface: 'chat' }] as AgentRuntimeEntry[];
export const workspace = { id: 'permissions-fixture', name: '示例工作区', path: 'E:/Fixture', controlRoot: 'E:/Fixture', openedAt: 0,
  roots: [{ id: 'root', path: 'E:/Fixture' }], defaultRootId: 'root', rootsRevision: 1 } as WorkspaceInfo;
export const fixture = { calls: [] as string[], unmocked: [] as string[], starts: [] as unknown[] };
const defaults: Record<string, unknown> = {
  'app.setChromeTheme': undefined,
  'sessions.list': { sessions: [], activeId: null },
  'workspaces.list': { workspaces: [workspace], activeWorkspaceId: workspace.id },
  'runtimes.list': runtimes,
  'config.get': { locale: 'zh-CN', defaultRuntime: 'acp', workspaces: [workspace] },
  'runtimes.availability': { runtimes, acpAgents: [{ id: 'codebuddy-cli', name: 'CodeBuddy Code' }], checkedAt: 1 },
  'sessions.precheck': { isolate: false, dirty: false },
  'git.listRepoLocations': { workspaceId: workspace.id, rootsRevision: 1, repos: [], issues: [], issueCount: 0 },
  'agentSession.getHarnessModelSelections': {},
  'agentSession.listHarnessPickerChoices': { checkedAt: 1, choices: [{ harnessId: 'codebuddy-cli', runtimeId: 'acp', acpPresetId: 'codebuddy-cli',
    label: 'CodeBuddy Code', surface: 'gui', available: true, status: 'available' }] },
  'agentSession.listAcpModels': { ok: true, items: [{ id: 'engine-model', name: 'Engine Model' }] },
  'agentSession.describeModelParameters': { runtimeId: 'acp', providerId: 'acp:codebuddy-cli', modelId: '', parameters: [] },
  'agentSession.cancelHarnessModels': { ok: true },
  'agentSession.describeNativeConfig': { identity: { runtimeId: 'acp', presetId: 'codebuddy-cli', sourceKey: 'fixture' }, revision: 1,
    status: 'ready', source: 'catalog', options: [
      { id: 'permissionMode', name: 'Permission Mode', type: 'select', category: 'permissions', changePolicy: 'live', choices: [
        { value: 'default', name: 'Always Ask' }, { value: 'acceptEdits', name: 'Accept Edits' }, { value: 'bypassPermissions', name: 'Bypass Permissions' }] },
      { id: 'sandbox', name: 'Sandbox', type: 'select', changePolicy: 'live', choices: [{ value: 'local', name: 'Local Environment' }] },
      { id: 'multitask', name: 'Multitask', type: 'boolean', changePolicy: 'live' }
    ] }
};
function api(route = ''): any {
  return new Proxy(() => {}, {
    get: (_, key) => key === 'then' ? undefined : api(route ? `${route}.${String(key)}` : String(key)),
    apply: () => {
      if (route === 'on') return () => {};
      fixture.calls.push(route);
      if (!Object.hasOwn(defaults, route)) fixture.unmocked.push(route);
      return Promise.resolve(structuredClone(defaults[route]));
    }
  });
}
Object.assign(window, { api: api(), __uiFixture: fixture });
