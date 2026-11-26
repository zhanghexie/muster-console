import { fixture, pickerRuntimes, scope, workspace } from './worker-routing-api';
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/renderer/src/i18n';
import { StoreProvider } from '../../src/renderer/src/store';
import { KeybindingProvider } from '../../src/renderer/src/keybindings/KeybindingHost';
import { TooltipHost } from '../../src/renderer/src/components/Tooltip';
import { AppTipHost } from '../../src/renderer/src/components/AppTip';
import { AgentComposer } from '../../src/renderer/src/components/AgentComposer';
import { NewTaskDialog } from '../../src/renderer/src/components/NewTaskDialog';
import { SettingsModal } from '../../src/renderer/src/components/settings/SettingsModal';
import { applyTheme } from '../../src/renderer/src/theme';
import { builtinTheme } from '../../src/shared/theme';
import type { AgentRuntimeEntry } from '../../src/shared/types';

const theme = new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark';
applyTheme(builtinTheme(theme)!);
const media = matchMedia('(max-width: 820px)');
const syncNarrow = () => document.documentElement.classList.toggle('is-narrow', media.matches);
media.addEventListener('change', syncNarrow);
syncNarrow();

function App() {
  const [settings, setSettings] = React.useState(false);
  const [task, setTask] = React.useState(false);
  const [modelLabel, setModelLabel] = React.useState('账户 A · Swift Model');
  return <KeybindingProvider><StoreProvider>
    <AppTipHost /><TooltipHost />
    <main className="worker-routing-fixture" style={{ boxSizing: 'border-box', padding: 16, minHeight: '100vh', background: 'var(--bg-panel)' }}>
      <button type="button" className="btn" onClick={() => setSettings(value => !value)}>{settings ? '返回会话' : '自动派活设置'}</button>
      <button type="button" className="btn" onClick={() => setTask(true)}>打开任务表单</button>
      <div style={{ marginTop: 16 }}>
        {settings ? <div className="settings-center-host" style={{ height: 'calc(100dvh - 76px)' }}>
          <SettingsModal initialTab="worker" presentation={media.matches ? 'embedded' : 'modal'} onClose={() => setSettings(false)} />
        </div> :
          <AgentComposer workspaceId={workspace.id} workerRoutingScope={scope} surfaceKind="gui-session" busy={false}
            harnessId="muster-core" chatStatus={{ modelLabel, modelPickerTarget: { sessionId: 'fixture-worker' },
              onModelConfiguration: async change => {
                fixture.modelChanges.push(change); setModelLabel(change.model?.modelId ?? '账户 A · Swift Model');
                return { ok: true, applied: 'next-turn' };
              } }}
            onClear={async () => {}} onSend={async text => { fixture.sent.push(text); return true; }} />}
      </div>
      <NewTaskDialog open={task} workspace={workspace} runtimes={pickerRuntimes as AgentRuntimeEntry[]} onClose={() => setTask(false)}
        onDelegate={async () => { fixture.taskStarts++; return { notified: false }; }} onBlankSession={async () => { fixture.taskStarts++; }} />
    </main>
  </StoreProvider></KeybindingProvider>;
}

createRoot(document.getElementById('root')!).render(<App />);
