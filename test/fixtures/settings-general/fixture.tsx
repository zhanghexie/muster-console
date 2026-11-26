import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../../src/renderer/src/i18n';
import { GeneralPane } from '../../../src/renderer/src/components/settings/GeneralPane';
import { KeybindingProvider } from '../../../src/renderer/src/keybindings/KeybindingHost';
import { applyTheme } from '../../../src/renderer/src/theme';
import { builtinTheme } from '../../../src/shared/theme';

const theme = new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark';
applyTheme(builtinTheme(theme)!);
const fixture = { sent: [], calls: [] as any[], unmocked: [] as string[] };
(window as any).__uiFixture = fixture;
const listeners = new Map<string, Set<(...args: any[]) => void>>();
const tips = [{ 'zh-CN': '搜索历史消息', en: 'Search message history' }, { 'zh-CN': '固定常用会话', en: 'Pin conversations' }, { 'zh-CN': '选择适合任务的模型', en: 'Choose a model for the task' }, { 'zh-CN': '通过快捷键切换界面', en: 'Navigate with shortcuts' }];
const gitBash = { id: 'git-bash', label: 'Git Bash', command: 'C:\\Program Files\\Git\\bin\\bash.exe', args: [] };
const handlers: Record<string, (...args: any[]) => any> = {
  'config.get': () => ({ keybindings: {}, workspaces: [] }),
  'config.update': patch => patch,
  'config.waitingTips': () => ({ ok: true, path: 'C:/Users/demo/AppData/Roaming/MetaAgent/waiting-tips.json', tips }),
  'shell.revealPath': () => ({ ok: true }),
  'shell.getInfo': () => ({
    platform: 'win32', profiles: [gitBash], bgShellProfile: gitBash, bgShellMode: 'auto',
    manualGitBashPath: '', manualGitBashPathExists: false, gitBashPath: gitBash.command
  }),
  'workspaces.pickDir': () => ({ ok: true, path: 'E:/Projects/isolated-tasks' }),
  'app.setChromeTheme': () => undefined,
};
function api(route = ''): any { return new Proxy(() => {}, {
  get: (_, key) => key === 'then' ? undefined : api(route ? route + '.' + String(key) : String(key)),
  apply: (_, __, args) => {
    fixture.calls.push({ path: route, args });
    if (route === 'on') { const [key, cb] = args; const list = listeners.get(key) || new Set(); list.add(cb); listeners.set(key, list); return () => list.delete(cb); }
    if (!handlers[route] && !fixture.unmocked.includes(route)) fixture.unmocked.push(route);
    return Promise.resolve(handlers[route]?.(...args));
  }
}); }
(window as any).api = api();
function App() {
  const [cfg, setCfg] = React.useState<any>({ worktreeStorageRoot: 'E:/Projects/agent-worktrees', tasksKeepAwake: true, showWaitingTips: true });
  return <KeybindingProvider><div className="settings-page" style={{ position: 'relative', display: 'block', height: '100vh', padding: 0 }}>
    <div className="settings-tabpane is-shown" data-settings-item="general" style={{ height: '100%', position: 'relative', background: 'var(--surface-canvas)' }}>
      <div className="settings-col"><header className="settings-pane-title"><h1>通用</h1></header><GeneralPane cfg={cfg} set={patch => { fixture.calls.push({ path: 'draft.update', args: [patch] }); setCfg((prev: any) => ({ ...prev, ...patch })); }}/></div>
    </div></div></KeybindingProvider>;
}
createRoot(document.getElementById('root')!).render(<App/>);
