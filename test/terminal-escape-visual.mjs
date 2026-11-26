/** Real TerminalView + xterm + Chromium keys; mocked PTY IPC, no model or native PTY. */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { acquireTestLease } from './helpers/lease.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const release = acquireTestLease(root);
try {
  const result = spawnSync(process.execPath, [
    '.agents/skills/ui-verification/scripts/capture-component.mjs',
    '--fixture', 'test/fixtures/terminal-escape/fixture.tsx',
    '--scenario', 'test/fixtures/terminal-escape/scenario.mjs',
    '--out', '.tmp/terminal-escape/captures', '--styles', 'base,terminal',
    '--target', 'main', '--widths', '780,390', '--height', '780', '--allow-fallback-font'
  ], { cwd: root, stdio: 'inherit', timeout: 55_000 });
  if (result.error) console.error(result.error.message);
  process.exitCode = result.status === 0 ? 0 : 1;
} finally { release(); }
