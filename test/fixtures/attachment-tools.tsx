import '../../.agents/skills/ui-verification/assets/fixture-api';
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/renderer/src/i18n';
import { AttachmentToolsSettings } from '../../src/renderer/src/components/settings/AttachmentToolsSettings';
import { AttachmentProcessingSettings } from '../../src/renderer/src/components/settings/AttachmentProcessingSettings';
import { applyTheme } from '../../src/renderer/src/theme';
import { builtinTheme } from '../../src/shared/theme';
applyTheme(builtinTheme(new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark')!);
function App() {
  const [tools, setTools] = React.useState({});
  const [processing, setProcessing] = React.useState({});
  return <main style={{ padding: 16, minHeight: '100vh', background: 'var(--bg-panel)' }}>
    <AttachmentToolsSettings value={tools} onChange={setTools} />
    <AttachmentProcessingSettings value={processing} onChange={setProcessing} />
  </main>;
}
createRoot(document.getElementById('root')!).render(<App />);
