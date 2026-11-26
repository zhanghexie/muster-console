import './permission-panel-api';
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/renderer/src/i18n';
import { StoreProvider } from '../../src/renderer/src/store';
import { KeybindingProvider } from '../../src/renderer/src/keybindings/KeybindingHost';
import { AgentComposer } from '../../src/renderer/src/components/AgentComposer';
import { NativeSessionConfigControl } from '../../src/renderer/src/components/NativeSessionConfig';
import { useSessionPermissionConfiguration } from '../../src/renderer/src/components/PermissionConfiguration';
import { AppTipHost } from '../../src/renderer/src/components/AppTip';
import { guiPermissionOptions } from '../../src/shared/guiPermissionOptions';
import type { GuiWorkerMode } from '../../src/shared/types';
import { applyTheme } from '../../src/renderer/src/theme';
import { builtinTheme } from '../../src/shared/theme';

applyTheme(builtinTheme(new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark')!);
function Composer({ native }: { native: boolean }) {
  const state = useSessionPermissionConfiguration(native ? 'native-fixture' : 'core-fixture', false);
  const configuration = { enabled: state.enabled, disabled: state.saving, onChange: (value: boolean) => void state.change(value) };
  const [mode, setMode] = useState<GuiWorkerMode>('standard');
  const options = guiPermissionOptions('pi');
  return <AgentComposer surfaceKind="gui-session" busy={false} placeholder="输入消息…" onSend={async () => true} onClear={async () => {}}
    mode={state.enabled ? mode : 'auto'} modeOrder={options.map(option => option.mode)}
    modeChipLabels={Object.fromEntries(options.map(option => [option.mode, option.label]))}
    modeDescriptions={Object.fromEntries(options.map(option => [option.mode, option.description]))}
    onModeChange={!native && state.enabled ? setMode : undefined} permissionConfiguration={!native ? configuration : undefined}
    nativeSettings={native ? <NativeSessionConfigControl sessionId="native-fixture" busy={false} configuration={configuration} /> : undefined} />;
}
function App() {
  const [native, setNative] = useState(false);
  Object.assign(window, { __setNativeFixture: setNative });
  return <StoreProvider><KeybindingProvider>
    <main style={{ display: 'flex', flexDirection: 'column', justifyContent: 'end', padding: 20, height: '100vh', boxSizing: 'border-box', background: 'var(--bg-panel)' }}>
      <Composer key={String(native)} native={native} />
    </main><AppTipHost />
  </KeybindingProvider></StoreProvider>;
}
createRoot(document.getElementById('root')!).render(<App />);
