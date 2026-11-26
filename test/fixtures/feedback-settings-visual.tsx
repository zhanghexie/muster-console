/** Production feedback settings component with mock IPC; no external browser launch. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import '@workbench/src/renderer/src/i18n';
import { applyTheme } from '@workbench/src/renderer/src/theme';
import { builtinTheme } from '@workbench/src/shared/theme';
import { AboutPane } from '@workbench/src/renderer/src/components/settings/AboutPane';
import { SettingsContent } from '@workbench/src/renderer/src/components/settings/SettingsContent';

const calls: string[] = [];
(window as any).__uiFixture = { calls, unmocked: [] };
(window as any).api = {
  app: { setChromeTheme: async () => ({ ok: true, material: 'solid' }) },
  on: () => () => {}, shell: { openExternal: async (url: string) => { calls.push(url); return { ok: true }; } },
  updater: { getState: async () => ({ state: 'idle', currentVersion: '0.1.31' }), check: async () => {}, install: async () => {}, revealInstaller: async () => true },
  feedback: { snapshot: async () => ({ entries: [] }) }
};
applyTheme(builtinTheme(new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark')!);
createRoot(document.getElementById('root')!).render(<main className="feedback-settings-visual" style={{ padding: 24, position: 'relative', zIndex: 100 }}>
  <h1>关于</h1><SettingsContent><AboutPane/></SettingsContent>
</main>);
