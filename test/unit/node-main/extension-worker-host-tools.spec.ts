import { beforeEach, expect, it, vi } from 'vitest';
import type { AppContext } from '../../../src/main/context';
import type { ExtensionToolContext } from '../../../src/main/extensions/extensionHostTool';
import { currentAgentWorkspaceId, isSchedulerInvocation, runAsAgentWorkspace, runAsSchedulerTool } from '../../../src/main/agent/agentScope';
import { currentTurnUserText, runWithTurnUserText } from '../../../src/main/agent/turnScope';
import { executeTool } from '../../../src/main/capabilities/executor';
import { executeExtensionHostTool } from '../../../src/main/extensions/executeExtensionHostTool';

vi.mock('../../../src/main/capabilities/executor', () => ({ executeTool: vi.fn() }));
vi.mock('../../../src/main/capabilities/hosts/browser', () => ({ browserHost: {} }));

const execute = vi.mocked(executeTool);
const workspace = { id: 'a', rootPath: '/workspace-a' };

function fixture(sessionId?: string) {
  let active = true;
  const rows = new Map([
    ['agent', { id: 'agent', name: 'Extension Agent', workspaceId: 'a' }],
    ['child', { id: 'child', name: 'Child Worker', workspaceId: 'a', parentSessionId: 'agent' }],
    ['other', { id: 'other', name: 'Other Worker', workspaceId: 'a' }],
    ['remote', { id: 'remote', name: 'Remote Worker', workspaceId: 'b' }]
  ]);
  const context = { workspaceId: 'a', sourceRootId: 'project-a', sourceRoot: workspace.rootPath, rootsRevision: 7, sessionId,
    manifest: { id: 'fixture', name: 'Fixture', permissions: ['hostTools'] },
    assertCurrent() { if (!active) throw new Error('Extension instance changed'); } } as ExtensionToolContext;
  const confirm = vi.fn(async () => ({ confirmed: true }));
  const prompt = vi.fn(async () => '  answer  ');
  const listFor = vi.fn((id: string) => id === 'agent' ? [] : [{ id: 'remote-task' }]);
  const killAndWait = vi.fn();
  const ctx = { config: { get: () => ({ workspaces: [workspace] }) }, ui: { confirm, prompt },
    sessions: { get: (id: string) => rows.get(id), peek: (id: string) => rows.get(id), resolveSessionRef: ({ sessionId }: { sessionId: string }) => ({ id: sessionId }) },
    bgTasks: { listFor, killAndWait } } as unknown as AppContext;
  const signal = new AbortController().signal;
  return { ctx, context, confirm, prompt, listFor, killAndWait, rows, signal, invalidate: () => { active = false; },
    call: (name: string, args: unknown) => executeExtensionHostTool(ctx, context, name, args, signal) };
}

beforeEach(() => {
  execute.mockReset();
  execute.mockImplementation(async (_ctx, name, args, opts) => {
    opts?.assertCurrent?.();
    return { ok: true, result: { name, args: JSON.parse(args), workspace: currentAgentWorkspaceId(),
      sessionId: opts?.callingSessionId, scheduler: isSchedulerInvocation(), userText: currentTurnUserText() } };
  });
});

it('routes original tools, new Worker tools and merged domains in the bound workspace', async () => {
  const { call, confirm } = fixture();
  await expect(runAsAgentWorkspace('b', () => runAsSchedulerTool(() => runWithTurnUserText('outer prompt', () =>
    call('host_browser_run', { action: 'tabs', params: {} }))))).resolves.toEqual({ name: 'browser.tabs',
    args: { __browserOwner: { workspaceId: 'a' } }, workspace: 'a', sessionId: undefined, scheduler: false, userText: undefined });
  await expect(call('host.sessions.observe', {})).resolves.toMatchObject({ name: 'sessions.observe', args: { workspaceId: 'a' } });
  await expect(call('host.workers.options', {})).resolves.toMatchObject({ name: 'workers.options', args: { rootId: 'project-a', workspaceId: 'a', cwd: workspace.rootPath } });
  await expect(call('host.llm.run', { action: 'quota', params: {} })).resolves.toMatchObject({ name: 'llm.quota' });
  await expect(call('host.llm.run', { action: 'setDefault', params: {} })).rejects.toThrow();
  await expect(call('host.terminal.capture', {})).rejects.toThrow(/did not declare/);
  expect(confirm).not.toHaveBeenCalled();
});

it('binds self and actor tools to the extension Agent and keeps a compound update under Worker policy', async () => {
  const { call } = fixture('agent');
  await expect(call('host.sessions.setStatus', { phase: 'done', sessionId: 'other' })).resolves.toMatchObject({ name: 'sessions.setStatus', args: { sessionId: 'agent', phase: 'done' }, sessionId: 'agent' });
  await expect(call('host.sessions.update', { name: 'New name' })).resolves.toMatchObject({ ok: true, completed: [{ tool: 'sessions.rename' }] });
  await expect(call('host.sessions.update', { sessionId: 'other', name: 'New name' })).rejects.toThrow(/only its own/);
  await expect(call('host.sessions.update', { sessionId: 'remote', archived: true })).rejects.toThrow(/outside/);
  await expect(call('host.sessions.update', { sessionId: 'child', archived: true })).resolves.toMatchObject({ ok: true,
    completed: [{ tool: 'sessions.setArchived', result: { args: { sessionIds: ['child'], archived: true, __actorSessionId: 'agent' } } }] });
  await expect(call('host.sessions.create', { asSubagent: true, inherit: true, isolation: 'shared' })).resolves.toMatchObject({ name: 'sessions.create',
    args: { asSubagent: true, inherit: true, rootId: 'project-a', __actorSessionId: 'agent' } });
  await expect(call('host.mail.send', { to: 'scheduler', text: 'done' })).resolves.toMatchObject({ name: 'sessions.message',
    args: { to: 'scheduler', __actorSessionId: 'agent' } });
  await expect(call('host.share.set', { text: 'working' })).resolves.toMatchObject({ args: { text: 'working', __actorSessionId: 'agent' } });
  await expect(call('host.bgtasks.list', {})).resolves.toBe('当前没有后台任务。');
  await expect(fixture().call('host.share.set', { text: 'working' })).rejects.toThrow(/sidebar Agent/);
  await expect(fixture().call('host.ui.notify', { workspaceId: 'a', sessionName: 'Toolbar', text: 'Ready' })).rejects.toThrow(/sidebar Agent/);
});

it('rejects forged scope, invalid run arguments and background tasks from other sessions', async () => {
  const { call, killAndWait, confirm } = fixture('agent');
  await expect(call('host.browser.run', { action: 'tabs', params: { __browserOwner: { workspaceId: 'b' } } })).rejects.toThrow(/caller identity/);
  await expect(call('host.browser.run', { action: 'upload', params: { workspaceId: 'b' } })).rejects.toThrow(/bound workspace/);
  await expect(call('host.browser.run', { action: 'navigate', params: {} })).rejects.toThrow();
  await expect(call('host.bgtasks.kill', { taskId: 'remote-task' })).rejects.toThrow(/outside the bound session/);
  expect(execute).not.toHaveBeenCalled();
  expect(killAndWait).not.toHaveBeenCalled();
  expect(confirm).not.toHaveBeenCalled();
});

it('uses the host question channel and rechecks liveness after approval', async () => {
  const f = fixture('agent');
  await expect(f.call('host.ask', { kind: 'text', title: 'What next?' })).resolves.toEqual({ cancelled: false, value: '  answer  ' });
  expect(f.prompt).toHaveBeenCalledOnce();
  const mcp = { server: 'fixture', tool: 'run', args: {} };
  await expect(f.call('host.mcp.call', mcp)).resolves.toMatchObject({ name: 'mcp.call', args: { __actorSessionId: 'agent' } });
  execute.mockClear();
  f.confirm.mockResolvedValueOnce({ confirmed: false });
  await expect(f.call('host.mcp.call', mcp)).rejects.toThrow(/denied/);
  f.confirm.mockImplementationOnce(async () => { f.invalidate(); return { confirmed: true }; });
  await expect(f.call('host.mcp.call', mcp)).rejects.toThrow(/instance changed/);
  expect(execute).not.toHaveBeenCalled();
});
