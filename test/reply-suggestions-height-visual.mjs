/** Real Chromium regression for suggestion dismissal and composer height. */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const result = spawnSync(process.execPath, [
  '.agents/skills/ui-verification/scripts/capture-component.mjs',
  '--fixture', 'test/fixtures/reply-suggestions-height.tsx',
  '--scenario', 'test/fixtures/reply-suggestions-height-scenario.mjs',
  '--target', '.chat-input-shell', '--out', '.tmp/ui-captures/reply-suggestions-height',
  '--themes', 'light,dark', '--widths', '780,390'
], {cwd:root, stdio:'inherit'});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
