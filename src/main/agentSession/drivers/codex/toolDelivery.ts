import { createHash } from 'node:crypto';
import { boundedVisibleActionResult } from '../../../desktop/visibleActionJson';
import type { VisibleAcknowledgementOutcome } from '../../../desktop/visibleActionCoordinator';
import type { GlobalDeliveryBinding, GlobalDeliveryIssuer, GlobalDeliveryStage } from '../../../desktop/globalDeliveryEvidenceVault';

type Failure = 'invalidated' | 'result-mismatch' | 'ambiguous' | 'acknowledgement-failed' | 'acknowledgement-unknown' | 'tracker-closed';

export interface CodexMcpDeliveryExpectation {
  /** These identities and the exact returned text are supplied by the host. */
  threadId: string;
  turnId: string;
  server: string;
  tool: string;
  arguments: unknown;
  invocationId: string;
  outputText: string;
  /** Host-captured stage; the issuer is kept separately by the tracker. */
  global?: Readonly<{ stage: GlobalDeliveryStage; binding: GlobalDeliveryBinding }>;
  isCurrent(): boolean;
  acknowledge(): Promise<VisibleAcknowledgementOutcome>;
  onUnconfirmed(reason: Failure): void;
}

type Pending = Omit<CodexMcpDeliveryExpectation, 'arguments'> & { argumentsKey: string };
type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue | undefined => value && typeof value === 'object' && !Array.isArray(value)
  ? value as RecordValue : undefined;
const validId = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && value.length <= 1024;
const current = (check: () => boolean): boolean => { try { return check() === true; } catch { return false; } };

function canonical(value: unknown): string {
  const input = boundedVisibleActionResult(value);
  const sort = (item: typeof input): typeof input => {
    if (Array.isArray(item)) return item.map(value => sort(value));
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => [key, sort(value)]));
    return item;
  };
  return createHash('sha256').update(JSON.stringify(sort(input))).digest('hex');
}

/**
 * Candidate receipt matching for the Codex 0.166 app-server event schema.
 * The host must feed only live, authenticated events for the same connection;
 * a replayed UI transcript or a gateway write is not a delivery receipt.
 * This primitive is not a claim that an event reached the remote model.
 */
export class CodexMcpToolDeliveryTracker {
  private readonly pending = new Map<string, Pending>();
  private readonly completedItems = new Set<string>();
  private closed = false;

  constructor(private readonly issuer?: GlobalDeliveryIssuer) {
    if (issuer !== undefined && typeof issuer?.withVerifiedEvent !== 'function') throw new Error('Invalid Codex delivery issuer');
  }

  expect(input: CodexMcpDeliveryExpectation): void {
    if (this.closed || !input || ![input.threadId, input.turnId, input.server, input.tool, input.invocationId].every(validId) ||
        !/^[0-9a-f-]{36}$/i.test(input.invocationId) || typeof input.outputText !== 'string' ||
        Buffer.byteLength(input.outputText, 'utf8') > 131072 || !input.outputText.includes(input.invocationId) ||
        typeof input.isCurrent !== 'function' || typeof input.acknowledge !== 'function' ||
        typeof input.onUnconfirmed !== 'function' || !current(input.isCurrent)) {
      throw new Error('Cannot register Codex MCP delivery expectation');
    }
    const global = input.global;
    if (!!global !== !!this.issuer || (global && (!global.stage || !global.binding || global.binding.engine !== 'codex' ||
        global.binding.engineTurnId !== input.turnId || global.binding.toolName !== input.tool ||
        ![global.binding.connectionId, global.binding.hostTurnId, global.binding.toolCallId].every(validId)))) {
      throw new Error('Codex global delivery expectation is unavailable');
    }
    const argumentsKey = canonical(input.arguments), previous = this.pending.get(input.invocationId);
    if (previous) {
      if (previous.threadId === input.threadId && previous.turnId === input.turnId && previous.server === input.server &&
          previous.tool === input.tool && previous.argumentsKey === argumentsKey && previous.outputText === input.outputText &&
          previous.global?.stage === global?.stage && JSON.stringify(previous.global?.binding) === JSON.stringify(global?.binding) &&
          current(previous.isCurrent)) return;
      throw new Error('Codex MCP delivery expectation conflicts with an existing invocation');
    }
    if (this.pending.size >= 256) throw new Error('Codex MCP delivery expectation capacity is exhausted');
    const { arguments: args, ...expectation } = input;
    void args;
    this.pending.set(input.invocationId, { ...expectation, argumentsKey,
      ...(global ? { global: Object.freeze({ stage: global.stage, binding: Object.freeze({ ...global.binding }) }) } : {}),
      isCurrent: input.isCurrent.bind(input), acknowledge: input.acknowledge.bind(input), onUnconfirmed: input.onUnconfirmed.bind(input) });
  }

  /** Must be awaited by the host before discarding the originating turn state. */
  async observe(raw: unknown): Promise<void> {
    if (this.closed) return;
    const message = record(raw), params = record(message?.params), item = record(params?.item);
    if (message?.method !== 'item/completed' || item?.type !== 'mcpToolCall' || !validId(item.id) ||
        !validId(params?.threadId) || !validId(params?.turnId) || this.completedItems.has(item.id)) return;
    let argumentsKey: string;
    try { argumentsKey = canonical(item.arguments); } catch { return; }
    const candidates = [...this.pending.values()].filter(entry => entry.threadId === params.threadId && entry.turnId === params.turnId &&
      entry.server === item.server && entry.tool === item.tool && entry.argumentsKey === argumentsKey);
    if (!candidates.length) return;
    if (this.completedItems.size >= 4096) {
      for (const candidate of candidates) this.fail(candidate, 'ambiguous');
      return;
    }
    this.completedItems.add(item.id);
    if (candidates.length !== 1) {
      for (const candidate of candidates) this.fail(candidate, 'ambiguous');
      return;
    }
    const candidate = candidates[0];
    if (!current(candidate.isCurrent)) { this.fail(candidate, 'invalidated'); return; }
    const result = record(item.result), content = Array.isArray(result?.content) ? result.content : [];
    const part = content.length === 1 ? record(content[0]) : undefined;
    if (item.status !== 'completed' || item.error != null || !result || result.structuredContent != null || result.structured_content != null ||
        result._meta != null || (result.isError !== undefined && result.isError !== false) ||
        Object.keys(result).some(key => !['content', 'structuredContent', 'structured_content', '_meta', 'isError'].includes(key)) ||
        part?.type !== 'text' || part.text !== candidate.outputText || Object.keys(part).some(key => key !== 'type' && key !== 'text')) {
      this.fail(candidate, 'result-mismatch');
      return;
    }
    this.pending.delete(candidate.invocationId);
    let outcome: VisibleAcknowledgementOutcome;
    try {
      if (candidate.global && this.issuer) {
        // Gateway call IDs and native item IDs are distinct. The candidate's
        // host ID is correlated only here, after a unique same-connection,
        // thread/turn/server/tool/arguments match and the exact output (which
        // carries its random invocation ID). item.id is independently consumed
        // above so that a native event cannot be reused.
        const binding = candidate.global.binding;
        outcome = await this.issuer.withVerifiedEvent(candidate.global.stage, { engine: 'codex',
          connectionId: binding.connectionId, hostTurnId: binding.hostTurnId, engineTurnId: params.turnId as string,
          toolCallId: binding.toolCallId, toolName: item.tool as string, outputText: part.text as string }, candidate.acknowledge);
      } else outcome = await candidate.acknowledge();
    }
    catch { this.notify(candidate, 'acknowledgement-failed'); return; }
    if (outcome?.outcome !== 'acknowledged') this.notify(candidate, 'acknowledgement-unknown');
    else if (!current(candidate.isCurrent)) this.notify(candidate, 'invalidated');
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const item of this.pending.values()) this.fail(item, 'tracker-closed');
  }

  private fail(item: Pending, reason: Failure): void { this.pending.delete(item.invocationId); this.notify(item, reason); }
  private notify(item: Pending, reason: Failure): void { try { item.onUnconfirmed(reason); } catch { /* observer is diagnostic only */ } }
}
