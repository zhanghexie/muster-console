/** Production navigation and shared focus styles, exercised with real keyboard input. */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const result = spawnSync(process.execPath, [
  '.agents/skills/ui-verification/scripts/capture-component.mjs',
  '--fixture', 'test/fixtures/keyboard-focus-visual.tsx',
  '--scenario', 'test/fixtures/keyboard-focus-visual-scenario.mjs',
  '--target', '.ext-nav-tree', '--styles', 'base,extension-navigation,keyboard-focus',
  '--out', '.tmp/ui-captures/keyboard-focus', '--themes', 'light,dark', '--widths', '780,390'
], {cwd:root, stdio:'inherit'});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
