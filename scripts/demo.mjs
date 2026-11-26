import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
if (!fs.existsSync(path.join(root, 'out/main/demo.js')) || !fs.existsSync(path.join(root, 'out/renderer/demo-replay.html'))) {
  const vite = path.join(path.dirname(require.resolve('electron-vite/package.json')), 'bin/electron-vite.js');
  const build = spawnSync(process.execPath, [vite, 'build'], { cwd: root, stdio: 'inherit' });
  if (build.error) throw build.error;
  if (build.status !== 0) process.exit(build.status ?? 1);
}
const result = spawnSync(require('electron'), [root, ...process.argv.slice(2)], { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
