/** Real Chromium checks for conversation activity indicators and reduced motion. */
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
execFileSync(process.execPath, [
  '.agents/skills/ui-verification/scripts/capture-component.mjs',
  '--fixture', 'test/fixtures/activity-indicators.tsx',
  '--scenario', 'test/fixtures/activity-indicators-scenario.mjs',
  '--out', '.tmp/ui-captures/activity-indicators-regression',
  '--themes', 'light,dark', '--widths', '780,390',
  '--styles', 'base,chat,markdown,agent-chat,float', '--target', 'main'
], { cwd: root, stdio: 'inherit', timeout: 60_000 });
