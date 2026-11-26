import '../../.agents/skills/ui-verification/assets/fixture-api';
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/renderer/src/i18n';
import { StoreProvider } from '../../src/renderer/src/store';
import { AgentComposer } from '../../src/renderer/src/components/AgentComposer';
import { AttachmentPolicyFields } from '../../src/renderer/src/components/settings/AttachmentPolicyFields';
import { applyTheme } from '../../src/renderer/src/theme';
import { builtinTheme } from '../../src/shared/theme';
const fixtureApi = window.api;
window.api = new Proxy(fixtureApi, { get(target, key) {
  if (key !== 'shell') return Reflect.get(target, key);
  return new Proxy(target.shell, { get(shell, method) {
    if (method === 'pathForFile') return () => '';
    if (method === 'clipboardFiles') return async () => [];
    return Reflect.get(shell, method);
  } });
} });
const theme = new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark';
applyTheme(builtinTheme(theme)!);
function App() {
  const [policy, setPolicy] = React.useState({});
  return <StoreProvider><main style={{ padding: 16, background: 'var(--bg-panel)', minHeight: '100vh' }}>
    <AgentComposer workspaceId="attachment-fixture" surfaceKind="gui-session" busy={false} onSend={async () => false} />
    <div style={{ marginTop: 24, maxWidth: 520 }}><AttachmentPolicyFields value={policy} onChange={setPolicy} /></div>
  </main></StoreProvider>;
}
createRoot(document.getElementById('root')!).render(<App />);
