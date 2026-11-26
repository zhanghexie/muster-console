/** Chromium regression for single-line streamed thinking and line wrapping. */
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
execFileSync(process.execPath, [
  '.agents/skills/ui-verification/scripts/capture-component.mjs',
  '--fixture', 'test/fixtures/thinking-live.tsx',
  '--scenario', 'test/fixtures/thinking-live-scenario.mjs',
  '--out', '.tmp/ui-captures/thinking-live',
  '--themes', 'light,dark', '--widths', '780,390',
  '--styles', 'base,chat,markdown,agent-chat,float', '--target', 'main'
], { cwd: root, stdio: 'inherit', timeout: 60_000 });
