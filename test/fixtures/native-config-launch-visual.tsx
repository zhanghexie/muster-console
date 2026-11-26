import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/renderer/src/i18n';
import { KeybindingProvider } from '../../src/renderer/src/keybindings/KeybindingHost';
import { NativeConfigLaunchFields } from '../../src/renderer/src/components/NativeSessionConfig';
import { HarnessModelPicker } from '../../src/renderer/src/components/HarnessModelPicker';
import { applyTheme } from '../../src/renderer/src/theme';
import { builtinTheme } from '../../src/shared/theme';
import type { NativeConfigIntent, NativeConfigSnapshot } from '../../src/shared/nativeSessionConfig';
import type { HarnessPickerChoice, HarnessPickerRequest, HarnessPickerResult } from '../../src/shared/harnessPicker';

const theme = new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark';
applyTheme(builtinTheme(theme)!);
const source = { workspaceId: 'fixture', rootId: 'root' };
const choices: HarnessPickerChoice[] = [
  { harnessId: 'claude', runtimeId: 'claude', surface: 'gui', label: 'Claude Code', available: true, status: 'available' },
  { harnessId: 'codebuddy-cli', runtimeId: 'acp', acpPresetId: 'codebuddy-cli', surface: 'gui', label: 'CodeBuddy Code', available: true, status: 'available' }
];
function catalog(runtimeId: string): NativeConfigSnapshot {
  const snapshot: NativeConfigSnapshot = { identity: { runtimeId, sourceKey: 'fixture', ...(runtimeId === 'acp' ? { presetId: 'codebuddy-cli' } : {}) },
    revision: 1, status: 'ready', source: 'catalog', options: [{
      id: 'permissionMode', name: 'Permission Mode', category: 'permissions', type: 'select', changePolicy: 'live',
      description: 'Controls how the agent requests permission before making changes',
      choices: [{ value: 'default', name: 'Always Ask', description: 'Prompts for permission on first use of each tool' },
        { value: 'acceptEdits', name: 'Accept Edits' }, { value: 'plan', name: 'Plan' }, { value: 'auto', name: 'Auto' }]
    }] };
  if (runtimeId === 'acp') snapshot.options.push(
    { id: 'sandbox', name: 'Sandbox', type: 'select', changePolicy: 'live', choices: [{ value: 'local', name: 'Local Environment' }] },
    { id: 'multitask', name: 'Multitask', type: 'boolean', changePolicy: 'live' }
  );
  return snapshot;
}
Object.defineProperty(window, 'api', { value: { on: () => () => {}, config: { get: async () => ({}) }, agentSession: {
  describeNativeConfig: async ({ runtimeId }: { runtimeId: string }) => catalog(runtimeId),
  listHarnessPickerChoices: async () => ({ choices, checkedAt: 1 }),
  readHarnessPickerCatalog: async (request: HarnessPickerRequest): Promise<HarnessPickerResult> => 'harness' in request ? { ok: true, catalog: {
    harness: request.harness, source: { ...source, rootsRevision: 1, cwd: '/fixture' }, models: [], defaultModel: null,
    state: 'unsupported', parameterState: 'ready', canRefresh: false
  } } : { ok: false, error: 'Expected a launch picker request' },
  cancelHarnessModels: async () => ({ ok: true })
} } });

function App() {
  const [harness, setHarness] = useState(choices[0]);
  const [picking, setPicking] = useState(false);
  const [selection, setSelection] = useState<NativeConfigIntent>();
  return <KeybindingProvider><main style={{ padding: 16, minHeight: '100vh', background: 'var(--bg-panel)', boxSizing: 'border-box' }}>
    {/* Production form containers and controls; IPC supplies deterministic native catalogs. */}
    <section className="new-task-dialog"><div className="new-task-content">
      <div className="new-task-row"><div className="new-task-field">
        <label>Harness 和模型</label>
        <button className="c-select-trigger new-task-harness-trigger" type="button" aria-label="选择 Harness 和模型"
          aria-haspopup="dialog" aria-expanded={picking} onClick={() => setPicking(value => !value)}>{harness.label}</button>
      </div></div>
      {picking ? <div role="dialog" aria-label="选择 Harness 和模型"><HarnessModelPicker target={{ source, surface: 'gui' }}
        initial={{ harness, model: null }} confirmLabel="确认配置" onCancel={() => setPicking(false)} onConfirm={picked => {
          const next = choices.find(item => item.harnessId === picked.harness.harnessId);
          if (!next) return { ok: false };
          setHarness(next); setSelection(undefined); setPicking(false);
          return { ok: true };
        }} /></div> : null}
      <NativeConfigLaunchFields target={{ runtimeId: harness.runtimeId, ...(harness.acpPresetId ? { presetId: harness.acpPresetId } : {}), source }}
        selection={selection} onChange={setSelection} />
    </div></section>
  </main></KeybindingProvider>;
}
const root = createRoot(document.getElementById('root')!);
root.render(<div className="new-task-dialog" />);
Object.assign(window, { __mountNativeConfigLaunch: () => root.render(<App />) });
