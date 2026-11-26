import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
import { DesktopActivity } from '../../../src/main/desktop/desktopActivity';
import { DesktopTurns } from '../../../src/main/desktop/desktopTurns';

function chatSend(dependencies: Record<string, unknown>): (...args: any[]) => any {
  const file = path.join(process.cwd(), 'src/main/ipc/fs.ts');
  const ast = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  let callback: ts.Node | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'handle' &&
      ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === 'chat:send') callback = node.arguments[1];
    ts.forEachChild(node, visit);
  };
  visit(ast);
  if (!callback) throw new Error('chat:send handler is unavailable');
  const code = ts.transpileModule(`return (${callback.getText(ast)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(dependencies), code)(...Object.values(dependencies));
}

it('keeps a scheduler instruction bound to its acceptance time and workspace while attachments are processed', async () => {
  const labels = { active: 'Using', stopping: 'Stopping', unknown: 'Unknown', escape: 'Esc', stop: 'Stop', escapeUnavailable: 'Use button' };
  const turns = new DesktopTurns(new DesktopActivity({ show: async () => {}, close: () => {} }, async () => {}, labels));
  const noted = vi.spyOn(turns, 'noteUserInstruction');
  let entered!: () => void, finish!: () => void, completed!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const dispatched = new Promise<void>(resolve => { completed = resolve; });
  let seenWorkspace: string | undefined, failure: unknown;
  const orchestrator = {
    workspaceId: 'first', getContextStatus: () => ({ provider: 'test', modelId: 'test' }),
    checkSendImages: () => ({ ok: true }),
    async send(_text: string, workspaceId: string, _images: unknown, opts: { messageId: string; desktopInstructionNoted: boolean }) {
      seenWorkspace = workspaceId;
      const owner = `orchestrator:${workspaceId}`;
      if (!opts.desktopInstructionNoted) turns.noteUserInstruction(owner, opts.messageId);
      turns.begin(owner, 'turn', () => true, true, opts.messageId);
      try { await turns.use(owner, 'turn', 'target', async () => 1); } catch (error) { failure = error; }
      completed();
    }
  };
  const ctx = { desktopTurns: () => turns, config: { get: () => ({}) } };
  const send = chatSend({ ctx, orchestrator, t: (s: string) => s, randomUUID: () => 'fixed-message',
    resolveLlmConfig: () => ({ model: { id: 'test' }, provider: { api: 'test' } }),
    prepareAttachments: async () => { entered(); await gate; return { text: 'prepared', images: [] }; },
    app: { getPath: () => '.', getAppPath: () => '.' }, path });
  const result = send(null, 'user message', undefined, [{ data: 'x', mimeType: 'text/plain' }]);
  await started;
  expect(noted).toHaveBeenCalledExactlyOnceWith('orchestrator:first', 'fixed-message');
  await turns.stop();
  orchestrator.workspaceId = 'second';
  finish();
  expect(await result).toEqual({ accepted: true });
  await dispatched;
  expect(seenWorkspace).toBe('first');
  expect(noted).toHaveBeenCalledOnce();
  expect(String(failure)).toMatch(/predates the latest stop/);
});
