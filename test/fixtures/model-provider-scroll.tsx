/** Real provider settings with local fixture data; no real configuration or IPC. */
import '../../.agents/skills/ui-verification/assets/fixture-api';
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/renderer/src/i18n';
import { ModelProviderPane } from '../../src/renderer/src/components/settings/ModelProviderPane';
import { KeybindingProvider } from '../../src/renderer/src/keybindings/KeybindingHost';
import type { AppConfig } from '../../src/shared/types';

function App(): React.JSX.Element {
  const [cfg, setCfg] = React.useState({
    defaultRuntime: 'pi', workspaces: [], openai: { baseUrl: '', apiKey: '', model: '' },
    llm: { activeProviderId: 'example', activeModelId: 'model-0', providers: [{
      id: 'example', name: '示例供应商', enabled: true, baseUrl: 'https://example.test/v1', apiKey: '',
      models: Array.from({ length: 30 }, (_, index) => ({ id: `model-${index}`, name: `Model ${index}` }))
    }] }
  } as unknown as AppConfig);
  return <KeybindingProvider><div className="settings-page"><nav/><main style={{ minWidth: 0, padding: '16px 40px', overflowY: 'auto' }}>
    <ModelProviderPane cfg={cfg} set={patch => setCfg(previous => ({ ...previous, ...patch }))}/>
  </main></div></KeybindingProvider>;
}
createRoot(document.getElementById('root')!).render(<App/>);
