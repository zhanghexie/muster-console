/** Production composer geometry, themes and narrow containers in Chromium. */
import { spawnSync } from 'node:child_process';
const result = spawnSync(process.execPath, [
  '.agents/skills/ui-verification/scripts/capture-component.mjs',
  '--fixture', 'test/fixtures/composer-toolbar-sizing.tsx',
  '--scenario', 'test/fixtures/composer-toolbar-sizing-scenario.mjs',
  '--target', '.chat-input-shell', '--out', '.tmp/ui-captures/composer-toolbar-sizing',
  '--themes', 'light,dark', '--widths', '780,390,320', '--height', '320'
], { stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
