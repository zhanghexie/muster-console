import React from 'react';
import { createRoot } from 'react-dom/client';
import type { SessionMeta, WorkspaceInfo } from '../../src/shared/types';

const workspace = { id: 'fixture', name: 'MetaAgent', path: 'E:/fixture', roots: [{ id: 'root', path: 'E:/fixture' }], defaultRootId: 'root', rootsRevision: 1 } as WorkspaceInfo;
const runtimes = [{ id: 'pi', label: 'Pi', surface: 'chat', enabled: true }];
const names = ['README 更新与状态上报', '世界UI底层调研', '分析时长变差游戏', '修正起钓视角', '耗时变高', '本机JS修拉起视角', '72合入temp并开MR', 'Prepare提前GetAsset', '修消费态加载图', '对照71两条ISM', '调研UGC AI生成链路', '协议对比'];
const rows = names.map((name, i) => ({ id: String(i), name, workspaceId: workspace.id, type: 'terminal', launchKind: i === 2 ? 'shell' : 'agent' })) as SessionMeta[];
const defaults: Record<string, unknown> = {
  'shell.listProfiles': [{ id: 'powershell', label: 'PowerShell' }],
  'runtimes.availability': { runtimes, acpAgents: [], checkedAt: Date.now() },
  'sessions.precheck': { isolate: false, dirty: false },
  'pi.listModes': [], 'llm.listProviders': [], 'config.get': { locale: 'zh-CN' }
};
function api(route = ''): any { return new Proxy(() => {}, {
  get: (_, key) => key === 'then' ? undefined : api(route ? `${route}.${String(key)}` : String(key)),
  apply: () => route === 'on' ? () => {} : Promise.resolve(structuredClone(defaults[route]))
}); }
(window as any).api = api(); (window as any).__uiFixture = { unmocked: [] };
async function mount() {
  await import('../../src/renderer/src/i18n');
  const { SplitContentPicker } = await import('../../src/renderer/src/components/SplitContentPicker');
  const { applyTheme } = await import('../../src/renderer/src/theme');
  const { builtinTheme } = await import('../../src/shared/theme');
  applyTheme(builtinTheme(new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark')!);
  createRoot(document.getElementById('root')!).render(<main style={{ position: 'relative', height: '100vh', background: 'var(--surface-canvas)' }}>
    <SplitContentPicker workspace={workspace} runtimes={runtimes as any} sessions={rows}
      choices={[...rows.map(row => ({ kind: 'session' as const, sessionId: row.id })), { kind: 'utility', sel: 'tasks' }]}
      labelFor={ref => ref.kind === 'session' ? rows.find(row => row.id === ref.sessionId)!.name : '定时任务'}
      testIdPrefix="pick" onSelect={ref => { (window as any).__selected = ref; }} />
  </main>);
}
void mount();
