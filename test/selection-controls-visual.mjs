// Real Chromium drag-selection regression using production components and CSS.
import { spawnSync } from 'node:child_process';
const result = spawnSync(process.execPath, [
  '.agents/skills/ui-verification/scripts/capture-component.mjs',
  '--fixture', 'test/fixtures/selection-controls.tsx',
  '--scenario', 'test/fixtures/selection-controls-scenario.mjs',
  '--out', '.tmp/ui-captures/selection-controls',
  '--styles', 'base,chrome,float,left,extension-navigation',
  '--target', '.left-panel', '--themes', 'dark,light', '--widths', '780,390',
  '--allow-fallback-font'
], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
