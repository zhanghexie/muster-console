/** Real sidebar component: idle, hover, keyboard focus, details and archive at two widths/themes. */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const result = spawnSync(process.execPath, [
  '.agents/skills/ui-verification/scripts/capture-component.mjs',
  '--fixture', 'test/fixtures/sidebar-stack.tsx',
  '--scenario', 'test/fixtures/session-harness-rail-scenario.mjs',
  '--target', '.left-panel', '--styles', 'base,side,float,left,extension-navigation',
  '--themes', 'dark,light', '--widths', '780,390', '--height', '700',
  '--allow-fallback-font', '--out', '.tmp/ui-captures/session-harness-regression'
], { cwd: root, stdio: 'inherit', windowsHide: true, timeout: 120000 });
if (result.error) console.error(result.error);
process.exitCode = result.status === 0 ? 0 : 1;
