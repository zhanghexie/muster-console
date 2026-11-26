import { _electron, expect, test } from '@playwright/test';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { unzipSync } from 'fflate';

test('Core requests window shows each actual HTTP request independently of Harness transparency', async ({}, info) => {
  const bodies: string[] = [];
  let readForCompression = false;
  let streamGate: Promise<void> | undefined;
  let endAtLength = false;
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    if (!req.url?.endsWith('/chat/completions')) { res.writeHead(404).end(); return; }
    bodies.push(Buffer.concat(chunks).toString('utf8'));
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const packet = { id: 'completion', model: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', content: 'Recorded.' }, finish_reason: null as string | null }] };
    const readNow = readForCompression;
    readForCompression = false;
    const delta = endAtLength ? { role: 'assistant', reasoning_content: 'fixture reasoning' } : readNow ? { role: 'assistant', tool_calls: [{ index: 0, id: 'call-log', type: 'function',
      function: { name: 'read', arguments: JSON.stringify({ path: 'compression-fixture.log' }) } }] } : packet.choices[0]!.delta;
    res.write('data: ' + JSON.stringify({ ...packet, choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n');
    if (streamGate) await streamGate;
    res.end('data: ' + JSON.stringify({ ...packet, choices: [{ index: 0, delta: {}, finish_reason: endAtLength ? 'length' : readNow ? 'tool_calls' : 'stop' }] }) + '\n\ndata: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = 'http://127.0.0.1:' + (server.address() as {port: number}).port + '/v1';
  const project = path.resolve(__dirname, '../..');
  const userData = path.join(info.outputDir, '.dev-sandbox', 'userData');
  const workspace = path.join(info.outputDir, 'workspace');
  const workspaceId = 'request-fixture';
  const sessionId = randomUUID();
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
    locale: 'zh-CN', activeWorkspaceId: workspaceId, defaultCwd: workspace,
    workspaces: [{ id: workspaceId, name: 'Request fixture', path: workspace }],
    webAccess: { enabled: false }, mcp: { enabled: false, servers: [] },
    llm: { activeProviderId: 'localfixture', activeModelId: 'qwen4-max-preview', providers: [{ id: 'localfixture', name: 'Fixture', enabled: true,
      api: 'openai-completions', baseUrl, apiKey: 'local-fixture-key', models: [{ id: 'qwen4-max-preview', name: 'Fixture' }] }] }
  }));
  fs.writeFileSync(path.join(userData, 'sessions.json'), JSON.stringify([{ id: sessionId, type: 'terminal', launchKind: 'agent',
    runtime: 'pi', name: 'Request fixture', workspaceId, cwd: workspace, createdAt: Date.now(), lifecycle: 'idle' }]));
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env)
    .filter((entry): entry is [string, string] => entry[1] !== undefined));
  Object.assign(env, { MUSTER_SANDBOX: '1', MUSTER_INSTANCE_ID: sessionId });
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ executablePath: require('electron'), args: [project, '--disable-gpu'], cwd: info.outputDir, env });
  try {
    const win = await app.firstWindow();
    await win.locator('.app-shell').waitFor();
    await win.evaluate(id => window.api.sessions.select(id), sessionId);
    const worker = win.locator(`.agent-chat-view[data-session-id="${sessionId}"]`);
    const editor = worker.getByRole('textbox');
    const shortcutName = '录制中，打开模型请求';
    const shortcut = worker.getByRole('button', { name: shortcutName });
    const openViewer = () => shortcut.click();
    const viewHistory = async () => {
      await editor.fill('/record-requests view');
      await editor.press('Enter');
    };
    const dialog = win.getByRole('dialog', { name: '模型请求' });
    const toggle = dialog.getByRole('switch', { name: '记录本会话请求' });
    async function submit(message: string) {
      const result = await win.evaluate(({ id, message }) => window.api.agentSession.send(id, message), { id: sessionId, message });
      expect(result.ok, JSON.stringify(result)).toBe(true);
      await expect.poll(() => win.evaluate(async id => (await window.api.agentSession.historyRange(id))?.busy, sessionId), { timeout: 45_000 }).toBe(false);
    }
    await submit('Before recording.');
    await expect.poll(() => win.evaluate(async id => (await window.api.agentSession.historyRange(id))?.usage?.contextWindow, sessionId)).toBe(1_000_000);
    await expect(shortcut).toHaveCount(0);
    const handle = win.locator('[data-testid^="center-pane-handle-"]:visible').first();
    await handle.press('Enter');
    await expect(win.getByRole('menu').getByText('Harness 透明')).toBeVisible();
    await expect(win.getByRole('menu').getByText('模型请求', { exact: true })).toHaveCount(0);
    await win.keyboard.press('Escape');
    await viewHistory();
    await expect(toggle).not.toBeChecked();
    await expect(dialog.getByText('暂无模型请求记录')).toBeVisible();
    await win.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    const beforeCommand = bodies.length;
    await editor.fill('/record');
    await worker.getByRole('option', { name: /\/record-requests/ }).click();
    await expect(toggle).toBeChecked();
    expect(bodies.length).toBe(beforeCommand);
    await win.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(editor).toBeFocused();
    await expect(shortcut).toBeVisible();
    await worker.screenshot({ path: info.outputPath('recording-worker-dark.png'), animations: 'disabled' });
    bodies.length = 0;
    await submit('Report the fixture status.');
    // Keep the last response open through the first lazy import and view switch.
    let release!: () => void;
    streamGate = new Promise<void>(resolve => { release = resolve; });
    const inFlight = await win.evaluate(id => window.api.agentSession.send(id, 'Which step came before this one?'), sessionId);
    expect(inFlight.ok).toBe(true);
    await expect.poll(() => bodies.length).toBe(2);
    const navigation = () => win.evaluate(() => performance.timeOrigin);
    const pageStart = await navigation();
    expect(bodies.length).toBe(2);
    const sent = JSON.parse(bodies[1]!);
    expect(sent.max_completion_tokens ?? sent.max_tokens).toBe(393216);
    await openViewer();
    await expect(toggle).toBeChecked();
    await dialog.getByRole('button', { name: '压缩当前会话' }).click();
    await expect(dialog.locator('.request-compact-action [role=status]')).toContainText(/忙|回合/);
    await expect(dialog.locator('.request-rows button')).toHaveCount(bodies.length);
    for (let i = 0; i < bodies.length; i++) {
      await dialog.locator('.request-rows button').nth(bodies.length - 1 - i).click();
      await dialog.getByRole('button', { name: '原始请求体' }).click();
      const format = dialog.getByRole('checkbox', { name: '格式化 JSON' });
      await format.check();
      await expect(dialog.locator('.request-json-editor .cm-line').nth(1)).toContainText('"model":');
      if (i === 1) await dialog.screenshot({ path: info.outputPath('requests-json.png'), animations: 'disabled' });
      await format.uncheck();
      await expect.poll(() => dialog.locator('.request-source > pre').textContent()).toBe(bodies[i]);
    }
    // Exercise the production UI -> preload -> IPC -> file writer; only the OS picker is stubbed.
    const exportPath = info.outputPath('actual-model-requests.zip');
    await app.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = (async () => ({ canceled: false, filePath })) as typeof dialog.showSaveDialog;
    }, exportPath);
    await dialog.getByRole('button', { name: '导出当前调用' }).click();
    await expect(dialog.getByText('已导出 1 次调用', { exact: true })).toBeVisible();
    const singleFiles = unzipSync(fs.readFileSync(exportPath));
    const singleManifest = JSON.parse(Buffer.from(singleFiles['manifest.json']!).toString());
    expect(singleManifest.requests).toHaveLength(1);
    expect(Buffer.from(singleFiles[singleManifest.requests[0].bodyFile]!).toString()).toBe(bodies.at(-1));
    await dialog.getByRole('button', { name: '导出全部调用' }).click();
    await expect(dialog.getByText('已导出 2 次调用', { exact: true })).toBeVisible();
    await dialog.screenshot({ path: info.outputPath('requests-exported.png'), animations: 'disabled' });
    const exported = unzipSync(fs.readFileSync(exportPath));
    const manifest = JSON.parse(Buffer.from(exported['manifest.json']!).toString());
    expect(manifest.sessionId).toBe(sessionId);
    expect(manifest.requests.map((r: {bodyFile: string}) => Buffer.from(exported[r.bodyFile]!).toString())).toEqual(bodies);
    expect(await win.evaluate(id => window.api.agentSession.exportModelRequests(id, -1), sessionId))
      .toMatchObject({ ok: false, error: '模型请求导出参数无效' });
    await app.evaluate(({ dialog }) => {
      dialog.showSaveDialog = (async () => ({ canceled: true, filePath: '' })) as typeof dialog.showSaveDialog;
    });
    await dialog.getByRole('button', { name: '导出当前调用' }).click();
    await expect(dialog.getByText('已导出 2 次调用', { exact: true })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: '导出当前调用' })).toBeEnabled();
    const exportTip = win.locator('.app-tip.is-error');
    await expect(exportTip).toHaveCount(0);
    await app.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = (async () => ({ canceled: false, filePath })) as typeof dialog.showSaveDialog;
    }, path.join(info.outputDir, 'missing-folder', 'export.zip'));
    await dialog.getByRole('button', { name: '导出全部调用' }).click();
    await expect(exportTip).toHaveText('模型请求导出失败：保存目录不存在，请重新选择导出位置');
    await app.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = (async () => ({ canceled: false, filePath })) as typeof dialog.showSaveDialog;
    }, exportPath);
    await dialog.getByRole('button', { name: '导出全部调用' }).click();
    await expect(dialog.getByText('已导出 2 次调用', { exact: true })).toBeVisible();
    expect(await navigation()).toBe(pageStart);
    expect(await win.evaluate(async id => (await window.api.agentSession.historyRange(id))?.busy, sessionId)).toBe(true);
    release();
    streamGate = undefined;
    await expect.poll(() => win.evaluate(async id => {
      const h = await window.api.agentSession.historyRange(id);
      return !h?.busy && h?.messages.at(-1)?.parts.some(p => p.kind === 'text' && p.text.includes('Recorded.'));
    }, sessionId)).toBe(true);
    await dialog.getByRole('button', { name: '内容', exact: true }).click();
    await expect(dialog.locator('.request-document article').last()).toContainText('Which step');
    await expect(dialog.locator('.request-source')).toBeHidden();
    await dialog.screenshot({ path: info.outputPath('requests.png'), animations: 'disabled' });
    expect((await win.evaluate(() => window.api.themes.activate('light'))).ok).toBe(true);
    await expect(win.locator('html')).toHaveAttribute('data-theme', 'light');
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]!; w.setMinimumSize(380, 500); w.setContentSize(480, 750); });
    await expect.poll(() => dialog.evaluate(el => getComputedStyle(el.querySelector('.request-columns')!).gridTemplateColumns.split(' ').length)).toBe(1);
    await expect.poll(() => dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await toggle.click();
    await expect(toggle).not.toBeChecked();
    await dialog.screenshot({ path: info.outputPath('requests-narrow.png'), animations: 'disabled' });
    await win.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(shortcut).toHaveCount(0);
    await submit('After stopping.');
    await viewHistory();
    await expect(dialog.locator('.request-rows button')).toHaveCount(2);
    await expect(toggle).not.toBeChecked();
    await toggle.click();
    await expect(toggle).toBeChecked();
    await win.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await worker.screenshot({ path: info.outputPath('recording-worker-light-narrow.png'), animations: 'disabled' });
    const log = 'output record\n'.repeat(560) + 'WARNING E531 fixture\nunique-ordinary-record';
    fs.writeFileSync(path.join(workspace, 'compression-fixture.log'), log);
    readForCompression = true;
    await submit('Read the fixture log.');
    const original = JSON.parse(bodies.at(-1)!).messages.find((m: {role: string}) => m.role === 'tool');
    expect(original.content).toBe(log);
    await submit('Continue after that read.');
    const excerpt = JSON.parse(bodies.at(-1)!).messages.find((m: {role: string}) => m.role === 'tool');
    expect(excerpt.tool_call_id).toBe(original.tool_call_id);
    expect(excerpt.content).toContain('[Core excerpt · source ');
    expect(excerpt.content).toContain('unique-ordinary-record');
    await openViewer();
    const compressed = dialog.locator('.request-rows button').first();
    await expect(compressed).toContainText('压缩 1 项');
    await compressed.click();
    await dialog.getByRole('button', { name: '压缩', exact: true }).click();
    const card = dialog.locator('.request-compression-card');
    await expect(card.getByText('工具结果摘录')).toBeVisible();
    expect(await card.locator('section > pre').textContent()).toBe(excerpt.content);
    await card.locator('summary').click();
    await expect.poll(() => card.locator('.request-original pre').textContent()).toBe(log.slice(0, 6000));
    await card.getByRole('button', { name: '下一页' }).click();
    await expect.poll(() => card.locator('.request-original pre').textContent()).toBe(log.slice(6000));
    await dialog.screenshot({path: info.outputPath('compression-light-narrow.png'), animations: 'disabled'});
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1100, 820));
    expect((await win.evaluate(() => window.api.themes.activate('dark'))).ok).toBe(true);
    await expect(win.locator('html')).toHaveAttribute('data-theme', 'dark');
    await dialog.screenshot({path: info.outputPath('compression-dark.png'), animations: 'disabled'});
    await dialog.getByRole('button', { name: '原始请求体' }).click();
    await dialog.getByRole('checkbox', { name: '格式化 JSON' }).uncheck();
    await expect.poll(() => dialog.locator('.request-source > pre').textContent()).toBe(bodies.at(-1));
    await win.keyboard.press('Escape');
    endAtLength = true;
    await submit('Reach the output limit.');
    const notice = win.getByText('本次模型调用已达到输出上限。可发送「继续」接着回答。', { exact: true });
    await expect(notice).toBeVisible();
    await notice.locator('..').screenshot({path: info.outputPath('output-limit.png'), animations: 'disabled'});
    endAtLength = false;
    // Native compaction retains the latest 20k tokens. Give it an older, completed phase to summarize.
    await submit('Completed phase records\n' + 'synthetic work record\n'.repeat(5000));
    await submit('Start the next phase.');
    await openViewer();
    await dialog.getByRole('button', { name: '压缩当前会话' }).click();
    await expect(dialog.locator('.request-compact-action [role=status]')).toHaveText('当前会话已压缩', { timeout: 30000 });
    await win.keyboard.press('Escape');
    await submit('Continue with the compacted context.');
    await openViewer();
    await dialog.getByRole('button', { name: '压缩', exact: true }).click();
    await expect(dialog.getByText('会话摘要', { exact: true })).toBeVisible();

    await toggle.click();
    await expect(toggle).not.toBeChecked();
    const workerCalls = await dialog.locator('.request-rows button').count();
    await win.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    async function recordInConversation(conversation: import('@playwright/test').Locator, prompt: string, screenshot: string) {
      const input = conversation.getByRole('textbox');
      const reopen = conversation.getByRole('button', { name: shortcutName });
      await expect(reopen).toHaveCount(0);
      await input.fill('/record-requests');
      await input.press('Enter');
      await expect(toggle).toBeChecked();
      await win.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await input.fill(prompt);
      await input.press('Enter');
      await expect(conversation.getByText('Recorded.', { exact: true }).last()).toBeVisible({ timeout: 30_000 });
      await expect(reopen).toBeVisible();
      await conversation.screenshot({ path: info.outputPath(screenshot), animations: 'disabled' });
      await reopen.click();
      await expect(dialog.locator('.request-rows button')).toHaveCount(1);
      await dialog.getByRole('button', { name: '原始请求体' }).click();
      await dialog.getByRole('checkbox', { name: '格式化 JSON' }).uncheck();
      const body = [...bodies].reverse().find(value => value.includes(prompt));
      expect(body).toBeDefined();
      await expect.poll(() => dialog.locator('.request-source > pre').textContent()).toBe(body);
      await toggle.click();
      await expect(toggle).not.toBeChecked();
      await win.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect(reopen).toHaveCount(0);
    }

    await win.locator('.agent-ws-stack-item.is-active .agent-notify-chat').click();
    const scheduler = win.locator('.agent-float-anchor > .agent-float-panel');
    await recordInConversation(scheduler, 'Scheduler recording fixture one.', 'recording-scheduler-dark.png');
    await scheduler.getByRole('button', { name: '收起', exact: true }).click();
    await expect(scheduler).toHaveCount(0);
    await expect.poll(() => win.evaluate(id => window.api.agentSession.modelRequests(`scheduler:${id}`).then(rows => rows.length), workspaceId)).toBe(1);

    await win.evaluate(() => window.api.extensionCatalog.trust({ scope: 'global', extensionId: 'daily-report', mode: 'trusted-persistent' }));
    const tools = win.getByRole('button', { name: '展开更多工具' });
    if (await tools.isVisible()) await tools.click();
    await win.getByRole('treeitem', { name: '工作日报' }).click();
    const agentToggle = win.getByTestId('extension-agent-toggle').filter({ visible: true });
    if (await agentToggle.getAttribute('aria-pressed') !== 'true') await agentToggle.click();
    expect((await win.evaluate(() => window.api.themes.activate('light'))).ok).toBe(true);
    await expect(win.locator('html')).toHaveAttribute('data-theme', 'light');
    await recordInConversation(win.locator('.ext-agent-sidebar'), 'Extension recording fixture two.', 'recording-extension-light.png');
    expect(await win.evaluate(id => window.api.agentSession.modelRequests(id).then(rows => rows.length), sessionId)).toBe(workerCalls);
  } finally { await app.close(); server.closeAllConnections(); server.close(); }
});
