/** Production Board + Chromium pixel regression: colorful must not render as a white streak. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireTestLease } from './helpers/lease.mjs';
import { execute } from './helpers/execute.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const release = acquireTestLease(root);
try {
  const result = await execute(process.execPath, [
    '.agents/skills/ui-verification/scripts/capture-component.mjs',
    '--fixture', 'test/fixtures/board-beam-color/fixture.tsx',
    '--scenario', 'test/fixtures/board-beam-color/scenario.mjs',
    '--styles', 'base,chrome,board,chat,markdown,float,agent-chat,side,left,split',
    '--target', '.app-shell', '--themes', 'light,dark', '--widths', '1440,780',
    '--height', '600', '--out', '.tmp/ui-captures/board-beam-color'
  ], { cwd: root, env: process.env, timeoutMs: 55_000 });
  process.stdout.write(result.out);
  if (result.timedOut) throw new Error('Beam color verification timed out; incomplete.');
  process.exitCode = result.code;
} finally { release(); }
