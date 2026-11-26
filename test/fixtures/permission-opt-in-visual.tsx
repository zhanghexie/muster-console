import { fixture, runtimes, workspace } from './permission-opt-in-api';
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/renderer/src/i18n';
import { KeybindingProvider } from '../../src/renderer/src/keybindings/KeybindingHost';
import { NewTaskDialog } from '../../src/renderer/src/components/NewTaskDialog';
import { StoreProvider } from '../../src/renderer/src/store';
import { applyTheme } from '../../src/renderer/src/theme';
import { builtinTheme } from '../../src/shared/theme';

applyTheme(builtinTheme(new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark')!);
const root = createRoot(document.getElementById('root')!);
root.render(<main className="new-task-dialog" style={{ minHeight: '100vh', background: 'var(--bg-panel)' }} />);
Object.assign(window, { __mountPermissionFixture: () => root.render(<StoreProvider><KeybindingProvider>
  <NewTaskDialog open workspace={workspace} runtimes={runtimes} initialTask="整理项目文档并检查构建结果。" onClose={() => {}}
    onDelegate={async value => { fixture.starts.push(value); return { notified: false }; }}
    onBlankSession={async (_runtime, _name, advanced) => { fixture.starts.push(advanced); }} />
</KeybindingProvider></StoreProvider>) });
