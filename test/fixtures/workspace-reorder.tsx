import { fixture } from '../../.agents/skills/ui-verification/assets/fixture-api';
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/renderer/src/i18n';
import { StoreProvider } from '../../src/renderer/src/store';
import { AgentFloat } from '../../src/renderer/src/panels/AgentFloat';
import { LeftPanel } from '../../src/renderer/src/panels/LeftPanel';
import { KeybindingProvider } from '../../src/renderer/src/keybindings/KeybindingHost';
import { PanelHistoryProvider } from '../../src/renderer/src/panelHistory';
import { applyTheme } from '../../src/renderer/src/theme';
import { builtinTheme } from '../../src/shared/theme';
import type { SessionMeta } from '../../src/shared/types';

applyTheme(builtinTheme(new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark')!);
const avatars = ['builtin-workspace:development', 'builtin-workspace:gamepad', 'builtin-workspace:design', '🔬'];
const workspaces = ['Muster Console', '游戏玩法实验室', '文档与设计', '长期项目与工具研究'].map((name, i) => ({
  id: `ws-${i}`, name, path: `/fixture/${i}`, avatar: avatars[i], openedAt: i
}));
const sessions: SessionMeta[] = ['测试', '准备工作区发布说明'].map((name, i) => ({
  id: `session-${i}`, name, type: 'terminal', launchKind: 'agent', runtime: 'pi', workspaceId: 'ws-2',
  status: 'running', lifecycle: 'idle', createdAt: Date.now() - (i + 1) * 3600_000
}));
const defaults: Record<string, unknown> = {
  'workspaces.list': { workspaces, activeWorkspaceId: 'ws-2' },
  'config.get': { workspaces, activeWorkspaceId: 'ws-2', locale: 'zh-CN' },
  'sessions.list': { sessions, activeId: sessions[0].id },
  'agentTasks.listAll': { byWorkspace: {} },
  'workbench.navigation': { workspaceId: 'ws-2', sourceRootId: '', selectionRevision: 0, revision: 1, nodes: [], libraryExpanded: true },
  'chat.history': [], 'chat.state': { busy: false }, 'chat.getMode': null,
  'workspaceFile.get': { workspaceId: 'ws-2', config: {} }
};
const original = window.api;
function api(route = '', parent: any = original): any {
  return new Proxy(() => {}, {
    get: (_, key) => key === 'then' ? undefined : api(route ? `${route}.${String(key)}` : String(key), parent[key]),
    apply: (_, __, args) => {
      if (route === 'workspaces.switch') {
        fixture.calls.push({ path: route, args });
        return Promise.resolve({ ok: true, workspaces, activeWorkspaceId: args[0] });
      }
      if (!Object.hasOwn(defaults, route)) return parent(...args);
      fixture.calls.push({ path: route, args });
      return Promise.resolve(structuredClone(defaults[route]));
    }
  });
}
window.api = api();
localStorage.setItem('muster.sidebarCollapsed.v1:ws-2:workspaces', '0');
function App() {
  const [slot, setSlot] = React.useState<HTMLDivElement | null>(null);
  const inline = new URLSearchParams(location.search).has('inline');
  return <StoreProvider><PanelHistoryProvider><KeybindingProvider>
    <main className="app-shell" style={{ padding: 24, color: 'var(--fg-primary)' }}>
      <p>工作区 · 长按拖动排序</p>
      <p style={{ color: 'var(--fg-muted)' }}>真实工作区组件 / 模拟 IPC</p>
      <div className="terminal-page" aria-hidden="true" style={{ position: 'absolute', inset: `84px 12px 24px ${innerWidth < 500 ? 238 : 298}px` }}>
        <div className="center-panel" />
      </div>
      {!inline && <div className="sessions-column" style={{ position: 'absolute', top: 84, left: 12, bottom: 24, width: innerWidth < 500 ? 220 : 280, height: 'auto' }}>
        <LeftPanel utilityPanel={null} onSelectUtilityPanel={() => {}} onCloseUtilityPanel={() => {}} wsSlotRef={setSlot} />
      </div>}
      <AgentFloat wsStackSlot={slot} stackInline={inline} />
    </main>
  </KeybindingProvider></PanelHistoryProvider></StoreProvider>;
}
createRoot(document.getElementById('root')!).render(<App />);
