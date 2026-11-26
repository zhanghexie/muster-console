/** Production General settings: width, flat groups, separators, responsive dialog and focus restoration. */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const result = spawnSync(process.execPath, [
  '.agents/skills/ui-verification/scripts/capture-component.mjs',
  '--fixture', 'test/fixtures/settings-general/fixture.tsx',
  '--scenario', 'test/fixtures/settings-general/scenario.mjs',
  '--out', '.tmp/ui-captures/general-settings-final-20261031',
  '--themes', 'light,dark', '--widths', '1040,390', '--height', '1020',
  '--styles', 'base,settings,dialogs', '--target', '.settings-col'
], { cwd: root, stdio: 'inherit', windowsHide: true });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
