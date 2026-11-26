/** Real Chromium regression for required and optional storage cleanup. */
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
execFileSync(process.execPath, [
  '.agents/skills/ui-verification/scripts/capture-component.mjs',
  '--fixture', 'test/fixtures/local-storage-settings.tsx',
  '--scenario', 'test/fixtures/local-storage-dependencies-scenario.mjs',
  '--out', '.tmp/ui-captures/local-storage-dependencies',
  '--themes', 'dark,light', '--widths', '1100,390', '--height', '640',
  '--styles', 'base,dialogs,settings,float,responsive', '--target', '.local-storage', '--show-scrollbars'
], { cwd: root, stdio: 'inherit', windowsHide: true, timeout: 60_000 });
