import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { wrapWinCmd } from './_helpers.mjs';

export const deferred = reason => ({ status: 'deferred', reason });
export const unsupported = reason => ({ status: 'unsupported', reason });
export const accepted = method => ({ status: 'accepted', method });
export const current = input => !input.signal.aborted && input.isCurrent();
export const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

/** The dev Electron process inherits npm's node_modules/.bin ahead of user installs.
 * That directory contains transitive SDK CLIs, which must not become terminal runtimes. */
export function findCliOnPath(binary, { platform = process.platform, pathEnv = process.env.PATH ?? '',
  pathExt = process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD', execPath = process.execPath,
  isExecutable = file => {
    try {
      if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) return false;
      fs.accessSync(file, platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
      return true;
    } catch { return false; }
  } } = {}) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  if (paths.isAbsolute(binary)) return isExecutable(binary) ? binary : null;
  if (binary.includes('/') || binary.includes('\\')) return null;
  let appBin = null;
  for (let parent = paths.dirname(execPath); parent !== paths.dirname(parent); parent = paths.dirname(parent)) {
    if (paths.basename(parent).toLowerCase() === 'electron' && paths.basename(paths.dirname(parent)).toLowerCase() === 'node_modules') {
      appBin = paths.join(paths.dirname(parent), '.bin');
      break;
    }
  }
  const equal = (left, right) => platform === 'win32'
    ? paths.resolve(left).toLowerCase() === paths.resolve(right).toLowerCase()
    : paths.resolve(left) === paths.resolve(right);
  const suffixes = platform === 'win32' && !paths.extname(binary)
    ? pathExt.split(';').filter(Boolean).map(suffix => suffix.toLowerCase()) : [''];
  for (const raw of pathEnv.split(platform === 'win32' ? ';' : ':').filter(Boolean)) {
    const directory = raw.replace(/^"|"$/g, '');
    if (appBin && equal(directory, appBin)) continue;
    for (const suffix of suffixes) {
      const candidate = paths.join(directory, binary + suffix);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

/** Keep native Windows executables as direct children (also the MCP identity root).
 * Resolve to one exact file so probes, helper processes and the PTY use the same CLI. */
export function cliLaunch(argv, options) {
  const [binary, ...args] = argv;
  const platform = options?.platform ?? process.platform;
  const executable = findCliOnPath(binary, options);
  if (!executable) {
    const error = new Error(`${binary} was not found outside the workbench dependencies; install it or add it to PATH`);
    error.code = 'CLI_NOT_FOUND';
    throw error;
  }
  return platform === 'win32' && !/\.(exe|com)$/i.test(executable)
    ? wrapWinCmd([executable, ...args], platform)
    : { command: executable, args };
}

export function cliOutput(argv, cwd, timeout = 5000) {
  const launch = cliLaunch(argv);
  return new Promise((resolve, reject) => {
    const child = spawn(launch.command, launch.args, { cwd, windowsHide: true,
      windowsVerbatimArguments: launch.windowsVerbatimArguments === true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const append = data => { output = (output + String(data)).slice(-100_000); };
    child.stdout.on('data', append); child.stderr.on('data', append);
    const timer = setTimeout(() => { child.kill(); reject(new Error('CLI capability probe timed out')); }, timeout);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('exit', code => { clearTimeout(timer); code === 0 ? resolve(output) : reject(new Error(`CLI probe exited ${code}: ${output.slice(-500)}`)); });
  });
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

/** No global daemon or user process is stopped. */
export function spawnOwned(argv, options = {}) {
  const launch = cliLaunch(argv);
  const child = spawn(launch.command, launch.args, {
    windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
    windowsVerbatimArguments: launch.windowsVerbatimArguments === true,
    detached: process.platform !== 'win32', ...options,
  });
  let error;
  let stderr = '';
  child.on('error', value => { error = value; });
  child.stderr?.on('data', data => { stderr = (stderr + data.toString()).slice(-1500); });
  let disposed = false;
  return {
    child,
    assertAlive() {
      if (error) throw error;
      if (child.exitCode !== null) throw new Error(`Native transport exited (${child.exitCode}): ${stderr}`);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (!child.pid || child.exitCode !== null) return;
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => child.kill());
        killer.unref();
      } else {
        try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill(); }
        const timer = setTimeout(() => {
          if (child.exitCode !== null || child.signalCode !== null) return;
          try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
        }, 1500);
        timer.unref();
        child.once('exit', () => clearTimeout(timer));
      }
    },
  };
}

/** Loopback only, explicit auth, bounded response, no automatic replay of mutations. */
export function jsonRequest(url, { method = 'GET', body, headers = {}, signal, timeout = 3000 } = {}) {
  const target = new URL(url);
  if (target.hostname !== '127.0.0.1') throw new Error('Native transport must use loopback');
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const request = http.request(target, {
      method, signal, timeout, headers: { ...headers, ...(payload ? {
        'content-type': 'application/json', 'content-length': String(payload.length),
      } : {}) },
    }, response => {
      const chunks = [];
      let bytes = 0;
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 2_000_000) request.destroy(new Error('Native response too large'));
        else chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (response.statusCode < 200 || response.statusCode >= 300)
          return reject(Object.assign(new Error(`Native HTTP ${response.statusCode} ${target.pathname}`), { httpStatus: response.statusCode }));
        try { resolve(text ? JSON.parse(text) : undefined); } catch (error) { reject(error); }
      });
    });
    request.on('error', reject);
    request.on('timeout', () => request.destroy(Object.assign(new Error(`Native HTTP ${method} ${target.pathname} timeout; admission may be unknown`), { code: 'ETIMEDOUT' })));
    request.end(payload);
  });
}

export function connectRpc(WebSocket, url, token) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` }, handshakeTimeout: 1000 });
    const pending = new Map();
    const listeners = new Set();
    let nextId = 1;
    let opened = false;
    const fail = error => { for (const call of pending.values()) call.reject(error); pending.clear(); };
    socket.on('error', error => { if (!opened) reject(error); fail(error); });
    socket.on('close', () => fail(new Error('Native RPC connection closed; admission may be unknown')));
    socket.on('message', data => {
      let message;
      try { message = JSON.parse(String(data)); } catch { fail(new Error('Invalid native RPC frame')); return; }
      if (message.method) {
        if (message.id === undefined) for (const listener of listeners) listener(message.method, message.params);
        return; // Server requests have an independent ID namespace.
      }
      const call = pending.get(message.id);
      if (!call) return; // Never answer native approvals; the attached TUI owns their UI.
      pending.delete(message.id);
      clearTimeout(call.timer);
      if (message.error) call.reject(Object.assign(new Error(message.error.message), { rpcCode: message.error.code }));
      else call.resolve(message.result);
    });
    socket.once('open', () => {
      opened = true;
      resolve({
        onNotification(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        request(method, params, timeout = 7000) {
          const id = nextId++;
          return new Promise((done, failed) => {
            const timer = setTimeout(() => { pending.delete(id); failed(new Error(`Native RPC ${method} timeout; admission may be unknown`)); }, timeout);
            pending.set(id, { timer, resolve: done, reject: error => { clearTimeout(timer); failed(error); } });
            socket.send(JSON.stringify({ id, method, params }), error => { if (error) { pending.delete(id); clearTimeout(timer); failed(error); } });
          });
        },
        notify(method, params) { socket.send(JSON.stringify({ method, params })); },
        dispose() { listeners.clear(); socket.close(); fail(new Error('Native transport disposed')); },
      });
    });
  });
}
