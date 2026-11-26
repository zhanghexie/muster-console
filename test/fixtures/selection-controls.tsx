import React from 'react';
import { createRoot } from 'react-dom/client';
const workspace = { id: 'stack-fixture', name: '演示', path: 'E:/fixture', roots: [] };
let sessions = ['a', 'b', 'c', 'shell-a', 'shell-b'].map((id, i) => ({ id, type: 'terminal', workspaceId: workspace.id,
  name: ['会话甲', '当前会话乙', '会话丙', '终端甲', '终端乙'][i], launchKind: id.startsWith('shell') ? 'shell' : 'agent',
  runtime: id.startsWith('shell') ? undefined : 'pi', status: 'idle', lifecycle: 'idle', createdAt: i + 1, lastUsedAt: i + 1 }));
const nodes = [{ id: 'favorite', kind: 'extension', title: '示例工具', parentId: null, extensionId: 'demo', viewId: 'main', favorite: true }];
let activeId = 'b';
const archiveCalls: unknown[][] = [];
(window as any).__sidebarArchiveCalls = archiveCalls;
const listeners = new Map<string, Set<(data: any) => void>>();
const defaults: Record<string, unknown> = {
  'workspaces.list': { workspaces: [workspace], activeWorkspaceId: workspace.id },
  'config.get': { workspaces: [workspace], activeWorkspaceId: workspace.id, locale: 'zh-CN' },
  'runtimes.list': [], 'agentTasks.listAll': { byWorkspace: {} }, 'notify.list': [], 'agent.listSkills': [],
  'workspaceFile.get': { workspaceId: workspace.id, config: {} },
  'workbench.navigation': { workspaceId: workspace.id, sourceRootId: '', selectionRevision: 0, revision: 1, nodes, libraryExpanded: true },
  'shellProfiles.list': [], 'chat.state': { busy: false }
};
function api(route = ''): any {
  return new Proxy(() => {}, {
    get: (_, key) => key === 'then' ? undefined : api(route ? `${route}.${String(key)}` : String(key)),
    apply: (_, __, args) => {
      if (route === 'on') {
        const [channel, callback] = args;
        const callbacks = listeners.get(channel) ?? new Set(); callbacks.add(callback); listeners.set(channel, callbacks);
        return () => callbacks.delete(callback);
      }
      if (route === 'sessions.list') return Promise.resolve({ sessions, activeId });
      if (route === 'sessions.select') {
        activeId = args[0]; listeners.get('sessions:changed')?.forEach(fn => fn({ sessions, activeId }));
        return Promise.resolve({ sessions, activeId });
      }
      if (route === 'sessions.setArchived') {
        archiveCalls.push(args);
        sessions = sessions.map(item => item.id === args[0] ? { ...item, archived: args[1] } : item);
        listeners.get('sessions:changed')?.forEach(fn => fn({ sessions: [...sessions], activeId }));
        return Promise.resolve({ sessions: [...sessions], activeId });
      }
      return Promise.resolve(structuredClone(defaults[route]));
    }
  });
}
(window as any).api = api();
(window as any).__uiFixture = { unmocked: [] };
async function mount() {
  await import('../../src/renderer/src/i18n');
  const { StoreProvider } = await import('../../src/renderer/src/store');
  const { PanelHistoryProvider } = await import('../../src/renderer/src/panelHistory');
  const { KeybindingProvider } = await import('../../src/renderer/src/keybindings/KeybindingHost');
  const { LeftPanel } = await import('../../src/renderer/src/panels/LeftPanel');
  const { AgentFloat } = await import('../../src/renderer/src/panels/AgentFloat');
  const { builtinTheme } = await import('../../src/shared/theme');
  const { applyTheme } = await import('../../src/renderer/src/theme');
  applyTheme(builtinTheme(new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark')!);
  function Fixture() {
    const [utility, setUtility] = React.useState<any>(null);
    const [slot, setSlot] = React.useState<HTMLElement | null>(null);
    React.useEffect(() => { setSlot(document.querySelector('.left-ws-slot')); }, []);
    return <StoreProvider><PanelHistoryProvider><KeybindingProvider>
      <div style={{ width: 'min(280px, 100vw)', height: 680, background: 'var(--surface-frame)' }}>
        <LeftPanel utilityPanel={utility} onSelectUtilityPanel={setUtility} onCloseUtilityPanel={() => setUtility(null)} />
        {slot && <AgentFloat wsStackSlot={slot} />}
        <p data-test-content>这是一段应当能够复制的正文内容</p>
        <button data-test-control><span>普通操作按钮</span></button>
        <div role="tab" data-test-tab>切换标签</div>
        <div role="menuitem" data-test-menuitem>菜单操作</div>
        <div role="menuitemcheckbox" data-test-check>菜单勾选</div>
      </div>
    </KeybindingProvider></PanelHistoryProvider></StoreProvider>;
  }
  createRoot(document.getElementById('root')!).render(<Fixture />);
}
void mount();
