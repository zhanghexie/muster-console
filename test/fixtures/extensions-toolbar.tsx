import '@workbench/.agents/skills/ui-verification/assets/fixture-api';
import React from 'react';
import { createRoot } from 'react-dom/client';
import '@workbench/src/renderer/src/i18n';
import { StoreProvider } from '@workbench/src/renderer/src/store';
import { ExtensionChromeActions } from '@workbench/src/renderer/src/components/ExtensionChromeActions';
import { applyTheme } from '@workbench/src/renderer/src/theme';
import { builtinTheme } from '@workbench/src/shared/theme';

applyTheme(builtinTheme(new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark')!);
const workspace = { id: 'toolbar-extension', name: '项目', path: 'E:/fixture', openedAt: 1 };
const items = ['开发', '日报', '任务', '诊断', '查询', '发布'].map((name, index) => ({ id: `tool-${index}`, name, scope: index ? 'global' : 'project', ...(index === 0 ? { menu: [{ id: 'start', label: '启动开发环境' }, { id: 'stop', label: '停止开发环境' }] } : index === 5 ? { menu: [{ id: 'publish', label: '发布项目' }] } : {}) }));
const defaults: Record<string, unknown> = {
  'workspaces.list': { workspaces: [workspace], activeWorkspaceId: workspace.id },
  'config.get': { workspaces: [workspace], activeWorkspaceId: workspace.id, locale: 'zh-CN' },
  'sessions.list': { sessions: [], activeId: null },
  'extensions.toolbar': { workspaceId: workspace.id, sourceRootId: 'project', selectionRevision: 1, items },
  'extensions.runToolbar': { ok: true },
  'chat.history': [], 'chat.state': { busy: false }, 'chat.getMode': null,
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
createRoot(document.getElementById('root')!).render(<StoreProvider><div className="toolbar-extension-fixture" style={{ height: 280, background: 'var(--frame-bg)', paddingTop: 12 }}><ExtensionChromeActions/></div></StoreProvider>);
