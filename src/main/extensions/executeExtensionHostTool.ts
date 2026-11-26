import { runAsAgentWorkspace, runOutsideAgentScope } from '../agent/agentScope';
import { runAsNonUserTurn } from '../agent/turnScope';
import { buildBgTaskTools } from '../agentSession/tools/backgroundTasks';
import { buildNodeReplTools } from '../agentSession/tools/nodeRepl';
import { decideToolCallPermission, loadGuiUserToolRules } from '../agentSession/tools/policy';
import { requestPtyHostQuestion } from '../agentSession/tools/ptyHostQuestion';
import { executeWorkerHostAsk } from '../agentSession/tools/workerHostAsk';
import type { AppContext } from '../context';
import { executeTool, type ExecuteResult } from '../capabilities/executor';
import { extensionWorkerProjectedCatalog } from '../capabilities/catalog/projectedCatalog';
import { getToolDef } from '../capabilities/catalog/api';
import { runToolDomainOf } from '../capabilities/catalog/runTools';
import { expandRunToolCall } from '../capabilities/runRouter';
import { executeProjectedHostCall } from '../capabilities/projectedExecution';
import { resolveProjectedHostApiName } from '../capabilities/projectedHostRoute';
import { captureProjectedSessionTarget } from '../capabilities/projectedSessionTarget';
import { assertToolArguments } from '../capabilities/schemaValidation';
import { bindWorkerToolArgs, workerToolRequiresToken } from '../capabilities/workerBinding';
import { browserHost } from '../capabilities/hosts/browser';
import { controlRootFor } from '../../shared/workspaceRoots';
import { EXTENSION_HOST_TOOLS } from '../../shared/extension';
import { hostToolPermissionClass } from '../../shared/hostTools';
import { humanizeConfirmArgs } from '../../shared/confirmDialog';
import { assertExtensionToolScope, isBuiltinExtensionHostTool, prepareExtensionHostToolCall,
  resolveExtensionHostToolTarget, type ExtensionToolContext } from './extensionHostTool';

let workerCatalog: ReturnType<typeof extensionWorkerProjectedCatalog> | undefined;
const toolNames = EXTENSION_HOST_TOOLS.map(name => ({ name }));

function unpack(result: ExecuteResult): unknown {
  if (!result.ok) throw new Error(result.error || 'Extension host tool failed');
  return result.result;
}

export async function executeExtensionHostTool(ctx: AppContext, context: ExtensionToolContext, rawName: string,
  raw: unknown, signal: AbortSignal): Promise<unknown> {
  const name = resolveProjectedHostApiName(toolNames, rawName) ?? rawName;
  const resolveSession = (reference: string) => {
    try {
      const session = ctx.sessions.get(ctx.sessions.resolveSessionRef({ sessionId: reference }).id);
      return session?.workspaceId === context.workspaceId ? session : undefined;
    } catch { return undefined; }
  };
  const args = prepareExtensionHostToolCall(context, name, raw, resolveSession);
  const assertCurrent = () => { signal.throwIfAborted(); context.assertCurrent(); };
  return runOutsideAgentScope(() => runAsNonUserTurn(() => runAsAgentWorkspace(context.workspaceId, async () => {
    const usesWorkerIdentity = (name === 'host.mail.send' && !!context.sessionId) || (name === 'host.sessions.create' && args.asSubagent === true);
    if (isBuiltinExtensionHostTool(name) && !usesWorkerIdentity) {
      const target = resolveExtensionHostToolTarget(name, args);
      assertCurrent();
      if (target.name === 'tasks.render') return browserHost['tasks.render'](ctx, target.args, { signal });
      return unpack(await executeTool(ctx, target.name, JSON.stringify(target.args), { signal, assertCurrent }));
    }

    workerCatalog ??= extensionWorkerProjectedCatalog();
    const sessionId = context.sessionId;
    const caller = sessionId ? ctx.sessions.peek(sessionId) : undefined;
    const current = () => {
      assertCurrent();
      if (sessionId && (!caller || ctx.sessions.peek(sessionId) !== caller || caller.archived || caller.workspaceId !== context.workspaceId)) {
        throw new Error('Extension Agent session is no longer available');
      }
      return true;
    };
    current();
    if (args.params && typeof args.params === 'object' && !Array.isArray(args.params)) {
      assertExtensionToolScope(context, args.params as Record<string, unknown>);
    }
    const resolveBoundSession = (ref: unknown): string => {
      const session = typeof ref === 'string' && resolveSession(ref.trim());
      if (!session) throw new Error('Session is outside the bound workspace');
      return session.id;
    };
    const update = name === 'host.sessions.update'
      ? captureProjectedSessionTarget(resolveBoundSession(args.sessionId === undefined ? requireSession() : args.sessionId), resolveSession, id => ctx.sessions.peek(id))
      : undefined;
    if (update) args.sessionId = update.target.id;
    const isCurrent = () => {
      current();
      if (update && !update.isCurrent()) throw new Error('Extension host tool target changed');
      return true;
    };
    const prepared: Array<{ target: string; execute: () => Promise<unknown> }> = [];
    const bgTools = name.startsWith('host.bgtasks.') ? buildBgTaskTools(ctx) : [];
    const replTools = name === 'host.node_repl.js' ? buildNodeReplTools(ctx) : [];

    function requireSession(): string {
      if (!sessionId) throw new Error(`${name} requires this extension to declare a sidebar Agent`);
      return sessionId;
    }

    async function prepare(source: string, input: Readonly<Record<string, unknown>>) {
      const envelope = { ...input };
      // The update planner adds this field to its internal archive operation.
      delete envelope.__actorSessionId;
      const domain = runToolDomainOf(source);
      const run = domain ? expandRunToolCall(source, envelope) : undefined;
      const target = run?.targetTool ?? source;
      const special = [...bgTools, ...replTools].find(tool => tool.id === target);
      if (special || target === 'turnChanges.trackFiles' || (workerToolRequiresToken(target) && target !== 'workers.options')) requireSession();
      const workspace = ctx.config.get().workspaces.find(item => item.id === context.workspaceId);
      if (!workspace) throw new Error('Extension workspace is unavailable');
      const original = run?.args ?? envelope;
      const permissionClass = hostToolPermissionClass(target) ?? hostToolPermissionClass(source) ?? 'read';
      const evaluate = () => decideToolCallPermission({ mode: 'standard', planExecuting: false,
        engineToolName: run && target === source ? source : target, input: run && target === source ? envelope : original,
        cwd: context.sourceRoot, hostToolIds: [target], hostClassOf: () => permissionClass,
        userRules: loadGuiUserToolRules(controlRootFor(workspace)) });
      const decision = evaluate();
      if (decision.decision === 'deny') throw new Error(decision.ruleReason ?? 'Extension host tool denied by workspace policy');
      const effective = run && target === source ? expandRunToolCall(source, decision.updatedInput).args : decision.updatedInput;
      assertExtensionToolScope(context, effective);
      const schema = special?.parameters ?? (run
        ? domain?.actions.find(action => action.action === run.action)?.def.parameters
        : getToolDef(target)?.parameters);
      if (schema) assertToolArguments(schema, effective, target);
      const bound = { ...effective };
      for (const key of ['sessionId', 'externalSessionId', 'subject', 'mailboxWorkspaceId'] as const) {
        if (bound[key] === undefined) continue;
        if (key === 'mailboxWorkspaceId') {
          if (bound[key] !== context.workspaceId) throw new Error('Mailbox is outside the bound workspace');
        } else bound[key] = resolveBoundSession(bound[key]);
      }
      for (const key of ['sessionIds', 'emitters'] as const) {
        if (Array.isArray(bound[key])) bound[key] = bound[key].map(resolveBoundSession);
      }
      if (target === 'sessions.message' && bound.to !== 'scheduler' && bound.to !== `orchestrator:${context.workspaceId}`) {
        bound.to = resolveBoundSession(bound.to);
      }
      if (target === 'waitFor' && bound.condition && typeof bound.condition === 'object' &&
          'sessionId' in bound.condition && bound.condition.sessionId !== undefined) {
        bound.condition = { ...bound.condition, sessionId: resolveBoundSession(bound.condition.sessionId) };
      }
      if ((bound.rootId !== undefined && bound.rootId !== context.sourceRootId) ||
          (bound.rootsRevision !== undefined && bound.rootsRevision !== context.rootsRevision) ||
          (bound.cwd !== undefined && bound.cwd !== context.sourceRoot)) throw new Error('Host tool target is outside the bound project');
      if (target === 'workers.options') Object.assign(bound, { workspaceId: context.workspaceId,
        rootId: context.sourceRootId, cwd: context.sourceRoot, rootsRevision: context.rootsRevision });
      if (Array.isArray(bound.isolationGroups) && bound.isolationGroups.some(group => group?.rootId !== context.sourceRootId)) {
        throw new Error('Isolated repositories must belong to the bound project');
      }
      if (update && JSON.stringify(bound.sessionIds ?? bound.sessionId) !== JSON.stringify(original.sessionIds ?? original.sessionId)) {
        throw new Error('A workspace rule cannot change the approved session update target');
      }
      if (target === 'bgtasks.kill') {
        const id = requireSession();
        if (!ctx.bgTasks?.listFor(id).some(task => task.id === bound.taskId)) throw new Error('Background task is outside the bound session');
        bound.initiator = 'model';
      }
      const authorized = JSON.stringify(decision);
      const validate = () => {
        isCurrent();
        if (JSON.stringify(evaluate()) !== authorized) throw new Error('Extension host tool policy changed before execution');
      };
      if (decision.decision === 'prompt') {
        const response = await ctx.ui.confirm(`${context.manifest.name} · ${name}`, humanizeConfirmArgs(bound), { dangerous: true, signal });
        if (!response.confirmed) throw new Error('User denied the extension host tool call');
      }
      validate();
      return async () => {
        validate();
        if (special) return special.execute(bound, { sessionId: requireSession(), cwd: context.sourceRoot, signal });
        const toolArgs = sessionId ? bindWorkerToolArgs(ctx, target, bound, sessionId) : bound;
        if (!sessionId && target.startsWith('browser.')) toolArgs.__browserOwner = { workspaceId: context.workspaceId };
        if (run && target === source) {
          delete toolArgs.__actorSessionId;
          return unpack(await executeTool(ctx, target, JSON.stringify({ action: run.action, params: toolArgs }), { signal, callingSessionId: sessionId, assertCurrent: validate }));
        }
        return unpack(await executeTool(ctx, target, JSON.stringify(toolArgs), { signal, callingSessionId: sessionId, assertCurrent: validate }));
      };
    }

    return executeProjectedHostCall(workerCatalog, { kind: 'worker', sessionId: sessionId ?? '' }, name, args, update?.target, {
      isCurrent,
      async authorize(request) {
        if (name !== 'host.ask') prepared.push({ target: request.target, execute: await prepare(request.target, request.args) });
        return isCurrent;
      },
      async dispatch(target) {
        const authorization = prepared.shift();
        if (authorization?.target !== target) throw new Error('Missing extension host tool authorization');
        return authorization.execute();
      },
      async ask() {
        const result = await executeWorkerHostAsk(args, (question, abort) => requestPtyHostQuestion(ctx.ui, context.manifest.name, question, abort), signal);
        isCurrent();
        return result;
      }
    });
  })));
}
