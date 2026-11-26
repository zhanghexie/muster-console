import { AppTipHost } from '../../src/renderer/src/components/AppTip';
import '@workbench/.agents/skills/ui-verification/assets/fixture-api';
import React from 'react';
import { createRoot } from 'react-dom/client';
import '@workbench/src/renderer/src/i18n';
import { applyTheme } from '@workbench/src/renderer/src/theme';
import { builtinTheme } from '@workbench/src/shared/theme';
import type { ExtensionDiscoveredExtension, ExtensionListing } from '@workbench/src/shared/extension';
import { ExtensionsManager } from '@workbench/src/renderer/src/panels/ExtensionsManager';

const theme = new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark';
applyTheme(builtinTheme(theme)!);
const entry = (id: string, name: string, description: string, scope: 'global' | 'project'): ExtensionDiscoveredExtension => ({ workspaceId: 'a', id, directory: `E:/Projects/example/.muster/extensions/${id}`, fingerprint: `package-extension:${'a'.repeat(64)}`, status: 'installed', enabled: true, manifest: { id, name, description, scope, version: '1.0.0', surface: { kind: 'toolbar', command: 'open' }, permissions: [], ...(scope === 'project' ? { project: { kind: 'relative' as const, path: '.' } } : {}), data: { workspace: true, shared: false } } });
const initial: ExtensionListing = { global: [{ ...entry('daily-report', '工作日报', '查看当前工作区日志、生成日报与管理待办。', 'global'), bundled: true }, { ...entry('sync-tool', '同步工具', '所有工作区均可使用。', 'global'), sourceKind: 'center' }], project: [entry('dev', '启动开发环境', '拉起当前项目的开发服务。', 'project')], issues: ['内置日报：示例工作区已有无法确认归属的同名扩展，保留原文件'], problems: [], transactions: [{ id: 'demo-transaction', extensionId: 'daily-report', reason: '暂存副本已变化，保留现场', paths: ['C:/Users/example/AppData/Roaming/MetaAgent/extension/transactions/demo-transaction.json', 'E:/Projects/example/.muster/extensions/.extension-stage-demo-transaction', 'E:/Projects/example/.muster/extensions/.extension-previous-demo-transaction'] }] };
function Fixture() {
  const [listing, setListing] = React.useState(initial);
  const [root, setRoot] = React.useState('a1');
  const projects = [{ id: 'a1', label: '示例项目' }, { id: 'a2', label: '另一个项目' }];
  return <ExtensionsManager workspaceId="a" sourceRootId={root} projectLabel={projects.find(item => item.id === root)!.label} projects={projects} onProjectChange={setRoot} listing={{ ...listing, project: root === 'a1' ? listing.project : [] }} setEnabled={async (scope, id, enabled) => setListing(current => ({ ...current, [scope]: current[scope].map(item => item.id === id ? { ...item, enabled } : item) }))} preserveTransaction={async () => { setListing(current => ({ ...current, transactions: [] })); return 'C:/Users/example/AppData/Roaming/MetaAgent/extension/transactions/.preserved-demo.bak'; }}/>;
}
createRoot(document.getElementById('root')!).render(<><Fixture/><AppTipHost/></>);
