/** Real SessionsService + PtyManager with a controlled creation owner. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), ts = require('typescript'), Module = require('node:module');
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-start-exit-'));
const load = Module._load;
let pid = 100, native;
class FakePty {
  pid = ++pid; data = []; exits = []; exited = false;
  onData(fn) { this.data.push(fn); return { dispose() {} }; }
  onExit(fn) { this.exits.push(fn); return { dispose() {} }; }
  write() {} resize() {} kill() {}
  exit() { if (this.exited) return; this.exited = true; for (const fn of this.exits) fn({ exitCode: 0 }); }
}
require.extensions['.ts'] = (module, file) => module._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }, fileName: file
}).outputText.replace(/\bimport\.meta\.url\b/g, '__filename'), file);
Module._load = function(request) {
  if (request === 'electron') return { app: { getPath: () => folder, isReady: () => true }, ipcMain: { handle() {}, on() {} } };
  if (request === 'node-pty') return { spawn: () => (native = new FakePty()) };
  if (request === './shell/profiles') return { resolveShellLaunchAsync: async () => ({ command: 'fixture-shell', args: [] }) };
  return load.apply(this, arguments);
};
try {
  const { SessionsService } = require(path.join(process.cwd(), 'src/main/sessions.ts'));
  const { PtyManager } = require(path.join(process.cwd(), 'src/main/pty/manager.ts'));
  for (const scenario of ['startup-error', 'running-exit', 'user-close', 'replacement']) {
    let ready, failed, proc;
    const manager = new PtyManager(() => null, options => {
      proc = options.spawn({ command: 'private-bootstrap', args: [] });
      return { ready: new Promise((resolve, reject) => { ready = resolve; failed = reject; }), completed: new Promise(() => {}), close: async () => proc.exit() };
    });
    const row = { id: scenario, name: scenario, type: 'terminal', launchKind: 'shell', shellProfileId: 'powershell', runtime: 'shell', cwd: folder, workspaceId: 'w', status: 'starting', lifecycle: 'starting' };
    const notices = [], service = Object.create(SessionsService.prototype);
    const cfg = { activeWorkspaceId: 'w', workspaces: [{ id: 'w', path: folder, controlRoot: folder, defaultRootId: 'r', rootsRevision: 1, roots: [{ id: 'r', path: folder }] }] };
    let closes = 0;
    Object.assign(service, { config: { get: () => cfg }, sessions: [row], ptyMgr: manager, launchGen: new Map(), launchTasks: new Map(), classifyBySession: new Map(), ptyWorkingSince: new Map(), lifecycleListeners: [],
      isChatRuntime: () => false, persist() {}, broadcast() {}, emitSessionFactKind() {}, getWindow: () => null, workspaceIdFor: () => 'w', notify: { push: entry => notices.push(entry) },
      close(id) { closes++; this.bumpLaunchGen(id); this.sessions = this.sessions.filter(s => s.id !== id); }
    });
    manager.onExit = id => service.handlePtyExit(id);
    const pending = service.launchTerminal(row, 'start');
    const deadline = Date.now() + 3000; while (!proc && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(proc, 'actual shell launch reaches the creation owner');
    if (scenario === 'running-exit') {
      ready(); await pending; assert.equal(row.status, 'running');
      proc.exit(); assert.equal(closes, 1); assert.equal(service.sessions.length, 0);
    } else {
      if (scenario === 'user-close') service.close(row.id);
      if (scenario === 'replacement') { service.bumpLaunchGen(row.id); row.status = 'starting'; }
      proc.exit(); failed(new Error('fixture ownership handshake failed')); await pending;
      if (scenario === 'startup-error') {
        assert.equal(closes, 0); assert.equal(service.sessions[0], row);
        assert.equal(row.status, 'exited'); assert.equal(row.meta.launchError, 'fixture ownership handshake failed');
        assert.equal(notices.length, 1); assert.match(notices[0].text, /fixture ownership handshake failed/);
      } else { assert.equal(notices.length, 0, 'user close or supersession suppresses stale startup errors'); assert.equal(row.meta?.launchError, undefined); if (scenario === 'replacement') { assert.equal(closes, 0); assert.equal(service.sessions[0], row); assert.equal(row.status, 'starting'); } }
    }
    await manager.killAllAndWait();
  }
  console.log('shell-startup-exit-diagnostics: startup error retained/notified; committed exit closes; stale failures suppressed');
} finally { Module._load = load; fs.rmSync(folder, { recursive: true, force: true }); }
