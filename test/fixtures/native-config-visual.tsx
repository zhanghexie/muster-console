import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/renderer/src/i18n';
import { KeybindingProvider } from '../../src/renderer/src/keybindings/KeybindingHost';
import { NativeSessionConfigControl } from '../../src/renderer/src/components/NativeSessionConfig';
import { ApprovalCard } from '../../src/renderer/src/chatSurface/guiApprovalCards';
import { applyTheme } from '../../src/renderer/src/theme';
import { builtinTheme } from '../../src/shared/theme';
import type { NativeConfigSnapshot } from '../../src/shared/nativeSessionConfig';

const theme = new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark';
applyTheme(builtinTheme(theme)!);
const snapshot: NativeConfigSnapshot = { identity: { runtimeId: 'acp', sourceKey: 'fixture', presetId: 'architect' },
  revision: 1, status: 'ready', source: 'session', options: [
    { id: 'mode', name: 'Workspace operating mode', description: 'Select how the engine approaches the next operation.', category: 'mode',
      type: 'select', changePolicy: 'live', currentValue: 'architecture', choices: [{ id: 'workspace', name: 'Workspace modes', choices: [
        { value: 'architecture', name: 'Architecture review and exploration' },
        { value: 'implementation', name: 'Implementation', description: 'The engine uses its native permission rules for edits.' }
      ] }] },
    { id: 'review', name: 'Review approvals', type: 'boolean', changePolicy: 'idle', currentValue: true },
    { id: 'sandbox', name: 'Sandbox boundary', type: 'select', changePolicy: 'read-only', currentValue: 'workspace' }
  ] };

Object.defineProperty(window, 'api', { value: { on: () => () => {}, config: { get: async () => ({}) }, agentSession: {
  getNativeConfig: async () => snapshot, refreshNativeConfig: async () => snapshot,
  setNativeConfig: async () => ({ ok: true, snapshot }), respondApproval: async () => ({ ok: true })
} } });

createRoot(document.getElementById('root')!).render(<KeybindingProvider>
  <main className="native-config-fixture" style={{ minHeight: '100vh', padding: 16, background: 'var(--bg-panel)', display: 'grid',
    gridTemplateRows: '1fr auto', alignItems: 'start', boxSizing: 'border-box' }}>
    <ApprovalCard sessionId="fixture" approval={{ approvalId: 'fixture', toolCallId: 'op-1', toolName: 'Apply native migration',
      reason: 'This change affects generated files under the current workspace.', input: { path: 'src/settings.ts' }, nativeSource: 'ACP',
      nativeChoices: [
        { id: 'once', name: 'Allow once', kind: 'allow_once', scope: 'once' },
        { id: 'session', name: 'Allow for this workspace', kind: 'allow_always', scope: 'persistent' },
        { id: 'deny', name: 'Deny once', kind: 'reject_once', scope: 'once' }
      ] }} />
    <div className="agent-composer-toolbar"><NativeSessionConfigControl sessionId="fixture" busy={false} /></div>
  </main>
</KeybindingProvider>);
