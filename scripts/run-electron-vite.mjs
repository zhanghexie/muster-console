/**
 * 启动 electron-vite dev，并保证：
 * 1) 先清掉残留的 5188；
 * 2) 本脚本退出时 taskkill 整棵子进程树（Windows 关终端不会自动带走 node）。
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freeDevPorts, rendererDevPort } from './free-dev-port.mjs';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(path.dirname(require.resolve('electron-vite/package.json')), 'bin', 'electron-vite.js');

/**
 * electron-vite's dev build can start Electron before the main-process asset
 * copy hook has run. Seed the runtime registry before spawning the app so a
 * cold dev start never races `RuntimeHost.ensureSeeded()`.
 */
export function copyRuntimeBuiltins(sourceDir, destinationDir) {
  const registry = path.join(sourceDir, 'registry.json');
  const scriptsDir = path.join(sourceDir, 'scripts');
  if (!fs.existsSync(registry) || !fs.existsSync(scriptsDir)) {
    throw new Error(`Runtime builtins are incomplete: ${sourceDir}`);
  }
  fs.mkdirSync(path.join(destinationDir, 'scripts'), { recursive: true });
  fs.copyFileSync(registry, path.join(destinationDir, 'registry.json'));
  for (const name of fs.readdirSync(scriptsDir)) {
    if (name.endsWith('.mjs')) fs.copyFileSync(path.join(scriptsDir, name), path.join(destinationDir, 'scripts', name));
  }
}

function ensureDevRuntimeBuiltins() {
  copyRuntimeBuiltins(
    path.join(root, 'src/main/runtime/builtins'),
    path.join(root, 'out/main/runtime/builtins')
  );
}

function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
      detached: true
    }).unref();
    return;
  }
  // POSIX：dev 以 detached 拉起自成进程组，负 pid 连 Electron 孙进程一起带走
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* gone */
    }
  }
}

export async function runElectronVite() {
  freeDevPorts([rendererDevPort()]);
  ensureDevRuntimeBuiltins();

  const child = spawn(process.execPath, [cli, 'dev', ...process.argv.slice(2)], {
    stdio: 'inherit',
    cwd: root,
    env: process.env,
    detached: process.platform !== 'win32',
    windowsHide: false
  });

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    killTree(child.pid);
  };

  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.on('SIGHUP', stop);
  process.on('exit', stop);

  child.on('exit', (code, signal) => {
    stopping = true;
    if (signal) process.exit(1);
    process.exit(code ?? 0);
  });
}
