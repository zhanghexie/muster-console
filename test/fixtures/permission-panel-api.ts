// Visual fixture: IPC responses are simulated, production components and CSS are used unchanged.
export const fixture = { calls: [] as { path: string; args: unknown[] }[], unmocked: [] as string[], reject: false };
const snapshot = { identity: { runtimeId: 'acp', sourceKey: 'fixture' }, revision: 1, status: 'ready', source: 'session', options: [
  { id: 'mode', name: 'Permission Mode', type: 'select', currentValue: 'default', changePolicy: 'live', choices: [
    { value: 'default', name: 'Always Ask' }, { value: 'acceptEdits', name: 'Accept Edits' }] },
  { id: 'sandbox', name: 'Sandbox', type: 'select', currentValue: 'local', changePolicy: 'idle', choices: [{ value: 'local', name: 'Local Environment' }] },
  { id: 'multitask', name: 'Multitask', type: 'boolean', currentValue: true, changePolicy: 'live' }
] };
const defaults: Record<string, unknown> = {
  'workspaces.list': { workspaces: [], activeWorkspaceId: null }, 'config.get': { workspaces: [], activeWorkspaceId: null, locale: 'zh-CN' },
  'sessions.list': { sessions: [], activeId: null }, 'runtimes.list': [], 'notify.list': [], 'notify.capability': true,
  'app.setChromeTheme': undefined, 'agent.listSkills': [], 'agentSession.getHarnessModelSelections': {},
  'agentSession.getNativeConfig': snapshot, 'agentSession.refreshNativeConfig': snapshot,
  'agentSession.setNativeConfig': { ok: true, snapshot }, 'sessionReminders.list': { scope: null, items: [] }
};
function api(route = ''): any {
  return new Proxy(() => {}, {
    get: (_, key) => key === 'then' ? undefined : api(route ? `${route}.${String(key)}` : String(key)),
    apply: (_, __, args: unknown[]) => {
      if (route === 'on') return () => {};
      fixture.calls.push({ path: route, args });
      if (route === 'sessions.setConfigurePermissions') return Promise.resolve(fixture.reject
        ? { ok: false, error: '当前 Harness 正在运行，请等待回合结束后开启权限配置' } : { ok: true });
      if (!Object.hasOwn(defaults, route)) fixture.unmocked.push(route);
      return Promise.resolve(structuredClone(defaults[route]));
    }
  });
}
Object.assign(window, { api: api(), __uiFixture: fixture });
