import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, '.tmp/native-material-demo/renderer');
await fs.mkdir(output, { recursive: true });
await build({ absWorkingDir: root, entryPoints: ['docs/prototypes/native-material-demo/entry.tsx'],
  bundle: true, outdir: output, entryNames: 'app', format: 'iife', jsx: 'automatic', minify: true,
  define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.woff2': 'file', '.ttf': 'file', '.png': 'file' } });
// The native material study stays offline; use the existing system font fallback.
const cssPath = path.join(output, 'app.css');
await fs.writeFile(cssPath, (await fs.readFile(cssPath, 'utf8')).replace(/@font-face\s*\{[^}]*\}/g, ''));
await fs.writeFile(path.join(output, 'index.html'), `<!doctype html><html lang="zh-CN" data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'"><title>MetaAgent · 原生侧栏材质小样</title><link rel="stylesheet" href="app.css"></head><body><div id="root"></div><script src="app.js"></script></body></html>`);
console.log(`Built native material prototype: ${output}`);
if (!process.argv.includes('--build-only')) {
  const require = createRequire(import.meta.url);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const logPath = path.join(root, '.tmp/native-material-demo/window.log');
  const log = await fs.open(logPath, 'a');
  const child = spawn(require('electron'), [path.join(root, 'docs/prototypes/native-material-demo/main.cjs')],
    { cwd: root, env, detached: true, windowsHide: true, stdio: ['ignore', log.fd, log.fd] });
  child.unref();
  await log.close();
  const started = await new Promise((resolve, reject) => {
    child.once('error', reject);
    const deadline = Date.now() + 10_000;
    const check = async () => {
      try {
        const ready = JSON.parse(await fs.readFile(path.join(root, '.tmp/native-material-demo/ready.json'), 'utf8'));
        process.kill(ready.pid, 0);
        resolve(ready); return;
      } catch { /* Wait for the native window readiness marker. */ }
      if (Date.now() >= deadline) reject(new Error(`小样窗口没有就绪，请查看 ${logPath}`));
      else setTimeout(check, 150);
    };
    void check();
  });
  console.log(`Native material window ready (PID ${started.pid}, ${started.state.material}, ${started.state.osVersion}).`);
}
