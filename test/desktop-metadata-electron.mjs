/** Run after the build: exercise the production metadata factory in a separate Electron process. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = process.cwd(), temp = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-metadata-electron-'));
try {
  const compile = createSharedCompiler(root, path.join(temp, 'compiled'));
  const factoryUrl = pathToFileURL(compile('main/desktop/metadataFactory.ts')).href;
  const auditUrl = pathToFileURL(compile('main/desktop/auditStore.ts')).href;
  const hostUrl = pathToFileURL(compile('main/capabilities/hosts/desktop.ts')).href;
  const scopeUrl = pathToFileURL(compile('main/agent/agentScope.ts')).href;
  const workspace = path.join(temp, 'workspace'), userData = path.join(temp, 'userData');
  fs.mkdirSync(workspace); fs.mkdirSync(userData);
  assert.ok(fs.existsSync(path.join(root, 'out/main/desktop/inventory-worker.cjs')), 'run npm run build first');
  const script = path.join(temp, 'main.cjs');
  fs.writeFileSync(script, `
    const { app, screen, powerMonitor } = require('electron');
    app.setPath('userData', ${JSON.stringify(userData)});
    app.whenReady().then(async () => {
      const { createDesktopMetadataRuntime } = await import(${JSON.stringify(factoryUrl)});
      const { DesktopAuditStore } = await import(${JSON.stringify(auditUrl)});
      const { listDesktop } = await import(${JSON.stringify(hostUrl)});
      const { runAsAgentWorkspace, runAsSchedulerTool } = await import(${JSON.stringify(scopeUrl)});
      const ws = { id: 'fixture', name: 'Fixture', path: ${JSON.stringify(workspace)}, rootsRevision: 1,
        defaultRootId: 'root', controlRoot: ${JSON.stringify(workspace)}, roots: [{ id: 'root', path: ${JSON.stringify(workspace)} }] };
      const ctx = { config: { get: () => ({ activeWorkspaceId: 'fixture', workspaces: [ws] }) } };
      const runtime = createDesktopMetadataRuntime(${JSON.stringify(userData)}, ${JSON.stringify(path.join(root, 'out/main'))}, screen, powerMonitor);
      ctx.desktopMetadata = () => runtime;
      ctx.desktopScreen = () => ({}); ctx.desktopControl = () => ({});
      const result = await runAsAgentWorkspace('fixture', () => runAsSchedulerTool(() => listDesktop(ctx)));
      if (process.platform === 'win32' && (!result.capabilities.capture.available || !result.capabilities.foregroundInput.available || !result.capabilities.activate.available || result.capabilities.semanticRead.available || result.capabilities.backgroundInput.available)) throw new Error('Wrong Windows capability matrix');
      if (!Array.isArray(result.displays.surfaces) || !result.displays.surfaces.length) throw new Error('No display metadata');
      if (process.platform === 'win32' && !result.windows.ok) throw new Error('Windows inventory failed: ' + result.windows.error);
      runtime.close();
      const audit = new DesktopAuditStore(require('node:path').join(${JSON.stringify(userData)}, 'desktop', 'audit.sqlite'));
      const rows = audit.list('orchestrator:fixture');
      if (rows.length !== 1 || rows[0].action !== 'list' || rows[0].result !== 'allowed') throw new Error('Metadata audit missing');
      audit.close();
      console.log('desktop metadata Electron: live display and isolated audited inventory passed');
      app.quit();
    }).catch(error => { console.error(error); app.exit(1); });
  `);
  const electron = createRequire(import.meta.url)('electron');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const output = execFileSync(electron, [script], { encoding: 'utf8', timeout: 30_000, env });
  assert.match(output, /live display and isolated audited inventory passed/);
  console.log(output.trim());
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
