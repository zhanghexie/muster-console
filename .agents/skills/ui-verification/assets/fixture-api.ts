/** Browser fixture only. No real preload, main process, network API, or app data. */
const defaults: Record<string, unknown> = {
  'workspaces.list': { workspaces: [], activeWorkspaceId: null },
  'config.get': { workspaces: [], activeWorkspaceId: null, locale: 'zh-CN' },
  'sessions.list': { sessions: [], activeId: null },
  'extensions.list': { workspaceId: 'ui-verification-fixture', entries: [] },
  'runtimes.list': [],
  'notify.list': [],
  'app.setChromeTheme': undefined,
  'agent.listSkills': []
};

const fixture = { sent: [] as string[], calls: [] as { path: string; args: unknown[] }[], unmocked: [] as string[] };
(window as any).__uiFixture = fixture;
const listeners = new Map<string, Set<(value: unknown) => void>>();

function api(route = ''): any {
  return new Proxy(() => {}, {
    get: (_, key) => key === 'then' ? undefined : api(route ? route + '.' + String(key) : String(key)),
    apply: (_, __, args: unknown[]) => {
      fixture.calls.push({ path: route, args });
      if (route === 'on') {
        const [channel, callback] = args as [string, (value: unknown) => void];
        const set = listeners.get(channel) ?? new Set(); listeners.set(channel, set); set.add(callback);
        return () => set.delete(callback);
      }
      if (!Object.hasOwn(defaults, route) && !fixture.unmocked.includes(route)) fixture.unmocked.push(route);
      const value = defaults[route];
      return Promise.resolve(value === undefined ? undefined : structuredClone(value));
    }
  });
}
(window as any).api = api();
export { fixture };
