import { execFileSync } from 'node:child_process';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
execFileSync(process.execPath, [
  '.agents/skills/ui-verification/scripts/capture-component.mjs',
  '--fixture', 'test/fixtures/extensions-toolbar.tsx',
  '--scenario', 'test/fixtures/extensions-toolbar-scenario.mjs',
  '--out', '.tmp/ui-captures/extensions-toolbar',
  '--themes', 'light,dark', '--widths', '780,390',
  '--styles', 'base,chrome,ext', '--target', '.toolbar-extension-fixture'
], { cwd: root, stdio: 'inherit', timeout: 60_000 });
