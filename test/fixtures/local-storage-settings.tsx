import { AppTipHost } from '../../src/renderer/src/components/AppTip';
/** Real settings shell and storage pane with isolated in-memory IPC. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { useTranslation } from 'react-i18next';
import type { LocalStorageSnapshot } from '@workbench/src/shared/localStorage';

const snapshot: LocalStorageSnapshot = { id: 'fixture', partial: false, workspaces: [{ id: 'demo', name: 'MetaAgent' }], items: [
  { id: 'w1', category: 'worktrees', name: '任务界面调整', workspaceId: 'demo', sessionId: 'w1', paths: ['C:/MetaAgent/worktrees/task-ui'], bytes: 13_000_000_000, partial: false, action: 'worktree' },
  { id: 'w2', category: 'worktrees', name: '性能排查', workspaceId: 'demo', paths: ['C:/MetaAgent/worktrees/performance'], bytes: 3_000_000_000, partial: false, reason: 'active' },
  { id: 'w3', category: 'worktrees', name: '实验·斜面与轨道机械能', workspaceId: 'demo', sessionId: 'w3', paths: ['C:/MetaAgent/worktrees/previous-task'], pathStatuses: [{ path: 'C:/MetaAgent/worktrees/previous-task', status: 'missing' }], bytes: null, partial: false, action: 'worktree' },
  { id: 's1', category: 'sessions', name: '代码审查与改进', workspaceId: 'demo', sessionId: 's1', paths: ['C:/MetaAgent/agent-sessions/s1.json'], bytes: 86_000_000, partial: false, action: 'session' },
  { id: 's2', category: 'sessions', name: '项目状态梳理', workspaceId: 'demo', sessionId: 's2', paths: ['C:/MetaAgent/agent-sessions/s2.json'], bytes: 42_000_000, partial: false, reason: 'active' },
  { id: 'a1', category: 'attachments', name: '代码审查与改进', workspaceId: 'demo', sessionId: 's1', paths: ['C:/MetaAgent/conversation-attachments/abc'], bytes: 1_930_000_000, partial: false, action: 'attachment' },
  { id: 'h1', category: 'handovers', name: '代码审查与改进', workspaceId: 'demo', sessionId: 's1', paths: ['C:/MetaAgent/session-handovers/s1'], bytes: 248_000_000, partial: false, action: 'handover' },
  { id: 'e1', category: 'extensions', name: 'extension', paths: ['C:/MetaAgent/extension'], bytes: 220_000_000, partial: false, reason: 'shared' },
  { id: 'e2', category: 'extensions', name: 'extension', workspaceId: 'demo', paths: ['C:/MetaAgent/extension/data/workspaces/demo'], bytes: 60_000, partial: false, reason: 'shared' },
  { id: 'e3', category: 'extensions', name: '辅助扩展', workspaceId: 'demo', paths: [], bytes: null, sizeKind: 'shared', partial: false, reason: 'shared' },
  { id: 'p1', category: 'apps', name: '示例应用', workspaceId: 'demo', paths: [], bytes: null, sizeKind: 'shared', partial: false, action: 'app' },
  { id: 'p2', category: 'apps', name: 'agent-apps', workspaceId: 'demo', paths: ['C:/MetaAgent/agent-apps/demo.sqlite'], bytes: 1_200_000_000, partial: false, reason: 'shared' },
  { id: 'b1', category: 'browser', name: 'browser-site-data', paths: ['C:/MetaAgent/Partitions/browser'], bytes: 1_200_000_000, partial: false, modifiedAt: 1700000000000, action: 'browserData' },
  { id: 'b2', category: 'browser', name: 'old-download.txt', paths: ['C:/MetaAgent/browser-downloads/old-download.txt'], bytes: 1200, partial: false, reason: 'unknownDownload' },
  { id: 't1', category: 'themes', name: '个人主题', paths: ['C:/MetaAgent/themes/custom.json'], bytes: 95_000, partial: false, action: 'theme' },
  { id: 'o1', category: 'other', name: 'logs', paths: ['C:/MetaAgent/logs'], bytes: 700_000_000, partial: false, reason: 'shared' }
] };
const calls: Array<{ path: string; args: unknown[] }> = [], unmocked: string[] = [];
let cleanupSelection: Array<{ id: string }> = [];
let pendingCleanup = false;
let revealError = '';
const cleanupErrors = new Map<string, string>();
let scanGate: Promise<void> | null = null;
let releaseScan: (() => void) | null = null;
(window as any).__uiFixture = {
  calls, unmocked,
  pauseStorageScan: () => { scanGate = new Promise<void>(resolve => { releaseScan = resolve; }); },
  resumeStorageScan: () => { releaseScan?.(); releaseScan = null; scanGate = null; },
  delayStorageCleanup: () => { pendingCleanup = true; },
  failStorageCleanup: (id: string, message: string) => { cleanupErrors.set(id, message); },
  setRevealError: (value: string) => { revealError = value; },
  markStoragePartial: () => { snapshot.partial = true; snapshot.items[0]!.partial = true; },
  enableStorageMaintenance: () => {
    snapshot.items.push(
      { id: 'cache', category: 'other', name: '工作台网页和图形缓存', maintenanceId: 'chromiumCache', paths: ['C:/MetaAgent/Cache', 'C:/MetaAgent/GPUCache'], bytes: 2_000_000_000, partial: false, action: 'startupCleanup' },
      { id: 'usage', category: 'other', name: '使用统计和明细', maintenanceId: 'usageHistory', paths: ['C:/MetaAgent/usage-stats.json'], bytes: 80_000_000, partial: false, action: 'startupCleanup' }
    );
  },
  enableStorageDependencies: () => {
    snapshot.dependencies = [{ dependentId: 's1', prerequisiteId: 'w1' }, { dependentId: 's2', prerequisiteId: 'w1' }];
    snapshot.items.find(item => item.id === 'w1')!.canDiscardWorktree = true;
    const active = snapshot.items.find(item => item.id === 's2')!;
    delete active.reason;
    active.action = 'session';
    active.stopsSession = true;
  },
  addStorageItems: () => {
    for (const category of ['sessions', 'attachments'] as const) for (let i = 1; i <= 18; i++) {
      snapshot.items.push({ id: `${category}-${i}`, category, name: `额外项目 ${category} ${i}`, workspaceId: 'demo', sessionId: `${category}-${i}`, paths: [`C:/MetaAgent/${category}/${i}`], bytes: i * 1000, partial: false, action: category === 'sessions' ? 'session' : 'attachment' });
    }
  }
};
const handlers: Record<string, (...args: any[]) => unknown> = {
  'config.get': () => ({ locale: 'zh-CN', defaultRuntime: 'pi', workspace: 'C:/demo', activeWorkspaceId: 'demo', workspaces: [{ id: 'demo', name: 'MetaAgent', path: 'C:/demo' }], keybindings: {} }),
  'capabilities.get': () => ({ dispatcher: { customBody: '', defaultBody: '' } }),
  'localStorage.scan': () => scanGate ? scanGate.then(() => structuredClone(snapshot)) : structuredClone(snapshot),
  'localStorage.startCleanup': (_id, selection) => { cleanupSelection = selection; return { id: 'fixture-job' }; },
  'localStorage.cleanupStatus': () => {
    if (pendingCleanup) { pendingCleanup = false; return { id: 'fixture-job', total: cleanupSelection.length, done: false, results: [] }; }
    const results = cleanupSelection.map(item => {
      if (cleanupErrors.has(item.id)) return { id: item.id, status: 'failed', error: cleanupErrors.get(item.id) };
      if (snapshot.items.find(asset => asset.id === item.id)?.action === 'startupCleanup') return { id: item.id, status: 'scheduled' };
      return { id: item.id, status: item.id === 's1' ? 'started' : 'completed' };
    });
    return { id: 'fixture-job', total: cleanupSelection.length, done: true, results };
  },
  'shell.revealPath': () => revealError ? { ok: false, error: revealError } : { ok: true },
  'app.relaunch': () => undefined,
  'app.setChromeTheme': () => ({ ok: true, material: 'solid' })
};
function api(route = ''): any { return new Proxy(() => {}, {
  get: (_, key) => key === 'then' ? undefined : api(route ? `${route}.${String(key)}` : String(key)),
  apply: (_, __, args) => {
    if (route === 'on') return () => {};
    calls.push({ path: route, args });
    if (!handlers[route]) { unmocked.push(route); return Promise.reject(new Error(`Unmocked fixture IPC: ${route}`)); }
    return Promise.resolve(handlers[route](...args));
  }
}); }
(window as any).api = api();
const narrow = matchMedia('(max-width: 820px)');
const syncNarrow = () => document.documentElement.classList.toggle('is-narrow', narrow.matches);
narrow.addEventListener('change', syncNarrow); syncNarrow();
async function mount() {
  await import('@workbench/src/renderer/src/i18n');
  const [{ SettingsModal }, { KeybindingProvider }, { applyTheme }, { builtinTheme }, { applyLocaleSetting }, { SettingsContent }, { LocalStoragePane }] = await Promise.all([
    import('@workbench/src/renderer/src/components/settings/SettingsModal'), import('@workbench/src/renderer/src/keybindings/KeybindingHost'),
    import('@workbench/src/renderer/src/theme'), import('@workbench/src/shared/theme'), import('@workbench/src/shared/i18n'),
    import('@workbench/src/renderer/src/components/settings/SettingsContent'), import('@workbench/src/renderer/src/components/settings/LocalStoragePane')
  ]);
  (window as any).__setStorageLocale = applyLocaleSetting;
  applyTheme(builtinTheme(new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark')!);
  function NarrowShell() {
    const { t } = useTranslation();
    return <div className="settings-page" style={{ position: 'relative', display: 'block', height: '100vh', padding: 0 }}><div className="settings-tabpane is-shown" data-settings-item="localStorage" style={{ height: '100%', position: 'relative', background: 'var(--surface-canvas)' }}><div className="settings-col"><header className="settings-pane-title"><h1>{t('本机存储')}</h1></header><SettingsContent><LocalStoragePane /></SettingsContent></div></div></div>;
  }
  const content = innerWidth < 700 ? <NarrowShell /> : <div className="app-shell"><SettingsModal initialTab="localStorage" onClose={() => {}} /></div>;
  createRoot(document.getElementById('root')!).render(<KeybindingProvider>{content}<AppTipHost/></KeybindingProvider>);
}
void mount();
