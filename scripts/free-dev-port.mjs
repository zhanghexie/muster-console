/**
 * 释放本仓库 electron-vite 开发服占用的端口。
 * Windows 关窗口 / 关终端经常留下 node 占着 5188，下次 npm run dev 报 Port already in use。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function rendererDevPort() {
  const n = Number(process.env.ELECTRON_RENDERER_PORT);
  return Number.isFinite(n) && n > 0 ? n : 5188;
}

/** 从 netstat -ano 文本里抽出某端口 LISTENING 的 PID（避免 :5188 误配 :51880） */
export function parseListeningPids(netstatOut, port) {
  const pids = new Set();
  const re = new RegExp(`:${port}(?!\\d)`);
  for (const line of String(netstatOut).split(/\r?\n/)) {
    if (!re.test(line) || !/LISTENING/i.test(line)) continue;
    const m = line.trim().match(/(\d+)\s*$/);
    if (m && m[1] !== '0') pids.add(Number(m[1]));
  }
  return [...pids];
}

function netstatAno() {
  try {
    return execFileSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true });
  } catch {
    return '';
  }
}

/** lsof -t 输出（PID 一行一个）→ PID 列表 */
export function parseLsofPids(out) {
  return String(out || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^\d+$/.test(l))
    .map(Number);
}

function commandLineOf(pid) {
  if (process.platform !== 'win32') {
    try {
      return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], {
        encoding: 'utf-8',
        timeout: 4000
      }).trim();
    } catch {
      return '';
    }
  }
  try {
    const out = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`
      ],
      { encoding: 'utf-8', timeout: 8000, windowsHide: true }
    );
    return String(out).trim();
  } catch {
    return '';
  }
}

/** 只杀本仓库 electron-vite / 本机 node 占着的开发服，不动 Cursor 等其它进程 */
export function shouldKillDevListener(cmd, pid) {
  if (!pid || pid === process.pid) return false;
  const c = String(cmd || '');
  if (!c) return true;
  const repo = root.replace(/\\/g, '/').toLowerCase();
  const cl = c.replace(/\\/g, '/').toLowerCase();
  if (cl.includes(repo) && (cl.includes('electron-vite') || cl.includes('vite'))) return true;
  if (cl.includes('electron-vite') && cl.includes('dev')) return true;
  return false;
}

function killPidTree(pid) {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    /* gone */
  }
}

export function freeDevPorts(ports = [rendererDevPort()]) {
  const killed = [];
  const win = process.platform === 'win32';
  const table = win ? netstatAno() : '';
  for (const port of ports) {
    // Windows：netstat 全表再过滤；POSIX：lsof 直查监听 PID
    const pids = win
      ? parseListeningPids(table, port)
      : lsofListeningPids(port);
    for (const pid of pids) {
      const cmd = commandLineOf(pid);
      if (!shouldKillDevListener(cmd, pid)) continue;
      console.log(`[dev] 释放端口 ${port}（残留 PID ${pid}）`);
      killPidTree(pid);
      killed.push(pid);
    }
  }
  return { killed };
}

function lsofListeningPids(port) {
  try {
    return parseLsofPids(
      execFileSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf-8' })
    );
  } catch {
    return [];
  }
}
