import React from 'react';
import { createRoot } from 'react-dom/client';

const workspace = { id: 'split-fixture', name: '分屏测试', path: 'E:/fixture', roots: [] };
const toolbarDemo = new URLSearchParams(location.search).has('toolbar');
const rows = ['a', 'b', 'c'].map((id, index) => ({ id, type: 'terminal', workspaceId: workspace.id,
  name: toolbarDemo ? ['会话顶栏与交互优化', '视觉与交互方案复核', '运行日志'][index] : ['会话甲', '会话乙', '会话丙'][index],
  launchKind: 'agent', runtime: toolbarDemo || id === 'c' ? 'fixture-chat' : undefined,
  ...(toolbarDemo ? { lifecycle: index === 0 ? 'working' : 'idle', phase: index === 0 ? undefined : { value: 'needs_you', source: 'model', ts: Date.now() },
    liveStatus: { label: index === 0 ? '正在检查消息渲染与会话状态' : '等待确认布局与操作入口', kind: 'info', ts: Date.now() } } : {}) }));
const nodes = [
  { id: 'folder', kind: 'folder', title: '测试文件夹', parentId: null, expanded: true },
  { id: 'child', kind: 'extension', title: '沙箱面板', parentId: 'folder', extensionId: 'fixture-frame', viewId: 'pane', placement: 'center' },
  { id: 'child-b', kind: 'extension', title: '沙箱面板乙', parentId: 'folder', extensionId: 'fixture-frame', viewId: 'pane-b', placement: 'center' }
];
const navigation = { workspaceId: workspace.id, sourceRootId: 'root', selectionRevision: 0, revision: 1, nodes, libraryExpanded: true };
const listeners = new Map<string, Set<(payload: any) => void>>();
const calls: { route: string; args: unknown[] }[] = [];
let activeId = 'a';
let onSessionSelected: (id: string) => void = () => {};
const defaults: Record<string, unknown> = {
  'workspaces.list': { workspaces: [workspace], activeWorkspaceId: workspace.id },
  'config.get': { workspaces: [workspace], activeWorkspaceId: workspace.id, locale: 'zh-CN' },
  'runtimes.list': [{ id: 'fixture-chat', label: toolbarDemo ? 'Pi' : 'GUI', surface: 'chat', enabled: true }],
  'agentTasks.listAll': { byWorkspace: {} }, 'notify.list': [], 'agent.listSkills': [],
  'workspaceFile.get': { workspaceId: workspace.id, config: {} },
  'workspaceFile.patch': { ok: true, workspaceId: workspace.id, config: {} },
  'workbench.navigation': navigation, 'shellProfiles.list': [], 'chat.state': { busy: false },
};
function emit(channel: string, payload: any) { for (const callback of listeners.get(channel) ?? []) callback(payload); }
function api(route = ''): any {
  return new Proxy(() => {}, {
    get: (_, key) => key === 'then' ? undefined : api(route ? `${route}.${String(key)}` : String(key)),
    apply: (_, __, args) => {
      calls.push({ route, args });
      if (route === 'on') {
        const [channel, callback] = args;
        const set = listeners.get(channel) ?? new Set(); listeners.set(channel, set); set.add(callback);
        return () => set.delete(callback);
      }
      if (route === 'sessions.list') return Promise.resolve({ sessions: rows, activeId });
      if (route === 'sessions.select') {
        activeId = args[0]; onSessionSelected(activeId); emit('sessions:changed', { sessions: rows, activeId });
        return Promise.resolve({ sessions: rows, activeId });
      }
      return Promise.resolve(structuredClone(defaults[route]));
    }
  });
}
(window as any).api = api();

async function mount() {
  await import('../../src/renderer/src/i18n');
  // 种子会话是「常驻」：计入会话视图 LRU（性能专项后只保活最近访问的会话），
  // 否则 CenterPanel 启动即只挂载 active 会话，b/c 的内容根不渲染
  const lru = await import('../../src/renderer/src/sessionViewLru');
  // 种子会话计入 LRU：初始注入会被 CenterPanel 启动期的 retain 清池（sessions.list
  // 异步加载完成前池会被清空），故暴露重注入钩子供测试在清单就绪后再注入
  const retouch = (): void => { for (const row of rows) lru.touchSessionView(row.id); };
  retouch();
  (window as any).__lruRetouch = retouch;
  (window as any).__lruDebug = () => ({ order: lru.getSessionViewsDebug(), alive: rows.map(r => lru.isSessionViewAlive(r.id)) });
  const { StoreProvider } = await import('../../src/renderer/src/store');
  const { PanelHistoryProvider } = await import('../../src/renderer/src/panelHistory');
  const { KeybindingProvider } = await import('../../src/renderer/src/keybindings/KeybindingHost');
  const { CenterPanel } = await import('../../src/renderer/src/panels/CenterPanel');
  const { LeftPanel } = await import('../../src/renderer/src/panels/LeftPanel');
  const { ExtensionNavigationTree } = await import('../../src/renderer/src/components/ExtensionNavigationTree');
  const split = await import('../../src/renderer/src/centerSplitStore');
  const { builtinTheme } = await import('../../src/shared/theme');
  const { applyTheme } = await import('../../src/renderer/src/theme');
  const query = new URLSearchParams(location.search);
  applyTheme(builtinTheme(query.get('theme') === 'light' ? 'light' : 'dark')!);
  let primary: any = { kind: 'session', sessionId: 'a' };
  let setUtility: (selection: any) => void = () => {};
  let prefs = { dir: 'row' as 'row' | 'col', ratio: 0.5 };
  function select(ref: any) {
    primary = ref; setUtility(ref.kind === 'utility' ? ref.sel : null);
    if (ref.kind === 'session') { activeId = ref.sessionId; emit('sessions:changed', { sessions: rows, activeId }); }
  }
  // The real App derives primary from utility selection and StoreProvider's
  // displayActiveId. Mirror the mocked IPC acknowledgment into this harness too.
  onSessionSelected = id => {
    primary = { kind: 'session', sessionId: id }; setUtility(null);
    split.centerSplitReconcilePrimary(primary);
  };
  const closeUtility = () => { primary = { kind: 'session', sessionId: activeId }; setUtility(null); };
  split.attachCenterSplitBridge({ getPrimary: () => primary, selectRef: select, getPrefs: () => prefs,
    savePrefs: value => { prefs = { ...prefs, ...value }; } });
  function App() {
    const [utility, updateUtility] = React.useState<any>(null); setUtility = updateUtility;
    const selectUtility = (selection: any) => {
      const ref = { kind: 'utility', sel: selection };
      if (!split.centerSplitTryFill(ref)) select(ref);
    };
    const sources = <aside id="fixture-sources" style={{ position: 'absolute', left: 16, top: 16, bottom: 16, width: 260, overflow: 'auto' }}>
        <LeftPanel utilityPanel={utility} onSelectUtilityPanel={selectUtility} onCloseUtilityPanel={closeUtility}
          onBackPanelHistory={() => {}} onForwardPanelHistory={() => {}} />
        <div data-native-navigation-source><ExtensionNavigationTree nodes={nodes as any} selectedId={null} onChange={() => {}}
          onSelect={id => { if (id) selectUtility(`nav:${id}`); }} /></div>
      </aside>;
    const panel = <CenterPanel utilityPanel={utility} onCloseUtilityPanel={closeUtility} onSelectUtilityPanel={selectUtility} />;
    return <StoreProvider><PanelHistoryProvider><KeybindingProvider>
      {query.has('fullscreen') ? <div className="app-shell">
        <header className="chrome-bar">全屏布局验证</header>
        <div className="main-view h-vs-on">
          <div className="ws-stage"><div className="ws-rail ws-rail-idle"><div className="ws-pane ws-pane-live">
            <div className="work-area" style={{ width: '100%' }}><div className="h-strip vs-axis" style={{ width: '145%', transform: 'translateX(0px)' }}>
              <div className="h-page workspace-page" style={{ width: '75vw' }}>
                <div className="sessions-column" style={{ width: 292 }}>{sources}</div>
                <div id="fixture-center" className="terminal-page" style={{ width: 'calc(75vw - 292px)' }}>{panel}</div>
              </div>
              <div className="h-page git-page" style={{ width: '70vw' }}>右侧工具面板</div>
            </div></div>
          </div></div></div>
        </div>
      </div> : <>{sources}<div id="fixture-center" className="terminal-page" style={{ position: 'absolute', left: 292, right: 24, top: 24, bottom: 24, height: 'auto', border: '1px solid var(--hairline)' }}>{panel}</div></>}
    </KeybindingProvider></PanelHistoryProvider></StoreProvider>;
  }
  const tape: any[] = [];
  for (const type of ['dragstart', 'dragover', 'drop', 'dragend']) document.addEventListener(type, (event: any) => {
    if (!event.dataTransfer) return;
    const target = event.target as Element;
    const entry: any = { type, trusted: event.isTrusted, source: target.closest?.('.session-item')?.textContent,
      navigationSource: target.closest?.('[data-node-id]')?.getAttribute('data-node-id'),
      target: { tag: target.tagName, id: target.id, classes: target.getAttribute?.('class'),
        testid: target.getAttribute?.('data-testid'), node: target.closest?.('[data-node-id]')?.getAttribute('data-node-id') },
      x: event.clientX, y: event.clientY, types: [...event.dataTransfer.types],
      allowed: event.dataTransfer.effectAllowed, effect: event.dataTransfer.dropEffect,
      payload: event.dataTransfer.getData('application/x-muster-pane'), inCenter: !!target.closest?.('.center-panel') };
    tape.push(entry);
    queueMicrotask(() => { entry.after = { defaultPrevented: event.defaultPrevented,
      allowed: event.dataTransfer.effectAllowed, effect: event.dataTransfer.dropEffect }; });
  }, true);
  (window as any).__centerSplitTest = {
    split, calls, tape, setPrimary: select, primary: () => primary,
    reset: (options: any = {}) => {
      split.centerSplitClose(); prefs = { dir: options.dir ?? 'row', ratio: options.ratio ?? 0.5 };
      select(options.primary ?? { kind: 'session', sessionId: 'a' });
      if (options.secondary) split.centerSplitIncoming(options.secondary, prefs.dir === 'row' ? 'right' : 'bottom');
      if (options.secondary) split.centerSplitSetRatio(prefs.ratio);
      tape.length = 0;
    },
    switchWorkspace: () => { split.centerSplitClose(); emit('workspaces:changed', { workspaces: [workspace], activeWorkspaceId: workspace.id }); }
  };
  createRoot(document.getElementById('root')!).render(<App />);
}
void mount();
