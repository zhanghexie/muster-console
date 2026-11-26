/** Production Chromium: host cancellation, keyboard safety, next request and viewport fit. */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
execFileSync(process.execPath, [
  '.agents/skills/ui-verification/scripts/capture-component.mjs',
  '--fixture', 'test/fixtures/extension-ui-dialog-cancel-visual.tsx',
  '--scenario', 'test/fixtures/extension-ui-dialog-cancel-visual-scenario.mjs',
  '--out', '.tmp/ui-captures/dialog-cancel-fixed',
  '--themes', 'light,dark', '--widths', '780,390',
  '--styles', 'base,dialogs,ext', '--target', '.dialog-fixture'
], { cwd: root, stdio: 'inherit', timeout: 60_000 });
