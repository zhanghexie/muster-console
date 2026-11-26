import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { finished } from 'node:stream/promises';
import { build } from 'esbuild';

const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-model-owner-'));
const owners = [];
const closedChildren = new Set();
const stdinErrors = [];
try {
  const fixture = path.join(folder, 'catalog.cjs'), marker = path.join(folder, 'grandchild');
  const descendant = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(marker)},'x');setInterval(()=>fs.appendFileSync(${JSON.stringify(marker)},'x'),20);setTimeout(()=>process.exit(),5000);`;
  fs.writeFileSync(fixture, `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{detached:${process.platform === 'win32'},stdio:'ignore'}).unref();let input='';process.stdin.on('data',data=>{input+=data;if(input.includes('catalog')){process.stdout.write(JSON.stringify([{value:'fixture-model',displayName:'Fixture',supportedEffortLevels:['low']}])+${JSON.stringify('\n')});setTimeout(()=>process.exit(0),150);}});`);
  globalThis.modelOwnerSdk = { query({ options }) {
    assert.equal(options.pathToClaudeCodeExecutable, process.execPath, 'catalog discovery passes the local CLI to the SDK');
    const child = options.spawnClaudeCodeProcess({ command: process.execPath, args: [fixture], cwd: folder, env: { ...options.env, ELECTRON_RUN_AS_NODE: '1' } });
    owners.push(child);
    let output = '', sdkClosing = false;
    const result = new Promise((resolve, reject) => {
      child.stdout.on('data', data => { output += data; const end = output.indexOf('\n'); if (end >= 0) resolve(JSON.parse(output.slice(0, end))); });
      child.once('error', reject);
      // Real ProcessTransport observes stdin errors even after process exit.
      // Record the phase so a runtime write failure cannot disappear as cleanup noise.
      child.stdin.on('error', error => {
        const afterRelease = sdkClosing && closedChildren.has(child);
        stdinErrors.push({ error, afterRelease });
        if (!afterRelease) reject(error);
      });
    });
    const closed = new Promise(resolve => child.once('close', () => { closedChildren.add(child); resolve(); }));
    child.stdin.write('catalog\n');
    return { supportedModels: () => result, close: async () => {
      sdkClosing = true;
      const inputFinished = finished(child.stdin, { cleanup: true });
      child.stdin.end();
      try { await inputFinished; }
      catch (error) { if (!closedChildren.has(child)) throw error; }
      await closed;
    } };
  } };
  const target = path.join(folder, 'models.cjs');
  await build({ entryPoints: ['src/main/agentSession/drivers/claude/models.ts'], outfile: target, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent', plugins: [{ name: 'sdk-network-boundary', setup(builder) {
    // The process monitor imports Electron's app/IPC surface. A plain Node
    // fixture must not bundle Electron's npm installer/launcher into models.cjs.
    // Keep the real process owner, Job/group and descendant execution intact.
    builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'electron-fixture' }));
    builder.onLoad({ filter: /^electron$/, namespace: 'electron-fixture' }, () => ({ contents: `
      export const app = { getPath: () => ${JSON.stringify(folder)}, getAppMetrics: () => [] };
      export const shell = { showItemInFolder() {} };
      export const webContents = { getAllWebContents: () => [] };
      export const ipcMain = { handle() {}, removeHandler() {} };
    `, loader: 'js' }));
    builder.onResolve({ filter: /\/claudeSdk$/ }, () => ({ path: 'sdk', namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `export const loadClaudeSdk=async()=>globalThis.modelOwnerSdk; export const resolveClaudeExecutable=async()=>({ok:true,executable:process.execPath}); export const resolveUserClaudeExecutable=()=>process.execPath;`, loader: 'js' }));
  } }] });
  const guardian = path.join(folder, 'agentSession/drivers/codex/worker/windows-job.ps1'); fs.mkdirSync(path.dirname(guardian), { recursive: true });
  fs.copyFileSync('src/main/agentSession/drivers/codex/worker/windows-job.ps1', guardian);
  const { listClaudeModels } = createRequire(import.meta.url)(target);
  const result = await listClaudeModels({ cwd: folder, userDataDir: folder, isolateConfig: true, refresh: true });
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.items[0].id, 'fixture-model');
  assert.equal(closedChildren.has(owners[0]), true, 'model discovery returns only after the actual container close');
  assert.deepEqual(stdinErrors.filter(item => !item.afterRelease), [], 'runtime stdin failures must fail the fixture');
  if (fs.existsSync(marker)) {
    const before = fs.readFileSync(marker, 'utf8'); await new Promise(resolve => setTimeout(resolve, 120));
    assert.equal(fs.readFileSync(marker, 'utf8'), before, 'catalog close releases its descendant container');
  }
  console.log('Claude catalog: real pre-ready stdio and owned container reclamation passed without an inference request');
} finally {
  delete globalThis.modelOwnerSdk;
  for (const child of owners) child.kill();
  const resolved = fs.realpathSync(folder);
  assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith('claude-model-owner-'));
  fs.rmSync(resolved, { recursive: true, force: true });
}
