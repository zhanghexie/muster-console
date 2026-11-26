import '../../.agents/skills/ui-verification/assets/fixture-api';
import React from 'react';
import { createRoot } from 'react-dom/client';
import '@workbench/src/renderer/src/i18n';
import { StoreProvider } from '@workbench/src/renderer/src/store';
import { CliSessionView } from '@workbench/src/renderer/src/components/CliSessionView';
import { applyTheme } from '@workbench/src/renderer/src/theme';
import { builtinTheme } from '@workbench/src/shared/theme';

const api = window.api;
let items = [{ id: 'cli-r', text: '确认 CLI 操作', createdAt: 1, completedAt: null, completedBy: null, sourceMessageId: null }];
(window as any).api = new Proxy(api, {
  get(target, key) {
    if (key === 'sessionReminders') return { list: async () => ({ scope: 'fixture', items: structuredClone(items) }),
      delete: async (_target: unknown, _scope: string, id: string) => { items = items.filter(item => item.id !== id); } };
    if (key === 'pty') return { getBuffer: async () => 'CLI Agent\r\n等待你确认后继续。', resize: () => {}, input: () => {} };
    return Reflect.get(target, key);
  }
});
localStorage.setItem('muster.cli-composer-collapsed:cli-visual', '0');
applyTheme(builtinTheme(new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark')!);
const session = { id: 'cli-visual', name: 'CLI', type: 'terminal', launchKind: 'agent', runtime: 'opencode',
  status: 'running', createdAt: 1, lastUsedAt: 1 } as const;
createRoot(document.getElementById('root')!).render(<StoreProvider>
  <main style={{ padding: 16, background: 'var(--surface-frame)' }}>
    <div className="cli-visual-frame" style={{ position: 'relative', height: 570 }}>
      <CliSessionView session={session} visible style={{ position: 'absolute', inset: 0 }}/>
    </div>
  </main>
</StoreProvider>);
