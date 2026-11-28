import { _electron, expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

test('ACP archive, restore and explicit deletion use the same bound native session', async ({}, info) => {
  const project = path.resolve(__dirname, '../..');
  const workspace = path.join(info.outputDir, 'workspace');
  const bin = path.join(info.outputDir, 'bin');
  const profile = path.join(info.outputDir, 'profile');
  const userData = path.join(info.outputDir, '.dev-sandbox', 'userData');
  for (const dir of [workspace, bin, profile, userData]) fs.mkdirSync(dir, { recursive: true });
  const fixture = path.join(bin, 'history.mjs');
  const state = path.join(info.outputDir, 'native-state.json');
  fs.writeFileSync(fixture, `
import fs from 'node:fs';
import readline from 'node:readline';
const state = ${JSON.stringify(state)};
const nativeId = 'history-fixture';
const reply = (id, result) => console.log(JSON.stringify({ jsonrpc:'2.0', id, result }));
const fail = (id, code, message) => console.log(JSON.stringify({ jsonrpc:'2.0', id, error:{code,message} }));
readline.createInterface({input:process.stdin}).on('line', line => {
  const { id, method, params } = JSON.parse(line);
  if (method === 'initialize') return reply(id, {
    protocolVersion:1,
    agentCapabilities:{loadSession:true,sessionCapabilities:{resume:{},list:{},delete:{},archive:{}}}
  });
  if (method === 'session/new') {
    if (fs.existsSync(state)) return fail(id,-32603,'must resume this fixture');
    fs.writeFileSync(state, JSON.stringify({id:nativeId,status:'active',prompts:0}));
    return reply(id, {sessionId:nativeId});
  }
  const record = JSON.parse(fs.readFileSync(state,'utf8'));
  if (params?.sessionId !== nativeId) return fail(id,-32002,'wrong session');
  if (method === 'session/prompt' || method === 'session/resume') {
    if (record.status !== 'active') return fail(id,-32002,'session is not active');
    if (method === 'session/resume') return reply(id,{sessionId:nativeId});
    record.prompts++;
    fs.writeFileSync(state, JSON.stringify(record));
    console.log(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:nativeId,
      update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'ACP history reply '+record.prompts}}}}));
    return reply(id,{stopReason:'end_turn'});
  }
  const statuses = {'session/archive':'archived','session/unarchive':'active','session/delete':'removed'};
  const next = statuses[method];
  if (!next) return fail(id,-32601,'unknown method');
  record.status = next;
  fs.writeFileSync(state, JSON.stringify(record));
  reply(id,{});
});
`);
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(bin, 'kimi.cmd'), `@"${process.execPath}" "${fixture}" %*\r\n`);
  } else {
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    fs.writeFileSync(path.join(bin, 'kimi'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixture)} "$@"\n`, { mode: 0o755 });
  }
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ locale: 'zh-CN', themeId: 'dark',
    activeWorkspaceId: 'acp-history', defaultCwd: workspace, workspaces: [{ id:'acp-history', name:'ACP History', path:workspace }],
    mcp: { enabled:false, servers:[] }, webAccess: { enabled:false } }));
  fs.writeFileSync(path.join(userData, 'sessions.json'), '[]');
  const inheritedEnv = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  const env: Record<string, string> = { ...inheritedEnv, MUSTER_SANDBOX: '1',
    MUSTER_INSTANCE_ID: path.basename(info.outputDir), HOME: profile, USERPROFILE: profile, APPDATA: profile, LOCALAPPDATA: profile };
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') ?? 'PATH';
  env[pathKey] = `${bin}${path.delimiter}${env[pathKey] ?? ''}`;
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'MUSTER_DEVTOOLS_PORT', 'MUSTER_WEB_PORT', 'MUSTER_NO_SANDBOX']) delete env[key];
  const app = await _electron.launch({ executablePath: require('electron'), args:[project, '--disable-gpu'], cwd:info.outputDir, env });
  try {
    const win = await app.firstWindow();
    await win.locator('.app-shell').waitFor();
    const session = await win.evaluate(async cwd => {
      const created = await window.api.sessions.create({ cwd, name:'ACP 原生历史', runtime:'acp', piModeId:'kimi' });
      await window.api.sessions.select(created.id);
      return created;
    }, workspace);
    const chat = win.locator(`.agent-chat-view[data-session-id="${session.id}"]`);
    const readState = () => fs.existsSync(state) ? JSON.parse(fs.readFileSync(state, 'utf8')) : undefined;
    const archive = async () => {
      await win.evaluate(id => window.api.sessions.setArchived(id, true), session.id);
      await expect.poll(async () => (await win.evaluate(() => window.api.sessions.list())).sessions.find(row => row.id === session.id)?.worktreeCleanupPending).toBeUndefined();
      expect(readState()?.status).toBe('archived');
    };
    expect((await win.evaluate(id => window.api.agentSession.send(id, 'first'), session.id)).ok).toBe(true);
    await expect(chat.getByText('ACP history reply 1', { exact:true })).toBeVisible();
    await expect.poll(async () => (await win.evaluate(id => window.api.agentSession.historyRange(id), session.id))?.busy).toBe(false);
    await archive();
    await win.evaluate(id => window.api.sessions.continueArchived(id), session.id);
    expect(readState()?.status).toBe('active');
    expect((await win.evaluate(id => window.api.agentSession.send(id, 'second'), session.id)).ok).toBe(true);
    await expect(chat.getByText('ACP history reply 2', { exact:true })).toBeVisible();
    await expect.poll(async () => (await win.evaluate(id => window.api.agentSession.historyRange(id), session.id))?.busy).toBe(false);
    await archive();
    await win.locator('.left-panel-scroll .panel-header.sub').first().hover();
    await win.getByRole('button', { name:/显示已归档的工作会话/ }).click();
    const row = win.locator(`[data-session-row="${session.id}"]`);
    await row.hover();
    await row.getByRole('button', { name:'永久删除' }).click();
    const dialog = win.getByRole('dialog', { name:'永久删除' });
    await expect(dialog.getByText(/同时从 Kimi Code 的列表移除 1 条会话记录/)).toBeVisible();
    await dialog.getByRole('button', { name:'永久删除' }).click();
    await expect.poll(readState).toMatchObject({ id:'history-fixture', status:'removed', prompts:2 });
    await expect.poll(async () => (await win.evaluate(() => window.api.sessions.list())).sessions.some(row => row.id === session.id)).toBe(false);
  } finally {
    await app.evaluate(({ app }) => app.exit()).catch(() => {});
    await app.close().catch(() => {});
  }
});
