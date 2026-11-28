/** Reopen the production model pickers and check group hierarchy and keyboard selection. */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const result = spawnSync(process.execPath, [
  '.agents/skills/ui-verification/scripts/capture-component.mjs',
  '--fixture', 'test/fixtures/worker-routing-visual.tsx',
  '--scenario', 'test/fixtures/unified-harness-picker-scenario.mjs',
  '--target', '.worker-routing-fixture',
  '--styles', 'base,float,agent-chat,markdown,dialogs,chat,harness,settings,tasks,model-picker,responsive,material,keyboard-focus',
  '--height', '760',
  '--out', '.tmp/ui-captures/harness-model-provider-trailing-divider-regression'
], { cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: 'inherit' });

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
