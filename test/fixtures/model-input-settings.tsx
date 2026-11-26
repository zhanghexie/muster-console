import '../../.agents/skills/ui-verification/assets/fixture-api';
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/renderer/src/i18n';
import { ModelProviderPane } from '../../src/renderer/src/components/settings/ModelProviderPane';
import { KeybindingProvider } from '../../src/renderer/src/keybindings/KeybindingHost';
import type { AppConfig } from '../../src/shared/types';
import { applyTheme } from '../../src/renderer/src/theme';
import { builtinTheme } from '../../src/shared/theme';
applyTheme(builtinTheme(new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark')!);
function App() {
  const [cfg, setCfg] = React.useState({ openai: { baseUrl: 'https://api.example.test', apiKey: '', model: 'example' } } as AppConfig);
  return <KeybindingProvider><main style={{ padding: 16, height: '100vh', boxSizing: 'border-box', background: 'var(--bg-panel)' }}>
    <ModelProviderPane cfg={cfg} set={patch => setCfg(prev => ({ ...prev, ...patch }))} />
  </main></KeybindingProvider>;
}
createRoot(document.getElementById('root')!).render(<App />);
