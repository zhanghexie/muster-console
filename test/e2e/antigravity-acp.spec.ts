import { _electron, expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { legacyWorkspaceRootId } from '../../src/shared/workspaceRoots';

const live = process.env.MUSTER_E2E_LIVE_ANTIGRAVITY === '1';

test(`Antigravity built-in ACP chats through ${live ? 'the installed CLI' : 'a protocol fixture'}`, async ({}, info) => {
  test.setTimeout(live ? 120_000 : 60_000);
  const project = path.resolve(__dirname, '../..');
  const cwd = info.outputDir;
  const userData = path.join(cwd, '.dev-sandbox', 'userData');
  const workspace = path.join(cwd, 'workspace');
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
    locale: 'zh-CN', themeId: 'dark', defaultRuntime: 'acp', activeWorkspaceId: 'agy-fixture',
    workspaces: [{ id: 'agy-fixture', name: 'Antigravity smoke test', path: workspace }],
    webAccess: { enabled: false }, mcp: { enabled: false, servers: [] }
  }));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'MUSTER_DEVTOOLS_PORT', 'MUSTER_WEB_PORT', 'MUSTER_NO_SANDBOX']) delete env[key];
  env.MUSTER_SANDBOX = '1';
  env.MUSTER_INSTANCE_ID = `agy-acp-${process.pid}`;
  if (!live) {
    const bin = path.join(cwd, 'bin');
    fs.mkdirSync(bin);
    const script = path.join(bin, 'agy-fixture.mjs');
    const fakeAgent = pathToFileURL(path.join(project, 'test/helpers/acp-fake-agent.mjs')).href;
    fs.writeFileSync(script, `
import assert from 'node:assert/strict';
assert.deepEqual(process.argv.slice(2), ['acp']);
process.env.ACP_FAKE_SCENARIO = 'text';
await import(${JSON.stringify(fakeAgent)});
`);
    if (process.platform === 'win32') {
      fs.writeFileSync(path.join(bin, 'agy.cmd'), `@"${process.execPath}" "${script}" %*\r\n`);
    } else {
      const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
      fs.writeFileSync(path.join(bin, 'agy'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`, { mode: 0o755 });
    }
    const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') ?? 'PATH';
    env[pathKey] = `${bin}${path.delimiter}${env[pathKey] ?? ''}`;
  }

  const app = await _electron.launch({ executablePath: require('electron'), args: [project, '--disable-gpu'], cwd, env });
  try {
    const win = await app.firstWindow();
    await win.locator('.app-shell').waitFor();
    const available = await win.evaluate(() => window.api.runtimes.availability(true));
    expect(available.acpAgents).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'antigravity' })]));
    expect(path.basename(available.acpExecutables?.antigravity ?? '')).toMatch(/^agy(?:\.exe|\.cmd|\.bat)?$/i);
    if (live) {
      const source = { workspaceId: 'agy-fixture', rootId: legacyWorkspaceRootId('agy-fixture') };
      const catalog = await win.evaluate(source => window.api.agentSession.listAcpModels({
        source, agentId: 'antigravity', requestId: 'agy-live-catalog', refresh: true
      }), source);
      if (!catalog.ok) throw new Error(catalog.error);
      expect(catalog.items.length).toBeGreaterThan(0);
    }
    const openTask = win.getByTitle(/新建任务（先填任务再拉起会话）/);
    await openTask.locator('..').locator('..').hover();
    await openTask.click();
    const task = win.getByRole('dialog', { name: '新建任务', exact: true });
    await task.getByRole('button', { name: '选择 Harness 和模型' }).click();
    const picker = win.getByRole('dialog', { name: '选择 Harness 和模型' });
    await picker.getByRole('tab', { name: 'Antigravity', exact: true }).click();
    await picker.screenshot({ path: info.outputPath('antigravity-picker.png'), animations: 'disabled' });
    await picker.getByRole('button', { name: '确认配置' }).click();
    await task.getByRole('textbox', { name: '会话名称' }).fill('Antigravity smoke test');
    await task.getByRole('button', { name: '新建空白', exact: true }).click();
    const readSession = () => win.evaluate(async () => (await window.api.sessions.list()).sessions.find(session => session.piModeId === 'antigravity'));
    await expect.poll(readSession).toMatchObject({ runtime: 'acp', piModeId: 'antigravity' });
    const session = (await readSession())!;
    const chat = win.locator(`.agent-chat-view[data-session-id="${session.id}"]`);
    const reply = live ? 'AGY_MUSTER_OK' : '你好 ACP';
    const input = chat.getByRole('textbox');
    await input.fill(`Reply with exactly ${reply}. Do not use any tools.`);
    await input.press('Enter');
    const turn = () => win.evaluate(async id => {
      const history = await window.api.agentSession.historyRange(id);
      return { busy: history?.busy, answer: history?.messages.filter(message => message.role === 'assistant').at(-1) };
    }, session.id);
    await expect.poll(turn, { timeout: live ? 65_000 : 20_000 }).toMatchObject({ busy: false, answer: { finishedAt: expect.any(Number) } });
    const { answer } = await turn();
    expect(answer?.error).toBeUndefined();
    expect(answer?.parts.flatMap(part => part.kind === 'text' ? [part.text] : []).join('').trim()).toBe(reply);
    await expect(chat.getByText(reply, { exact: true })).toBeVisible();
    await chat.screenshot({ path: info.outputPath('antigravity-chat.png'), animations: 'disabled' });
  } finally {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
  }
});
