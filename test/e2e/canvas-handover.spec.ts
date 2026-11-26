/** Real Electron/preload/IPC; only the ACP engine is a synthetic local process. */
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

test('交接快照绑定新会话，取消草稿和删除会话分别清理文档', async ({}, info) => {
  test.setTimeout(90_000);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-handover-e2e-'));
  const userData = path.join(cwd, '.dev-sandbox', 'userData');
  const workspace = path.join(cwd, 'workspace'), bin = path.join(cwd, 'bin');
  const ledger = path.join(cwd, 'prompts.jsonl');
  for (const dir of [workspace, bin, path.join(userData, 'agent-sessions'), path.join(userData, 'agent-runtimes')]) fs.mkdirSync(dir, { recursive: true });
  const agent = path.join(cwd, 'fake-acp.cjs');
  fs.writeFileSync(agent, String.raw`
const fs = require('node:fs');
const readline = require('node:readline');
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const msg = JSON.parse(line); if (msg.id == null) return;
  if (msg.method === 'initialize') return send({ jsonrpc:'2.0', id:msg.id, result:{ protocolVersion:1, agentCapabilities:{loadSession:false}, authMethods:[] } });
  if (msg.method === 'session/new') return send({ jsonrpc:'2.0', id:msg.id, result:{ sessionId:'fake-' + process.pid } });
  if (msg.method === 'session/prompt') {
    fs.appendFileSync(process.env.HANDOVER_TEST_LEDGER, JSON.stringify(msg.params.prompt) + '\n');
    send({ jsonrpc:'2.0', method:'session/update', params:{ sessionId:msg.params.sessionId, update:{ sessionUpdate:'agent_message_chunk', content:{type:'text',text:'ready'} } } });
    return send({ jsonrpc:'2.0', id:msg.id, result:{stopReason:'end_turn'} });
  }
  send({ jsonrpc:'2.0', id:msg.id, error:{code:-32601,message:'unsupported'} });
});
`);
  fs.writeFileSync(path.join(bin, process.platform === 'win32' ? 'dsh.cmd' : 'dsh'), process.platform === 'win32'
    ? `@echo off\r\n"${process.execPath}" "${agent}" %*\r\n`
    : `#!/bin/sh\nexec "${process.execPath}" "${agent}" "$@"\n`, { mode: 0o755 });
  const registry = JSON.parse(fs.readFileSync(path.join(repoRoot, 'src/main/runtime/builtins/registry.json'), 'utf8'));
  for (const entry of registry.runtimes) entry.enabled = entry.id === 'acp';
  fs.writeFileSync(path.join(userData, 'agent-runtimes/registry.json'), JSON.stringify(registry));
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ locale: 'zh-CN', themeId: 'dark', defaultRuntime: 'acp',
    workspace, activeWorkspaceId: 'ws', workspaces: [{ id: 'ws', name: 'Workspace', path: workspace }],
    webAccess: { enabled: false }, mcp: { enabled: false, servers: [] }, modelParameterProfiles: [] }));
  const sourceId = '11111111-1111-4111-8111-111111111111';
  const longToolOutput = `工具结果开头${'a'.repeat(18000)}工具结果中段${'b'.repeat(18000)}工具结果结尾`;
  fs.writeFileSync(path.join(userData, 'sessions.json'), JSON.stringify([{ id: sourceId, name: '原任务', type: 'terminal',
    launchKind: 'agent', runtime: 'acp', piModeId: 'deepseek', workspaceId: 'ws', cwd: workspace,
    status: 'idle', lifecycle: 'idle', createdAt: 1, lastUsedAt: 1 }]));
  fs.writeFileSync(path.join(userData, 'agent-sessions', `${sourceId}.json`), JSON.stringify({ version: 2, messages: [
    { id: 'old-user', role: 'user', ts: 1, parts: [{ kind: 'text', text: '历史目标标记' }] },
    { id: 'old-assistant', role: 'assistant', ts: 2, parts: [{ kind: 'text', text: '历史进度标记' },
      { kind: 'tool', tool: { id: 'old-tool', name: 'Read', input: { path: 'fixture.ts' }, status: 'ok', output: longToolOutput } }] },
    { id: 'old-user-2', role: 'user', ts: 3, parts: [{ kind: 'text', text: '后续用户要求' }] },
    { id: 'old-assistant-2', role: 'assistant', ts: 4, parts: [{ kind: 'text', text: '后续助手回复' }] }
  ] }));
  const env = { ...process.env, MUSTER_SANDBOX: '1', MUSTER_INSTANCE_ID: path.basename(cwd), HANDOVER_TEST_LEDGER: ledger } as Record<string, string>;
  const oldPath = Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] || '';
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key];
  env.PATH = bin + path.delimiter + oldPath;
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'MUSTER_DEVTOOLS_PORT', 'MUSTER_WEB_PORT', 'MUSTER_NO_SANDBOX']) delete env[key];
  let app: ElectronApplication | undefined;
  try {
    app = await _electron.launch({ executablePath: requireNode('electron'), args: [repoRoot, '--disable-gpu', '--in-process-gpu'], cwd, env, timeout: 60000 });
    const win = await app.firstWindow();
    await win.locator('.app-shell').waitFor({ timeout: 60000 });
    await win.addLocatorHandler(win.getByTestId('confirm-mask'), async modal => {
      const text = await modal.innerText();
      if (!text.includes('审核扩展：工作日报') || !text.includes('缺少可用模型或凭据')) throw new Error(`Unexpected fixture dialog: ${text}`);
      await modal.getByRole('button', { name: '取消', exact: true }).click();
    }, { times: 1 });
    const cancelled = await win.evaluate(id => window.api.sessions.canvasHandover(id), sourceId);
    const text = cancelled.lockedTask;
    const historyText = fs.readFileSync(cancelled.documentPath, 'utf8');
    expect(text).toContain(`原会话 ID：${sourceId}`);
    expect(text).toContain('共 2 轮，包含 2 条用户消息、2 条助手消息和 1 次工具调用');
    expect(text).toContain('部分超长工具输出已截断');
    const body = text.match(/沟通正文：第 (\d+)–(\d+) 行/);
    const appendix = text.match(/工具调用附录：第 (\d+)–(\d+) 行/);
    if (!body || !appendix) throw new Error('交接背景缺少文档行号');
    const lines = historyText.split('\n');
    expect(lines[Number(body[1]) - 1]).toBe('## [用户 #0001] 第 1 轮');
    expect(lines.slice(Number(body[1]) - 1, Number(body[2])).join('\n')).toContain('历史进度标记');
    expect(lines.slice(Number(body[1]) - 1, Number(body[2])).join('\n')).not.toContain('工具结果开头');
    expect(lines[Number(appendix[1]) - 1]).toBe('# 附录：工具调用详情');
    const details = lines.slice(Number(appendix[1]) - 1, Number(appendix[2])).join('\n');
    expect(details).toContain('工具结果开头');
    expect(details).toContain('工具结果结尾');
    expect(details).toContain('工具输出已截断');
    expect(details).not.toContain('工具结果中段');
    const savedSource = JSON.parse(fs.readFileSync(path.join(userData, 'agent-sessions', `${sourceId}.json`), 'utf8'));
    expect(savedSource.messages[1].parts[1].tool.output).toBe(longToolOutput);
    await win.evaluate(id => window.api.sessions.canvasHandoverCancel(id), cancelled.id);
    expect(fs.existsSync(cancelled.documentPath)).toBe(false);

    await win.getByRole('button', { name: '全局看板' }).click();
    await win.getByRole('tab', { name: '自由' }).click();
    const source = win.locator(`[data-cnode="${sourceId}"]`);
    await expect(source).toBeVisible();
    await source.hover();
    const port = source.locator('[data-fc-handle="s"]');
    await expect(port).toHaveCSS('opacity', '1');
    const handle = await port.boundingBox();
    const viewport = await win.locator('.fc-viewport').boundingBox();
    if (!handle || !viewport) throw new Error('画布节点或视口没有布局');
    await win.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    expect(await win.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.getAttribute('data-fc-handle'),
      { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 })).toBe('s');
    await win.mouse.down();
    await win.mouse.move(viewport.x + viewport.width * .75, viewport.y + viewport.height * .55, { steps: 8 });
    await expect(win.locator('.fc-viewport')).toHaveClass(/is-linking/);
    await win.mouse.up();
    await win.getByRole('menuitemcheckbox', { name: '交接' }).click();
    const task = win.getByRole('textbox', { name: '本次任务' });
    await expect(task).toBeVisible();
    await expect(task).toHaveAttribute('aria-placeholder', '输入交接后的任务，交接信息会自动补充');
    await expect(win.getByRole('textbox', { name: '交接背景' })).toHaveCount(0);
    const handoverRoot = path.join(userData, 'session-handovers');
    const draftDirs = fs.readdirSync(handoverRoot, { withFileTypes: true }).filter(entry => entry.isDirectory());
    expect(draftDirs).toHaveLength(1);
    const targetId = draftDirs[0].name;
    const documentPath = path.join(handoverRoot, targetId, 'history.md');
    expect(fs.readFileSync(documentPath, 'utf8')).toContain('历史进度标记');
    expect((await win.evaluate(() => window.api.sessions.list())).sessions.some(session => session.id === targetId)).toBe(false);
    await win.getByRole('textbox', { name: /会话名称/ }).fill('接手任务');
    await task.fill('先检查测试');
    await win.getByRole('dialog', { name: '新建任务' }).locator('input[type=file]').setInputFiles({
      name: 'checklist.txt', mimeType: 'text/plain', buffer: Buffer.from('handover-first-turn-attachment')
    });
    await win.getByRole('button', { name: '选择 Harness 和模型' }).click();
    const picker = win.getByRole('dialog', { name: '选择 Harness 和模型' });
    await picker.getByRole('tab', { name: 'DeepSeek', exact: true }).click();
    await expect(win.getByRole('dialog', { name: '全局看板' })).toHaveClass(/is-open/);
    await win.screenshot({ path: info.outputPath('handover-harness-picker.png') });
    await picker.getByRole('button', { name: '确认配置' }).click();
    await expect(win.getByRole('dialog', { name: '全局看板' })).toHaveClass(/is-open/);
    await expect(task).toBeVisible();
    await win.getByRole('button', { name: '开始任务' }).click({ timeout: 30000 });
    await expect.poll(async () => (await win.evaluate(() => window.api.sessions.list())).sessions.find(session => session.id === targetId),
      { timeout: 30000 }).toMatchObject({ name: '接手任务', runtime: 'acp', piModeId: 'deepseek' });
    expect(fs.existsSync(documentPath)).toBe(true);
    const promptText = () => fs.existsSync(ledger) ? fs.readFileSync(ledger, 'utf8').split('\n').filter(Boolean)
      .flatMap(line => JSON.parse(line) as Array<{ text?: string }>).map(block => block.text ?? '').join('\n') : '';
    await expect.poll(promptText, { timeout: 30000 }).toContain('handover-first-turn-attachment');
    expect(promptText()).toContain('先检查测试');
    expect(promptText()).toContain(documentPath);
    expect(fs.readFileSync(ledger, 'utf8').trim().split('\n')).toHaveLength(1);
    await win.evaluate(async id => { await window.api.sessions.setArchived(id, true); await window.api.sessions.close(id); }, targetId);
    await expect.poll(() => fs.existsSync(path.dirname(documentPath)), { timeout: 30000 }).toBe(false);
  } catch (error) {
    if (app) await (await app.firstWindow()).screenshot({ path: info.outputPath('failure.png') }).catch(() => {});
    throw error;
  } finally {
    const proc = app?.process();
    if (process.platform === 'win32' && proc?.pid && proc.exitCode === null && proc.signalCode === null) {
      try { execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 10000 }); } catch { /* may already be gone */ }
    } else if (app) await bounded(app.evaluate(({ app }) => { setTimeout(() => app.quit(), 0); }), 3000);
    if (app) await bounded(app.close(), 5000);
    if (proc && proc.exitCode === null && proc.signalCode === null) proc.kill();
    if (path.dirname(cwd) !== os.tmpdir() || !path.basename(cwd).startsWith('canvas-handover-e2e-')) throw new Error('Invalid fixture cleanup path');
    await fs.promises.rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
