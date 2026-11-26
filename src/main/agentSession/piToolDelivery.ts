import type { Agent, AgentEvent, AgentMessage } from '@earendil-works/pi-agent-core';
import type { VisibleAcknowledgementOutcome } from '../desktop/visibleActionCoordinator';

type PiAgent = Pick<Agent, 'signal' | 'state' | 'subscribe'>;
type UnconfirmedReason = 'invalidated' | 'result-mismatch' | 'result-not-observed' |
  'acknowledgement-failed' | 'acknowledgement-unknown' | 'tracker-closed';

export interface PiToolDeliveryExpectation {
  /** Native Pi call ID and engine tool name, bound by the host to this invocation. */
  toolCallId: string;
  toolName: string;
  /** Exact, complete text that the trusted host returned for the known result. */
  outputText: string;
  isCurrent(): boolean;
  /** Host-only closure: it must keep the coordinator delivery token out of model content. */
  acknowledge(): Promise<VisibleAcknowledgementOutcome>;
  /** Must report an unconfirmed outcome and require durable-state recovery, never replay. */
  onUnconfirmed(reason: UnconfirmedReason): void;
}

type Pending = PiToolDeliveryExpectation & { signal: AbortSignal };
type MessageRecord = Record<string, unknown>;

function record(value: unknown): MessageRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as MessageRecord : undefined;
}

/**
 * Receipt for the host-owned Pi agent-core, not a generic event adapter.
 *
 * In Pi 1.4.0, tool_execution_end precedes the toolResult message. turn_end is
 * emitted after that message was appended to the engine context; agent-core
 * first updates its state and awaits direct subscribers. We require the exact
 * result object in that state and the same turn's assistant call. This proves
 * acceptance by this engine, not delivery to or consumption by a remote model.
 * Callers must instantiate this with the actual host-owned agent, register only
 * host-derived expectations before returning a known result, and bind their
 * isCurrent/acknowledge closures to the originating session, turn, desktop run
 * and indicator. A completed seat operation's signal no longer follows the
 * run; a retired semantic session's signal is already aborted on success.
 * Neither substitutes for the run's host-owned cancellation signal.
 */
export class PiToolDeliveryTracker {
  private readonly pending = new Map<string, Pending>();
  private readonly unsubscribe: () => void;
  private closed = false;

  constructor(private readonly agent: PiAgent) {
    if (!agent || typeof agent.subscribe !== 'function') throw new Error('A host-owned Pi agent is required');
    this.unsubscribe = agent.subscribe((event, signal) => this.observe(event, signal));
  }

  /** Register while the originating tool is still executing, before returning its text. */
  expect(input: PiToolDeliveryExpectation): void {
    const signal = this.agent.signal;
    if (this.closed || !signal || signal.aborted || !input ||
        typeof input.toolCallId !== 'string' || !input.toolCallId.trim() || input.toolCallId.length > 1024 ||
        typeof input.toolName !== 'string' || !input.toolName.trim() || input.toolName.length > 1024 ||
        typeof input.outputText !== 'string' || Buffer.byteLength(input.outputText, 'utf8') > 131072 ||
        typeof input.isCurrent !== 'function' || typeof input.acknowledge !== 'function' ||
        typeof input.onUnconfirmed !== 'function' || !input.isCurrent()) {
      throw new Error('Cannot register a Pi tool delivery expectation');
    }
    if (this.pending.has(input.toolCallId)) throw new Error('Pi tool call is already awaiting delivery');
    if (this.pending.size >= 256) throw new Error('Too many Pi tool deliveries awaiting confirmation');
    this.pending.set(input.toolCallId, { ...input, signal });
  }

  private fail(id: string, item: Pending, reason: UnconfirmedReason): void {
    this.pending.delete(id);
    item.onUnconfirmed(reason);
  }

  private async observe(event: AgentEvent, signal: AbortSignal): Promise<void> {
    if (this.closed || (event.type !== 'turn_end' && event.type !== 'agent_end')) return;
    for (const [id, item] of this.pending) {
      if (signal !== item.signal || signal.aborted || !item.isCurrent()) {
        this.fail(id, item, 'invalidated');
        continue;
      }
      if (event.type === 'agent_end') {
        this.fail(id, item, 'result-not-observed');
        continue;
      }
      const assistant = record(event.message);
      const calls = Array.isArray(assistant?.content)
        ? assistant.content.map(record).filter(call => call?.type === 'toolCall' && call.id === id)
        : [];
      if (!calls.length) continue;
      const results = event.toolResults.filter(result => result.toolCallId === id);
      const result = results.length === 1 ? record(results[0]) : undefined;
      const content = Array.isArray(result?.content) ? result.content : [];
      const part = content.length === 1 ? record(content[0]) : undefined;
      const state = this.agent.state.messages as AgentMessage[];
      const assistantIndex = state.indexOf(event.message);
      const resultIndex = result ? state.indexOf(results[0]) : -1;
      const sameIds = assistantIndex < 0 ? [] : state.slice(assistantIndex + 1)
        .map(record).filter(message => message?.role === 'toolResult' && message.toolCallId === id);
      const matches = assistant?.role === 'assistant' && calls.length === 1 && calls[0]?.name === item.toolName &&
        result?.role === 'toolResult' && result.toolName === item.toolName && result.isError === false &&
        part?.type === 'text' && part.text === item.outputText && Object.keys(part).every(key => key === 'type' || key === 'text') &&
        assistantIndex >= 0 && resultIndex > assistantIndex && sameIds.length === 1 && sameIds[0] === result;
      if (!matches) {
        this.fail(id, item, 'result-mismatch');
        continue;
      }
      // Consume before awaiting so duplicate events cannot start another acknowledgement.
      this.pending.delete(id);
      let outcome: VisibleAcknowledgementOutcome;
      try {
        outcome = await item.acknowledge();
      } catch {
        item.onUnconfirmed('acknowledgement-failed');
        continue;
      }
      if (outcome?.outcome !== 'acknowledged') item.onUnconfirmed('acknowledgement-unknown');
    }
  }

  /** A host turn that settles without a matching core event cannot deliver its remaining results. */
  invalidate(): void {
    if (this.closed) return;
    for (const [id, item] of this.pending) this.fail(id, item, 'invalidated');
  }

  /** Closing a connection never acknowledges anything it did not observe. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe();
    for (const [id, item] of this.pending) this.fail(id, item, 'tracker-closed');
  }
}
