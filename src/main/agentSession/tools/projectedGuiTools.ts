import type { AppContext } from '../../context';
import { randomUUID } from 'node:crypto';
import { modelToolResult } from '../../../shared/modelToolResult';
import { workerProjectedCatalog } from '../../capabilities/catalog/projectedCatalog';
import { executeProjectedHostCall } from '../../capabilities/projectedExecution';
import { captureProjectedSessionTarget } from '../../capabilities/projectedSessionTarget';
import { assertToolArguments } from '../../capabilities/schemaValidation';
import type { GuiDriverConnectInput, GuiHostTool } from '../types';
import { createGuiHostToolGateway, type GuiHostToolResult } from './gateway';
import { executeWorkerHostAsk } from './workerHostAsk';
import { currentMemoryTurn, type createPromptAuthorityScope } from '../../agent/turnScope';

type Input = Pick<GuiDriverConnectInput, 'sessionId' | 'cwd' | 'workspaceContext' | 'hostTools' |
  'getPolicyState' | 'getTurnId' | 'requestApproval' | 'requestUserQuestion' | 'nativePermissions'> & {
    getDesktopTurnId?(): string | undefined;
    getMemoryAuthority?(): ReturnType<typeof createPromptAuthorityScope> | undefined;
    beginTool?(): () => void;
  };

/** Build from an already filtered connection snapshot. Registration remains an atomic caller decision. */
export function buildProjectedGuiTools(ctx: Pick<AppContext, 'sessions'>, input: Input,
  options?: { isCurrent?: () => boolean }): GuiHostTool[] {
  const entries = workerProjectedCatalog(input.hostTools, !!input.requestUserQuestion);
  const gateway = createGuiHostToolGateway(input, options);
  return entries.map(entry => ({
    id: entry.name, label: entry.name, description: entry.def.description,
    parameters: entry.def.parameters as Record<string, unknown>, permissionClass: 'status',
    resultFormat: 'execute-result-json',
    async execute(raw, exec) {
      let releaseTool: (() => void) | undefined;
      let desktopDispatched = false;
      // 域壳化后桌面写操作只剩 host.desktop.run；按展开前的 action 判定，直调名保留作历史分支。
      const desktopMutation = ['host.desktop.act', 'host.desktop.focus', 'host.desktop.launch'].includes(entry.name) ||
        (entry.name === 'host.desktop.run' &&
          ['act', 'focus', 'launch'].includes(String((raw as { action?: unknown } | null)?.action ?? '')));
      let desktopStillCurrent: (() => boolean) | undefined;
      try {
        if (exec.sessionId !== input.sessionId || exec.cwd !== input.cwd) throw new Error('Host tool caller changed');
        assertToolArguments(entry.def.parameters, raw, entry.name);
        const turnId = input.getTurnId?.();
        const memoryAuthority = input.getMemoryAuthority?.();
        const desktopTurnId = entry.name.startsWith('host.desktop.') ? input.getDesktopTurnId?.() : undefined;
        const current = () => !exec.signal?.aborted && (options?.isCurrent?.() ?? true) &&
          (!input.getTurnId || (!!turnId && input.getTurnId() === turnId)) &&
          (!entry.name.startsWith('host.desktop.') || !input.getDesktopTurnId || (!!desktopTurnId && input.getDesktopTurnId() === desktopTurnId));
        desktopStillCurrent = current;
        if (!current()) throw new Error('The originating connection or request has closed.');
        releaseTool = input.beginTool?.();
        if (entry.name === 'host.ask') {
          if (!input.requestUserQuestion) throw new Error('Worker question channel is unavailable');
          const result = await executeWorkerHostAsk(raw, input.requestUserQuestion, exec.signal);
          if (!current()) throw new Error('The originating connection or request has closed.');
          return JSON.stringify({ ok: true, result });
        }
        let args = structuredClone(raw);
        let target: { id: string; parentSessionId?: string } | undefined;
        let targetCurrent = () => true;
        if (entry.name === 'host.sessions.update') {
          const ref = typeof args.sessionId === 'string' && args.sessionId.trim() ? args.sessionId : input.sessionId;
          const binding = captureProjectedSessionTarget(ref,
            id => ctx.sessions.get(ctx.sessions.resolveSessionRef({ sessionId: id }).id),
            id => ctx.sessions.peek(id));
          target = binding.target;
          targetCurrent = binding.isCurrent;
          args = { ...args, sessionId: target.id };
        }
        const prepared: Array<{ target: string; args: string; execute: () => Promise<GuiHostToolResult> }> = [];
        const invocationId = randomUUID();
        const result = await executeProjectedHostCall(entries, { kind: 'worker', sessionId: input.sessionId }, entry.name, args, target, {
          isCurrent: () => current() && targetCurrent(),
          async authorize(request) {
            const sourceArgs = { ...request.args }; delete sourceArgs.__actorSessionId;
            const item = await gateway.prepare(request.target, sourceArgs, { id: `${invocationId}:${prepared.length}`, signal: exec.signal });
            if (!item.ok) throw new Error(item.text);
            prepared.push({ target: request.target, args: JSON.stringify(sourceArgs), execute: item.execute });
            return () => current() && targetCurrent();
          },
          async dispatch(name, sourceArgs) {
            const next = prepared.shift();
            const clean = { ...sourceArgs }; delete clean.__actorSessionId;
            if (!next || next.target !== name || next.args !== JSON.stringify(clean)) throw new Error('Projected authorization does not match the operation');
            if (desktopMutation) desktopDispatched = true;
            // External MCP callbacks arrive outside the prompt's AsyncLocalStorage.
            const reply = await (memoryAuthority && !currentMemoryTurn() ? memoryAuthority.run(next.execute) : next.execute());
            if (entry.name !== 'host.sessions.update') return reply;
            // Only catalog envelopes are structured. A thrown error remains plain
            // text even if it happens to look like a successful JSON response.
            if (!reply.ok && !reply.errorEnvelope) throw new Error(reply.text);
            if (input.hostTools.find(tool => tool.id === name)?.resultFormat !== 'execute-result-json') {
              return { ok: reply.ok, text: reply.text };
            }
            const envelope = JSON.parse(reply.text);
            const effect = envelope.result;
            if (envelope.ok && effect && (effect.ok === false || (Array.isArray(effect.failed) && effect.failed.length))) return effect;
            return envelope;
          },
          async ask() { throw new Error('Worker question route is unavailable'); }
        });
        if (!current()) throw new Error('The originating connection or request has closed.');
        if (entry.name === 'host.sessions.update') return JSON.stringify(modelToolResult(entry.name, args, result));
        const response = result as GuiHostToolResult;
        if (!response.ok) return response.errorEnvelope ? response.text : JSON.stringify({ ok: false, error: response.text });
        try {
          const parsed: unknown = JSON.parse(response.text);
          if (parsed && typeof parsed === 'object' && typeof (parsed as { ok?: unknown }).ok === 'boolean') return response.text;
        } catch { /* Plain-text tools are wrapped in the common result envelope. */ }
        return JSON.stringify({ ok: true, result: response.text });
      } catch (error) {
        if (desktopDispatched && desktopStillCurrent && !desktopStillCurrent()) {
          return JSON.stringify({ ok: false, error: 'Desktop action outcome may be unknown after the originating instruction changed; observe before retrying.' });
        }
        return JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) });
      } finally { releaseTool?.(); }
    }
  }));
}
