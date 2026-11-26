import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/renderer/src/components/settings/capability-management.css';
import '../../src/renderer/src/styles/right-workspace.css';

const workspaces = [{ id: 'fixture', name: 'Fixture', path: 'E:/fixture', openedAt: 1 }];
const content = Array.from({ length: 180 }, (_, i) => `第 ${i + 1} 行：编辑器滚动边界测试 ` + 'long_content_'.repeat(35)).join('\n\n');
const defaults: Record<string, unknown> = {
  'workspaces.list': { workspaces, activeWorkspaceId: 'fixture' },
  'config.get': { workspaces, activeWorkspaceId: 'fixture', locale: 'zh-CN' },
  'sessions.list': { sessions: [], activeId: null }, 'agentTasks.listAll': { byWorkspace: {} },
  'runtimes.list': [], 'notify.list': [],
  'fs.readTextRef': { ok: true, content, mtimeMs: 1 }, 'fs.readText': { ok: true, content, mtimeMs: 1 },
  'fs.statRef': { ok: true, isDirectory: false, size: content.length },
  'fs.stat': { ok: true, isDirectory: false, size: content.length },
  'fs.openFile': { ok: true }, 'fs.closeFile': { ok: true }
};
const calls: unknown[] = [];
function api(route = ''): any {
  return new Proxy(() => {}, {
    get: (_, key) => key === 'then' ? undefined : api(route ? `${route}.${String(key)}` : String(key)),
    apply: (_, __, args) => {
      if (route === 'on') return () => {};
      calls.push({ route, args });
      return Promise.resolve(structuredClone(defaults[route]));
    }
  });
}
(window as any).api = api();
(window as any).__uiFixture = { unmocked: [], calls };
async function mount() {
  await import('../../src/renderer/src/i18n');
  const { StoreProvider } = await import('../../src/renderer/src/store');
  const { FileEditor } = await import('../../src/renderer/src/components/FileEditor');
  const { applyTheme } = await import('../../src/renderer/src/theme');
  const { builtinTheme } = await import('../../src/shared/theme');
  applyTheme(builtinTheme(new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark')!);
  createRoot(document.getElementById('root')!).render(<StoreProvider>
    <div className="files-panel" style={{ height: '100vh', padding: 12 }}>
      <FileEditor workspaceId="fixture" path="scroll.md" findBarOpen={false} onFindBarClose={() => {}} />
    </div>
  </StoreProvider>);
}
void mount();
