import './fixture-api';
import React from 'react';
import { readSelectionUi } from '../../../src/renderer/src/components/selectionMenuController';
(window as any).__terminalSelection = () => readSelectionUi().menu;
import { createRoot } from 'react-dom/client';
import '../../../src/renderer/src/i18n';
import { StoreProvider } from '../../../src/renderer/src/store';
import { TerminalView } from '../../../src/renderer/src/components/TerminalView';
import { AppConfirmDialog } from '../../../src/renderer/src/components/AppConfirmDialog';
import { KeybindingProvider } from '../../../src/renderer/src/keybindings/KeybindingHost';
import { applyTheme } from '../../../src/renderer/src/theme';
import { builtinTheme } from '../../../src/shared/theme';
applyTheme(builtinTheme(new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark')!);
createRoot(document.getElementById('root')!).render(<StoreProvider><KeybindingProvider>
  <AppConfirmDialog open={false} title="Closed background dialog" onConfirm={() => {}} onCancel={() => {}} />
  <main style={{ padding: 16 }}><h2>Terminal Esc keyboard regression</h2>
    <p>Two production TerminalView instances; PTY IPC recorded locally.</p>
    <section data-terminal="a" style={{position:'relative',height:250}}><TerminalView sessionId="a" visible /></section>
    <section data-terminal="b" style={{position:'relative',height:250}}><TerminalView sessionId="b" visible /></section>
  </main>
</KeybindingProvider></StoreProvider>);
