import { prepareGuiInput } from '../../../src/main/attachments/guiInput';
import { resolveLlmConfig } from '../../../src/main/config';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { afterEach, expect, it, vi } from 'vitest';
import { applyLocaleSetting, t } from '../../../src/shared/i18n';
import { unixShortcutCommand } from '../../../src/main/systemShortcutCommand';
import { createSystemShortcutSender, shortcutScript } from '../../../src/main/systemShortcuts';
import { localizeSessionUserOperation } from '../../../src/main/sessions/userErrors';
import { deliverAgentMessage } from '../../../src/main/messages/deliver';
import { localizeMailboxUserText } from '../../../src/shared/mailboxUserErrors';

vi.mock('electron', () => ({ app: { getPath: () => '.', getAppPath: () => '.' } }));
vi.mock('../../../src/main/config', () => ({ resolveLlmConfig: vi.fn() }));

/** Exercise the actual registered handler while replacing its I/O dependencies. */
function handler(file: string, channel: string, dependencies: Record<string, unknown>): (...args: any[]) => any {
  const source = fs.readFileSync(path.join(process.cwd(), file), 'utf8');
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  let callback: ts.Node | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'handle' &&
        ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === channel) callback = node.arguments[1];
    ts.forEachChild(node, visit);
  };
  visit(ast);
  if (!callback) throw new Error(`Missing IPC handler: ${channel}`);
  const code = ts.transpileModule(`return (${callback.getText(ast)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(dependencies), code)(...Object.values(dependencies));
}

afterEach(() => { applyLocaleSetting('zh-CN'); });

it('localizes mailbox failures at the human IPC boundary without changing agent errors', async () => {
  const raw = await deliverAgentMessage({} as any, { from: 'human', to: 'session', text: ' ' }).catch(error => error);
  expect(raw.message).toBe('text 不能为空');
  const sendSessionMail = vi.fn(async () => { throw raw; });
  const send = handler('src/main/ipc/sessions.ts', 'sessions:sendMessage', { ctx: {}, sendSessionMail, localizeMailboxUserText });
  applyLocaleSetting('en');
  expect(await send(null, { sessionId: 'session', text: ' ' })).toEqual({ ok: false, message: 'text is required' });
  expect(raw.message).toBe('text 不能为空');
  sendSessionMail.mockRejectedValueOnce(new Error('邮箱索引读取失败，已保留原文件：邮箱包含无效或重复条目，需要修复原文件'));
  expect(await send(null, { sessionId: 'session', text: 'message' })).toEqual({ ok: false, message: 'Could not read the mailbox index; the original file was retained: The mailbox contains invalid or duplicate entries; repair the original file.' });
  sendSessionMail.mockRejectedValueOnce(new Error('外部原始错误'));
  expect(await send(null, { sessionId: 'session', text: 'message' })).toEqual({ ok: false, message: '外部原始错误' });
  sendSessionMail.mockRejectedValueOnce('外部异常值');
  expect(await send(null, { sessionId: 'session', text: 'message' })).toEqual({ ok: false, message: undefined });
});

it('localizes GUI send failures and still rejects a changed model before sending', async () => {
  applyLocaleSetting('en');
  const send = vi.fn();
  const session = { id: 'session', runtime: 'pi' };
  const ctx: any = { agentSessions: { send }, sessions: { get: () => session }, config: { get: () => ({}) } };
  let calls = 0;
  vi.mocked(resolveLlmConfig).mockImplementation(() => ({ model: { id: ++calls === 1 ? 'before' : 'after' },
    provider: { id: 'fixture', name: 'Fixture', api: 'openai-completions', models: [], apiKey: '', baseUrl: '' },
    openai: { model: 'fixture', baseUrl: '', apiKey: '' } }));
  const guiSend = handler('src/main/ipc/agentSession.ts', 'agentSession:send', { ctx, t, prepareGuiInput });
  expect(await guiSend(null, { sessionId: 'session', text: 'hello' })).toEqual({ ok: false, error: 'The model configuration changed while processing attachments. Send the message again.' });
  expect(send).not.toHaveBeenCalled();
  ctx.sessions.get = () => undefined;
  expect(await guiSend(null, { sessionId: 'missing', text: 'hello' })).toEqual({ ok: false, error: 'Session not found' });
});

it('localizes scheduler attachment races without dispatching the message', async () => {
  applyLocaleSetting('en');
  const send = vi.fn(); let calls = 0;
  const orchestrator = { getContextStatus: () => ({ provider: 'provider', modelId: 'model' }), send };
  const ctx = { config: { get: () => ({}) } };
  const schedulerSend = handler('src/main/ipc/fs.ts', 'chat:send', {
    ctx, orchestrator, t, resolveLlmConfig: () => ({ model: { id: ++calls === 1 ? 'before' : 'after' }, provider: { api: 'fixture' } }),
    prepareAttachments: async () => ({ text: 'hello', images: [{}] }), app: { getPath: () => '.', getAppPath: () => '.' }, path
  });
  expect(await schedulerSend(null, 'hello', 'ws', [{}])).toEqual({ accepted: false, error: 'The model configuration changed while processing attachments. Send the message again.' });
  expect(send).not.toHaveBeenCalled();
});

it.each(['win32', 'darwin', 'linux'])('localizes clipboard restrictions on %s without reading unauthorized input', async platform => {
  applyLocaleSetting('en');
  const clipboard = { availableFormats: vi.fn(() => []) };
  let caller = 'remote:1';
  const paste = handler('src/main/ipc/fs.ts', 'shell:clipboardFiles', {
    t, ipcCaller: () => ({ id: caller }), clipboard, process: { platform },
    clipboardFilePaths: () => ['/folder'], attachmentFs: { stat: async () => ({ isFile: () => false }) },
    convertMacClipboardPlist: async () => Buffer.alloc(0), randomUUID: () => 'id', path
  });
  await expect(paste({ sender: {} })).rejects.toThrow('Only local paste can read files from the system clipboard.');
  expect(clipboard.availableFormats).not.toHaveBeenCalled();
  caller = 'desktop:1';
  await expect(paste({ sender: {} })).rejects.toThrow('Pasting folders is not supported yet. Choose files instead.');
});

it('localizes shortcut authorization and missing-item errors before calling the platform adapter', () => {
  applyLocaleSetting('en');
  const sender = {}, sendSystemShortcut = vi.fn();
  const ctx = { getWindow: () => ({ webContents: sender }), config: { get: () => ({ systemShortcuts: [] }) } };
  const shortcut = handler('src/main/ipc/app.ts', 'app:runSystemShortcut', { ctx, t, sendSystemShortcut });
  expect(shortcut({ sender: {} }, 'deleted')).toEqual({ ok: false, error: 'Use system shortcuts from the desktop workbench.' });
  expect(shortcut({ sender }, 'deleted')).toEqual({ ok: false, error: 'This shortcut was removed. Reopen the menu.' });
  expect(sendSystemShortcut).not.toHaveBeenCalled();
});

it('localizes system shortcut failures on every platform without changing the command', async () => {
  const commandCases = [
    ['darwin', {}, '/usr/bin/osascript', 'Accessibility'],
    ['linux', { DISPLAY: ':1' }, 'xdotool', 'xdotool'],
    ['linux', { WAYLAND_DISPLAY: 'wayland-0' }, 'ydotool', 'ydotool'],
  ] as const;
  const before = commandCases.map(([platform, env]) => unixShortcutCommand('Ctrl+Alt+A', platform, env).args);
  applyLocaleSetting('en');
  for (let i = 0; i < commandCases.length; i++) {
    const [platform, env, executable, advice] = commandCases[i];
    const command = unixShortcutCommand('Ctrl+Alt+A', platform, env);
    expect(command.file).toBe(executable);
    expect(command.args).toEqual(before[i]);
    expect(command.help).toContain(advice);
    const send = createSystemShortcutSender(platform, env, async () => { throw new Error('upstream'); });
    expect((await send('Ctrl+Alt+A')).error).toContain('upstream');
  }
  expect(() => unixShortcutCommand('F24', 'darwin', {})).toThrow('macOS does not support this key');
  expect(() => unixShortcutCommand('F9', 'linux', {})).toThrow('No Linux graphical session detected');
  const windows = createSystemShortcutSender('win32', {}, async () => { throw new Error('upstream'); });
  expect((await windows('invalid')).error).toBe('Unsupported system shortcut.');
  expect((await windows('Ctrl+Alt+A')).error).toBe('Release modifier keys and check the target application permissions. upstream');
  expect(shortcutScript([65])).toContain('Release modifier keys and try again');
});

it('localizes a removed scheduled task without performing an update', () => {
  applyLocaleSetting('en');
  const update = vi.fn();
  const ctx = { tasks: { get: () => undefined, update } };
  const updateService = handler('src/main/ipc/workspaces.ts', 'services:update', { ctx, t });
  expect(() => updateService(null, 'removed', {})).toThrow('The task no longer exists.');
  expect(update).not.toHaveBeenCalled();
});

it('localizes session creation and delegation errors only at the user IPC boundary', async () => {
  const failure = new Error('父会话已归档或删除，不能创建子代理');
  const ctx = { sessions: { createTerminal: vi.fn(async () => { throw failure; }) } };
  const create = handler('src/main/ipc/sessions.ts', 'sessions:create', { ctx, localizeSessionUserOperation });
  const delegateTask = vi.fn(async () => { throw new Error('CLI 启动参数 --model 缺少值'); });
  const delegate = handler('src/main/ipc/sessions.ts', 'tasks:delegate', { ctx, delegateTask, localizeSessionUserOperation });
  applyLocaleSetting('en');
  await expect(create(null, {})).rejects.toThrow('The parent session was archived or deleted; a subagent cannot be created.');
  await expect(delegate(null, { task: 'x', isolate: false })).rejects.toThrow('The CLI launch argument --model is missing a value.');
  expect(failure.message).toBe('父会话已归档或删除，不能创建子代理');
  expect(() => localizeSessionUserOperation(() => { throw failure; })).toThrow('The parent session was archived or deleted; a subagent cannot be created.');
  expect(localizeSessionUserOperation(() => 42)).toBe(42);
  const external = new Error('第三方原始错误');
  ctx.sessions.createTerminal.mockRejectedValueOnce(external);
  await expect(create(null, {})).rejects.toBe(external);
  applyLocaleSetting('zh-CN');
  expect(() => localizeSessionUserOperation(() => { throw failure; })).toThrow(failure);
});
