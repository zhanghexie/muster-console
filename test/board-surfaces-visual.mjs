/** Production GlobalBoard and theme resolver; mocked IPC, no private app data. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireTestLease } from './helpers/lease.mjs';
import { execute } from './helpers/execute.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const release = acquireTestLease(root);
try {
  const result = await execute(process.execPath, [
    '.agents/skills/ui-verification/scripts/capture-component.mjs',
    '--fixture', 'test/fixtures/board-surfaces/fixture.tsx',
    '--scenario', 'test/fixtures/board-surfaces/scenario.mjs',
    '--styles', 'base,chrome,tasks,board,chat,markdown,float,agent-chat,side,left,split,responsive,material',
    '--target', '.app-shell', '--themes', 'light,dark', '--widths', '1920,780',
    '--height', '960', '--out', '.tmp/ui-captures/board-surfaces'
  ], { cwd: root, env: process.env, timeoutMs: 55_000 });
  process.stdout.write(result.out);
  if (result.timedOut) throw new Error('Board surface verification timed out; incomplete.');
  process.exitCode = result.code;
} finally { release(); }
