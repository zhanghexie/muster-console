/** Real Electron/preload/IPC with an isolated fake DeepSeek ACP process. */
import { test, expect, _electron, type ElectronApplication } from '@playwright/test';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repoRoot = path.resolve(__dirname, '../..');
const requireNode = createRequire(__filename);

async function bounded(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([promise.catch(() => {}), new Promise(resolve => { timer = setTimeout(resolve, ms); })]); }
  finally { if (timer) clearTimeout(timer); }
}

test('DeepSeek 画布 fork 在源目录未读取模型目录时继承上下文并完成首轮', async ({}, testInfo) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-fork-e2e-'));
  const userData = path.join(cwd, '.dev-sandbox', 'userData');
  const sourceRoot = path.join(cwd, 'source');
  const activeRoot = path.join(cwd, 'active');
  const bin = path.join(cwd, 'bin');
  for (const dir of [sourceRoot, activeRoot, bin, path.join(userData, 'agent-sessions'), path.join(userData, 'agent-runtimes')]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const ledger = path.join(cwd, 'prompts.jsonl');
  const fakeAgent = path.join(cwd, 'fake-acp.cjs');
  fs.writeFileSync(fakeAgent, String.raw`
const fs = require('node:fs');
const rl = require('node:readline').createInterface({ input: process.stdin });
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
rl.on('line', line => {
  const msg = JSON.parse(line);
  if (msg.id == null) return;
  if (msg.method === 'initialize') return send({ jsonrpc:'2.0', id:msg.id, result:{ protocolVersion:1, agentCapabilities:{loadSession:false}, authMethods:[] } });
  if (msg.method === 'session/new') return send({ jsonrpc:'2.0', id:msg.id, result:{ sessionId:'fake-' + process.pid,
    models:{ currentModelId:'fixture-model', availableModels:[{modelId:'fixture-model', name:'Fixture model'}] } } });
  if (msg.method === 'session/prompt') {
    fs.appendFileSync(process.env.FORK_TEST_LEDGER, JSON.stringify(msg.params.prompt) + '\n');
    send({ jsonrpc:'2.0', method:'session/update', params:{ sessionId:msg.params.sessionId,
      update:{ sessionUpdate:'agent_message_chunk', content:{type:'text',text:'fork reply'} } } });
    send({ jsonrpc:'2.0', id:msg.id, result:{stopReason:'end_turn'} });
    setTimeout(() => process.exit(0), 500).unref();
    return;
  }
  send({ jsonrpc:'2.0', id:msg.id, error:{code:-32601,message:'unsupported'} });
});
`);
  const executable = path.join(bin, process.platform === 'win32' ? 'dsh.cmd' : 'dsh');
  const script = process.platform === 'win32'
    ? `@echo off\r\n"${process.execPath}" "${fakeAgent}" %*\r\n`
    : `#!/bin/sh\nexec "${process.execPath}" "${fakeAgent}" "$@"\n`;
  fs.writeFileSync(executable, script, { mode: 0o755 });

  const registry = JSON.parse(fs.readFileSync(path.join(repoRoot, 'src/main/runtime/builtins/registry.json'), 'utf8'));
  for (const entry of registry.runtimes) entry.enabled = entry.id === 'acp';
  fs.writeFileSync(path.join(userData, 'agent-runtimes/registry.json'), JSON.stringify(registry));
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ locale: 'zh-CN', themeId: 'dark', defaultRuntime: 'acp',
    workspace: activeRoot, activeWorkspaceId: 'active', workspaces: [{ id: 'active', name: 'Active', path: activeRoot },
      { id: 'source-ws', name: 'Source', path: sourceRoot }], webAccess: { enabled: false }, mcp: { enabled: false, servers: [] },
    modelParameterProfiles: [] }));
  const sourceId = '11111111-1111-4111-8111-111111111111';
  fs.writeFileSync(path.join(userData, 'sessions.json'), JSON.stringify([{ id: sourceId, name: 'DeepSeek source', type: 'terminal',
    launchKind: 'agent', runtime: 'acp', piModeId: 'deepseek', modelOverride: { providerId: 'acp', modelId: 'fixture-model' },
    workspaceId: 'source-ws', cwd: sourceRoot, status: 'idle', lifecycle: 'idle', createdAt: 1, lastUsedAt: 1 }]));
  const sourceHistory = JSON.stringify({ version: 2, messages: [
    { id: 'old-user', role: 'user', ts: 1, parts: [{ kind: 'text', text: '历史任务标记' }] },
    { id: 'old-assistant', role: 'assistant', ts: 2, parts: [{ kind: 'text', text: '历史回答标记' }] }
  ] });
  const historyFile = path.join(userData, 'agent-sessions', `${sourceId}.json`);
  fs.writeFileSync(historyFile, sourceHistory);
  const env = { ...process.env, MUSTER_SANDBOX: '1', MUSTER_INSTANCE_ID: path.basename(cwd), FORK_TEST_LEDGER: ledger } as Record<string, string>;
  const oldPath = Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] || '';
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key];
  env.PATH = bin + path.delimiter + oldPath;
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'MUSTER_DEVTOOLS_PORT', 'MUSTER_WEB_PORT', 'MUSTER_NO_SANDBOX']) delete env[key];

  let app: ElectronApplication | undefined;
  try {
    app = await _electron.launch({ executablePath: requireNode('electron'), args: [repoRoot, '--disable-gpu', '--in-process-gpu'], cwd, env, timeout: 60000 });
    const win = await app.firstWindow();
    await win.locator('.app-shell').waitFor({ timeout: 60000 });
    const catalog = await win.evaluate(async id => {
      const state = await window.api.agentSession.getSessionHarnessModelState(id);
      if (!state.ok) throw new Error(state.error);
      return window.api.agentSession.listSessionHarnessModels({ sessionId: id, requestId: 'fork-test-catalog', expected: state.expected });
    }, sourceId);
    expect(catalog.ok).toBe(false);
    if (!catalog.ok) expect(catalog.error).toContain('尚未读取模型目录');
    const fork = await win.evaluate(id => window.api.sessions.canvasFork(id), sourceId);
    expect(fork.session).toMatchObject({ runtime: 'acp', piModeId: 'deepseek', workspaceId: 'source-ws', cwd: sourceRoot,
      modelOverride: { providerId: 'acp', modelId: 'fixture-model' } });
    expect(fs.existsSync(ledger)).toBe(false);
    const copied = await win.evaluate(id => window.api.agentSession.historyRange(id), fork.session.id);
    expect(copied?.messages.map(message => message.id)).toEqual(['old-user', 'old-assistant']);
    expect((await win.evaluate(id => window.api.agentSession.send(id, '继续新的任务'), fork.session.id)).ok).toBe(true);
    await expect.poll(() => fs.existsSync(ledger) ? fs.readFileSync(ledger, 'utf8') : '', { timeout: 30000 }).toContain('历史任务标记');
    const prompt = fs.readFileSync(ledger, 'utf8');
    expect(prompt).toContain('历史回答标记');
    expect(prompt).toContain('继续新的任务');
    await expect.poll(async () => (await win.evaluate(id => window.api.agentSession.historyRange(id), fork.session.id))?.busy,
      { timeout: 30000 }).toBe(false);
    const finished = await win.evaluate(id => window.api.agentSession.historyRange(id), fork.session.id);
    expect(finished?.messages.at(-1)?.error).toBeFalsy();
    expect(fs.readFileSync(historyFile, 'utf8')).toBe(sourceHistory);
  } catch (error) {
    if (app) {
      const page = await app.firstWindow().catch(() => undefined);
      await page?.screenshot({ path: testInfo.outputPath('failure.png') }).catch(() => {});
    }
    throw error;
  } finally {
    const proc = app?.process();
    if (process.platform === 'win32' && proc?.pid && proc.exitCode === null && proc.signalCode === null) {
      try { execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); }
      catch { /* the owned process may already have exited */ }
    } else if (app) {
      await bounded(app.evaluate(({ app }) => { setTimeout(() => app.quit(), 0); }), 3000);
    }
    if (app) await bounded(app.close(), 5000);
    if (proc && proc.exitCode === null && proc.signalCode === null) {
      proc.kill();
      await bounded(new Promise<void>(resolve => {
        if (proc.exitCode !== null || proc.signalCode !== null) resolve();
        else proc.once('exit', () => resolve());
      }), 5000);
    }
    if (proc && proc.exitCode === null && proc.signalCode === null) throw new Error('测试 Electron 未退出，保留隔离目录供检查');
    if (path.dirname(cwd) !== os.tmpdir() || !path.basename(cwd).startsWith('canvas-fork-e2e-')) throw new Error('Invalid fixture cleanup path');
    await fs.promises.rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
