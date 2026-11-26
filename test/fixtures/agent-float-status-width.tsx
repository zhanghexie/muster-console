import '../../.agents/skills/ui-verification/assets/fixture-api';
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/renderer/src/i18n';
import { StoreProvider } from '../../src/renderer/src/store';
import { AgentFloat } from '../../src/renderer/src/panels/AgentFloat';
import { applyTheme } from '../../src/renderer/src/theme';
import { builtinTheme } from '../../src/shared/theme';

applyTheme(builtinTheme(new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark')!);
const workspace = { id: 'status-width', name: '夜间托管完整工作区名称', path: 'E:/fixture', openedAt: 1 };
const history = [{ id: 'status-reply', role: 'assistant', createdAt: Date.now(), content: '任务已完成。请确认下一步操作。' }];
const defaults: Record<string, unknown> = {
  'workspaces.list': { workspaces: [workspace], activeWorkspaceId: workspace.id },
  'config.get': { workspaces: [workspace], activeWorkspaceId: workspace.id, locale: 'zh-CN' },
  'sessions.list': { sessions: [], activeId: null, schedulerByWs: {
    [workspace.id]: { workspaceId: workspace.id, sessionId: `orchestrator:${workspace.id}`, phase: 'needs_you', note: '夜间托管完成，等待你确认下一步操作', ts: 1 }
  } },
  'chat.historyRange': { messages: history, before: 0, total: history.length, hasEarlier: false },
  'chat.state': { busy: false }, 'chat.getMode': null,
  'workspaceFile.get': { workspaceId: workspace.id, config: {} }
};
const original = window.api;
function api(route = '', parent: any = original): any {
  return new Proxy(() => {}, {
    get: (_, key) => key === 'then' ? undefined : api(route ? `${route}.${String(key)}` : String(key), parent[key]),
    apply: (_, __, args) => Object.hasOwn(defaults, route) ? Promise.resolve(structuredClone(defaults[route])) : parent(...args)
  });
}
window.api = api();
localStorage.setItem('muster.agentPanelSize', JSON.stringify({ w: 360, h: 340 }));
function App() {
  const [slot, setSlot] = React.useState<HTMLDivElement | null>(null);
  return <StoreProvider><div className="main-view" style={{ height: '100vh' }}><aside className="left-ws-slot" style={{ position: 'absolute', left: 12, bottom: 12, width: 180 }} ref={setSlot} />
    <AgentFloat wsStackSlot={slot} /></div></StoreProvider>;
}
createRoot(document.getElementById('root')!).render(<App />);
