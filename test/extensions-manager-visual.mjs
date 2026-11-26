import { execFileSync } from 'node:child_process';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
execFileSync(process.execPath, [
  '.agents/skills/ui-verification/scripts/capture-component.mjs',
  '--fixture', 'test/fixtures/extensions-manager.tsx',
  '--scenario', 'test/fixtures/extensions-manager-scenario.mjs',
  '--out', '.tmp/ui-captures/extensions-manager',
  '--themes', 'light,dark', '--widths', '780,390',
  '--styles', 'base,ext,tasks', '--target', '.ext-extension-manager'
], { cwd: root, stdio: 'inherit', timeout: 60_000 });
