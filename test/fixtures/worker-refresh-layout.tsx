/** Production WorkerPane with isolated discovery results for the toolbar layout regression. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/renderer/src/i18n';
import { WorkerPane } from '../../src/renderer/src/components/settings/WorkerPane';
import type { AppConfig } from '../../src/shared/types';

const calls: string[] = [];
(window as any).__refreshCalls = calls;
(window as any).api = {
  on: () => () => {},
  runtimes: { list: async () => [], availability: async () => ({ runtimes: [], acpAgents: [], checkedAt: 1 }) },
  agentSession: { refreshHarnessModelCatalogs: async (requestId: string) => {
    calls.push(requestId);
    return { ok: true, workspace: '测试工作区', rows: [] };
  } }
};
const cfg = { defaultRuntime: 'pi', workspaces: [] } as unknown as AppConfig;
createRoot(document.getElementById('root')!).render(<div className="settings-page"><nav/>
  <main style={{ minWidth: 0, padding: '16px 24px', display: 'flex', flexDirection: 'column' }}><WorkerPane cfg={cfg} set={() => {}}/></main>
</div>);
