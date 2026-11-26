import '../../.agents/skills/ui-verification/assets/fixture-api';
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/renderer/src/i18n';
import { StoreProvider } from '../../src/renderer/src/store';
import { AgentFloat } from '../../src/renderer/src/panels/AgentFloat';
import { applyTheme } from '../../src/renderer/src/theme';
import { builtinTheme } from '../../src/shared/theme';
import { ChatSurfaceView } from '../../src/renderer/src/chatSurface/ChatSurfaceView';
import type { ChatSurface, ChatSurfaceSnapshot } from '../../src/shared/chatSurface';

const query = new URLSearchParams(location.search);
applyTheme(builtinTheme(query.get('theme') === 'light' ? 'light' : 'dark')!);
const workspace = { id: 'open-scroll', name: '开场滚动回归', path: 'E:/fixture', openedAt: 1 };
const history = Array.from({ length: 12 }, (_, i) => ({ id: `m${i}`, role: i % 2 ? 'assistant' : 'user', createdAt: Date.now(),
  content: i % 2 ? `### 回复 ${i}\n\n` + Array.from({ length: 5 }, (_, j) => `第 ${j + 1} 段：打开调度面板时，应直接显示最新回复并保持阅读位置。`).join('\n\n') : `问题 ${i}：请检查会话面板的开场定位。` }));
const partsOf = (message: typeof history[number]) => [
  ...(query.get('history') === 'heavy' && message.role === 'assistant'
    ? Array.from({ length: 120 }, (_, i) => ({ kind: 'thinking' as const, text: `分析步骤 ${i}` })) : []),
  { kind: 'text' as const, text: message.content }
];
const summary = { id: 'review-snapshot', state: 'ready' as const, warnings: [], files: [
  { path: 'src/example.ts', kind: 'modified' as const, added: 12, removed: 3, revertible: true }
] };
if (query.get('review') === '1') Object.assign(history[11]!, { turnChanges: summary });
if (query.get('suggestions') === '1') Object.assign(history[11]!, { suggestedReplies: ['好，等它交付'] });
history.forEach(message => Object.assign(message, { parts: partsOf(message) }));
const guiSnapshot: ChatSurfaceSnapshot = {
  messages: history.map(message => ({ id: message.id, role: message.role, ts: message.createdAt, parts: partsOf(message),
    ...('suggestedReplies' in message ? { suggestedReplies: ['好，等它交付'] } : {}),
    ...('turnChanges' in message ? { turnChanges: summary } : {}) })),
  busy: false, queuedCount: 0, queuedItems: [], status: null, mode: null, preset: null
};
const guiSurface: ChatSurface = {
  sessionId: 'open-gui', caps: { surfaceKind: 'gui-session', draftKey: 'open-gui', images: false },
  subscribe: () => () => {}, getSnapshot: () => guiSnapshot,
  actions: { send: async () => true, stop: () => {}, clear: async () => {}, retry: () => {}, cancelQueued: () => {} }
};
const original = window.api;
const defaults: Record<string, unknown> = {
  'workspaces.list': { workspaces: [workspace], activeWorkspaceId: workspace.id },
  'config.get': { workspaces: [workspace], activeWorkspaceId: workspace.id, locale: 'zh-CN' },
  'chat.historyRange': { messages: history, before: 0, total: history.length, hasEarlier: false }, 'chat.state': { busy: false }, 'chat.getMode': null,
  'workspaceFile.get': { workspaceId: workspace.id, config: {} }
};
function api(route = '', parent: any = original): any {
  return new Proxy(() => {}, {
    get: (_, key) => key === 'then' ? undefined : api(route ? `${route}.${String(key)}` : String(key), parent[key]),
    apply: (_, __, args) => route === 'turnChanges.list' && query.get('review') === '1'
      ? new Promise(resolve => setTimeout(() => resolve({ ok: true, entries: [{ target: { ...args[0], messageId: 'm11' }, summary, label: 'review', createdAt: 1 }] }), 400))
      : Object.hasOwn(defaults, route) ? Promise.resolve(structuredClone(defaults[route])) : parent(...args)
  });
}
window.api = api();
localStorage.setItem('muster.agentPanelSize', JSON.stringify({ w: 620, h: 650 }));
function App() {
  const [slot, setSlot] = React.useState<HTMLDivElement | null>(null);
  const [open, setOpen] = React.useState(false);
  const [composerHeight, setComposerHeight] = React.useState(100);
  if (query.get('surface') === 'keepalive') return <StoreProvider>
    <button data-open-gui onClick={() => setOpen(value => !value)}>打开/关闭普通会话</button>
    <button data-grow-composer onClick={() => setComposerHeight(200)}>改变隐藏输入区高度</button>
    <div className="agent-chat-view" style={{ height: 650, position: 'relative', display: open ? 'flex' : 'none' }}>
      <ChatSurfaceView surface={guiSurface} findEnabled={false} interactionActive={open}
        composerOverride={<div style={{ height: composerHeight }}>输入区</div>} />
    </div>
  </StoreProvider>;
  if (query.get('surface') === 'gui') return <StoreProvider>
    <button data-open-gui onClick={() => setOpen(value => !value)}>打开/关闭普通会话</button>
    {open && <div className="agent-chat-view" style={{ height: 650, position: 'relative' }}>
      <ChatSurfaceView surface={guiSurface} findEnabled={false} />
    </div>}
  </StoreProvider>;
  return <StoreProvider><div className="main-view" style={{ height: '100vh' }}><aside className="left-ws-slot" style={{ position: 'absolute', left: 12, bottom: 12, width: 228 }} ref={setSlot} />
    <AgentFloat wsStackSlot={slot} /></div></StoreProvider>;
}
createRoot(document.getElementById('root')!).render(<App />);
