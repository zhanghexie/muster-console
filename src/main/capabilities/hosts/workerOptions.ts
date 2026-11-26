import type { AppContext } from '../../context';
import type { WorkerTargetConfig } from '../../../shared/workerRouting';
import { WORKER_ROUTING_SETTINGS_LOCATION } from '../../../shared/workerRouting';
import { resolveSessionTarget } from '../../sessions/targets';
import { assertWorkerSourceCurrent, mintWorkerReference, readWorkerRoutingConfig, summarizeWorkerRoutingTiers, workerToolSource } from '../../tasks/workerRouting';
import { listWorkerHarnesses, optionText, readWorkerNativeCatalog, validateWorkerConfig, WorkerOptionError } from '../../tasks/workerRoutingCatalog';
import { cooldownFor } from '../../tasks/workerRoutingPolicy';
import { currentAgentSessionId } from '../../agent/agentScope';
import { guiMessageText, type GuiChatMessage } from '../../../shared/guiWorker';
import { clipObservationText } from '../../../shared/sessionObservation';

type OptionsInput = { mode?: 'tiers' | 'harnesses' | 'models' | 'native-settings'; harnessId?: string; surface?: 'gui' | 'cli'; q?: string;
  limit?: number; offset?: number; modelId?: string; providerId?: string; modelParameters?: Record<string, string>; reasoning?: string;
  parameterId?: string; optionOffset?: number;
  workspaceId?: string; rootId?: string; cwd?: string; rootsRevision?: number };

export const workerOptionsHost = {
  'workers.context': (ctx: AppContext, args: { before?: number; messageId?: string; bodyOffset?: number }) => {
    const sessionId = currentAgentSessionId();
    const session = sessionId && ctx.sessions.get(sessionId);
    if (!session || session.archived || (session.workerRouting?.attempts.length ?? 0) < 2 || !ctx.agentSessions) {
      throw new WorkerOptionError('A current Worker handoff session is required.');
    }
    const offset = (value: number | undefined): number | undefined => {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new WorkerOptionError('Invalid Worker history offset.');
      return value;
    };
    const history = ctx.agentSessions.getHistoryRange(session.id, offset(args.before), 8, args.messageId);
    if (!history) throw new WorkerOptionError('Worker history is unavailable.');
    const body = (message: GuiChatMessage): string => [guiMessageText(message), ...message.parts.flatMap(part => part.kind === 'tool' && ['ok', 'error'].includes(part.tool.status)
      ? [JSON.stringify({ tool: part.tool.name, status: part.tool.status, output: part.tool.output, patch: part.tool.patch })] : []),
      ...(message.error ? [message.error] : [])].filter(Boolean).join('\n');
    if (args.messageId !== undefined) {
      if (!optionText(args.messageId)) throw new WorkerOptionError('Invalid Worker history message ID.');
      const message = history.messages.find(item => item.id === args.messageId && !item.queued);
      if (!message) throw new WorkerOptionError('Worker history message is unavailable.');
      const text = body(message);
      const start = offset(args.bodyOffset) ?? 0;
      if (start > text.length) throw new WorkerOptionError('Worker history offset exceeds the body.');
      const end = start + 3500;
      const page = text.slice(start, end - Number(/[\uD800-\uDBFF]/.test(text[end - 1] ?? '') && /[\uDC00-\uDFFF]/.test(text[end] ?? '')));
      return { messageId: message.id, role: message.role, text: page, totalChars: text.length,
        nextOffset: start + page.length < text.length ? start + page.length : null };
    }
    if (args.bodyOffset !== undefined) throw new WorkerOptionError('Worker history bodyOffset requires messageId.');
    return { messages: history.messages.filter(message => !message.queued).map(message => ({
      messageId: message.id, role: message.role, ...clipObservationText(body(message), 450)
    })), nextBefore: history.hasEarlier ? history.before : null };
  },
  'workers.options': async (ctx: AppContext, args: OptionsInput) => {
    const source = workerToolSource(ctx, args);
    const target = await resolveSessionTarget(ctx.config.get(), source);
    const mode = args.mode ?? (args.harnessId ? 'models' : 'tiers');
    if (mode === 'tiers') {
      const config = ctx.config.get();
      const definitions = readWorkerRoutingConfig(config, target.workspaceId);
      const tiers = summarizeWorkerRoutingTiers(config, target.workspaceId).map(tier => ({ ...tier,
        coolingDown: definitions.tiers.find(definition => definition.id === tier.tierId)!.members.filter(member => member.enabled && !!cooldownFor(ctx, target, member.config)).length }));
      return { tiers, ...(tiers.some(tier => tier.enabledCandidates > 0) ? {} : { setup: WORKER_ROUTING_SETTINGS_LOCATION }) };
    }
    const failover = (surface: 'cli' | 'gui', runtimeId: string) => surface === 'cli' ? 'before-launch' : runtimeId === 'codex-gui'
      ? 'native-settlement-and-cross-harness-with-user-consent' : 'native-settlement-within-harness';
    if (mode === 'harnesses') return { harnesses: listWorkerHarnesses(ctx).map(item => ({ ...item, tierFailover: failover(item.surface, item.runtimeId) })) };
    if ((mode !== 'models' && mode !== 'native-settings') || !optionText(args.harnessId) || (args.surface !== 'gui' && args.surface !== 'cli')) throw new WorkerOptionError('Choose a Harness and its gui or cli surface.');
    const harness = listWorkerHarnesses(ctx).find(item => item.harnessId === args.harnessId && item.surface === args.surface);
    if (!harness?.enabled) throw new WorkerOptionError('Harness or surface unavailable. Read workers.options in harnesses mode.');
    const { name: _name, enabled: _enabled, ...identity } = harness;
    if (mode === 'native-settings') {
      if (identity.surface !== 'gui' || identity.runtimeId === 'pi' || !ctx.agentSessions) throw new WorkerOptionError('Choose an external GUI Harness.');
      const nativeConfig = await ctx.agentSessions.describeNativeConfig({ runtime: identity.runtimeId, piModeId: identity.acpPresetId,
        workspaceId: target.workspaceId, sourceRoot: target.sourceRoot, cwd: target.cwd });
      assertWorkerSourceCurrent(ctx, target);
      return { harness: identity, nativeConfig };
    }
    const tierFailover = failover(identity.surface, identity.runtimeId);
    const catalog = await readWorkerNativeCatalog(ctx, identity, target);
    if (catalog.state === 'unknown') return { harness: identity, tierFailover, status: 'unknown', reason: catalog.reason, models: [] };
    if (args.q !== undefined && !optionText(args.q, 160)) throw new WorkerOptionError('Invalid model search.');
    if (args.modelId !== undefined && !optionText(args.modelId, 2048)) throw new WorkerOptionError('Invalid model id.');
    if (args.providerId !== undefined && !optionText(args.providerId, 512)) throw new WorkerOptionError('Invalid provider id.');
    if (args.parameterId !== undefined && (!args.modelId || !optionText(args.parameterId))) throw new WorkerOptionError('Choose an exact model before reading a parameter.');
    if (args.optionOffset !== undefined && (!args.parameterId || !Number.isSafeInteger(args.optionOffset) || args.optionOffset < 0)) throw new WorkerOptionError('Invalid model option offset.');
    if ((args.modelParameters !== undefined || args.reasoning !== undefined) && !args.modelId) throw new WorkerOptionError('Choose a model id before setting model parameters.');
    if (args.reasoning !== undefined && identity.surface !== 'cli') throw new WorkerOptionError('GUI reasoning is part of modelParameters.');
    const q = args.q?.toLowerCase();
    const matched = catalog.items.filter(item => (!q || `${item.providerId}/${item.modelId} ${item.name}`.toLowerCase().includes(q)) &&
      (args.modelId === undefined || item.modelId === args.modelId || item.nativeModelId === args.modelId) &&
      (args.providerId === undefined || item.providerId === args.providerId));
    if (args.modelId && matched.length !== 1) throw new WorkerOptionError('Model unavailable or ambiguous. Specify its exact modelId and providerId.');
    const offset = Number.isSafeInteger(args.offset) ? Math.max(0, args.offset!) : 0;
    const limit = Number.isSafeInteger(args.limit) ? Math.min(8, Math.max(1, args.limit!)) : 6;
    const models = [];
    for (const model of matched.slice(offset, offset + limit)) {
      const config: WorkerTargetConfig = identity.surface === 'gui'
        ? { ...identity, model: { providerId: model.providerId, modelId: model.modelId }, modelParameters: args.modelParameters }
        : { ...identity, cliLaunchOptions: { model: model.nativeModelId ?? model.modelId, reasoning: args.reasoning }, modelParameters: args.modelParameters };
      try {
        const reference = await mintWorkerReference(ctx, target, config, catalog);
        const { parameters } = await validateWorkerConfig(ctx, target, reference.config, true, catalog);
        const selected = args.parameterId ? parameters.filter(parameter => parameter.id === args.parameterId) : parameters;
        if (args.parameterId && !selected.length) throw new WorkerOptionError('Model parameter is not available.');
        const optionOffset = args.optionOffset ?? 0;
        const parameterRows = selected.slice(0, args.modelId ? 8 : 3).map(parameter => {
          const options = parameter.options.slice(optionOffset, optionOffset + 8);
          return { id: parameter.id, semantic: parameter.semantic, defaultValue: parameter.defaultValue,
            options: args.parameterId ? options : options.map(option => option.value),
            ...(optionOffset + options.length < parameter.options.length ? { nextOptionOffset: optionOffset + options.length } : {}) };
        });
        models.push({ modelId: model.modelId, providerId: model.providerId, name: model.name, parameters: parameterRows,
          ...(parameterRows.length < selected.length ? { parameterIds: selected.map(parameter => parameter.id) } : {}), targetRef: reference.targetRef });
      } catch (error) {
        if (args.modelId || !(error instanceof WorkerOptionError)) throw error;
        models.push({ modelId: model.modelId, providerId: model.providerId, name: model.name, status: error.availability, reason: error.message });
      }
    }
    assertWorkerSourceCurrent(ctx, target);
    return { harness: identity, tierFailover, status: 'ready', models, ...(offset + limit < matched.length ? { nextOffset: offset + limit } : {}) };
  }
};
