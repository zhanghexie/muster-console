import type { Agent } from '@earendil-works/pi-agent-core';
import { createHash } from 'node:crypto';
import type { VisibleAcknowledgementOutcome } from '../../../desktop/visibleActionCoordinator';
import { PiToolDeliveryTracker } from '../../piToolDelivery';
import type { GuiHostTool } from '../../types';
import type { PiWorkerCaptureImages } from './captureImages';

export type PiDeliveryProof = { generation: number; toolCallId: string; proof: string; textDigest: string };

/** Kept in the trusted Pi worker, never in its tool result or projected events. */
export class PiWorkerDesktopDelivery {
  private agent?: Agent;
  private tracker?: PiToolDeliveryTracker;
  private closed = false;
  constructor(private readonly generation: () => number | undefined, private readonly connected: () => boolean,
    private readonly acknowledge: (proof: PiDeliveryProof, signal: AbortSignal) => Promise<VisibleAcknowledgementOutcome>,
    private readonly abandon: (proof: PiDeliveryProof) => void) {}

  attach(agent: Agent): void {
    if (this.closed || this.tracker || !agent || typeof agent.subscribe !== 'function') throw new Error('A host-owned Pi agent is required');
    this.agent = agent;
    this.tracker = new PiToolDeliveryTracker(agent);
  }

  expect(input: { generation: number | undefined; toolCallId: string | undefined; toolName: string;
    text: string; proof: unknown; signal: AbortSignal | undefined }): void {
    if (input.proof === undefined) return;
    if (typeof input.proof !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.proof) ||
        !Number.isSafeInteger(input.generation) || !input.toolCallId || !input.signal ||
        !this.tracker || !this.agent || this.agent.signal !== input.signal || this.closed || !this.connected() ||
        this.generation() !== input.generation || input.signal.aborted) {
      throw new Error('GUI Pi delivery proof cannot be registered');
    }
    const signal = input.signal;
    const receipt: PiDeliveryProof = { generation: input.generation!, toolCallId: input.toolCallId, proof: input.proof,
      textDigest: createHash('sha256').update(input.text, 'utf16le').digest('hex') };
    try {
      this.tracker.expect({ toolCallId: receipt.toolCallId, toolName: input.toolName, outputText: input.text,
        isCurrent: () => !this.closed && this.connected() && this.generation() === receipt.generation &&
          this.agent?.signal === signal && !signal.aborted,
        acknowledge: () => this.acknowledge(receipt, signal),
        onUnconfirmed: () => this.abandon(receipt) });
    } catch (error) {
      this.abandon(receipt);
      throw error;
    }
  }

  invalidate(): void { this.tracker?.invalidate(); }
  close(): void { this.closed = true; this.tracker?.close(); this.tracker = undefined; this.agent = undefined; }
}

/** Adapt the private IPC envelope to the exact text returned by customTools. */
export function createPiWorkerToolExecutor(id: string, delivery: PiWorkerDesktopDelivery,
  generation: () => number | undefined,
  invoke: (args: { id: string; args: unknown; toolCallId?: string; captureImages?: boolean }, signal?: AbortSignal) => Promise<unknown>,
  captureImages?: PiWorkerCaptureImages): GuiHostTool['execute'] {
  return async (args, ctx) => {
    const toolCallId = (ctx as typeof ctx & { toolCallId?: string }).toolCallId;
    const capture = captureImages?.begin(id, args, toolCallId, ctx.signal);
    const result = await invoke({ id, args, toolCallId, ...(capture?.supported ? { captureImages: true } : {}) }, ctx.signal);
    const value = result as { ok?: boolean; text?: unknown; desktopDeliveryProof?: unknown; image?: unknown } | undefined;
    if (!value?.ok) throw new Error(String(value?.text ?? 'Host tool call failed'));
    if (value.desktopDeliveryProof !== undefined && value.image !== undefined) throw new Error('A desktop action receipt cannot carry a screenshot');
    const text = String(value.text ?? '');
    delivery.expect({ generation: generation(), toolCallId, toolName: id.replace(/\./g, '_'),
      text, proof: value.desktopDeliveryProof, signal: ctx.signal });
    captureImages?.stage(capture, text, value.image);
    return text;
  };
}
