import { AsyncLocalStorage } from 'node:async_hooks';
import { channel } from 'node:diagnostics_channel';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { recordingToken, saveModelRequest } from '../../modelRequestStore';
import type { CompressionTrace } from './requestCompression';

type CompressionCapture = { leaf(): string | null; trace(body: Buffer, leaf: string): CompressionTrace };
interface Capture {
  root: string;
  sessionId: string;
  failed(message: string): void;
  compression?: CompressionCapture;
  closed: boolean;
}
interface Scope { capture: Capture; model: string; protocol: string; leaf?: string | null }
interface WireRequest { method: string; path: string }
interface Pending extends Scope { epoch: string; at: number; chunks: Buffer[] }

const scope = new AsyncLocalStorage<Scope>();
let captureCount = 0;
let stopObserving: (() => void) | undefined;

function observeTransport(): () => void {
  const requests = new WeakMap<WireRequest, Pending>();
  const finish = (request: WireRequest, complete: boolean) => {
    const pending = requests.get(request);
    if (!pending) return;
    requests.delete(request);
    const { capture, at, model, protocol, chunks } = pending;
    const body = Buffer.concat(chunks);
    let trace: CompressionTrace | undefined;
    try { if (complete && pending.leaf) trace = capture.compression?.trace(body, pending.leaf); }
    catch (error) { capture.failed(String(error)); }
    saveModelRequest(capture.root, capture.sessionId, pending.epoch, { at, model, protocol, complete }, body, trace);
  };
  type Event = { request: WireRequest; chunk: Uint8Array };
  function listen(name: string, handle: (event: Event, active: Scope) => void) {
    const target = channel('undici:request:' + name);
    const listener = (event: unknown) => {
      const wireEvent = event as Event;
      const active = name === 'create' ? scope.getStore() : requests.get(wireEvent.request);
      if (!active) return;
      if (active.capture.closed) { requests.delete(wireEvent.request); return; }
      try { handle(wireEvent, active); } catch (error) { active.capture.failed(String(error)); }
    };
    target.subscribe(listener);
    return () => target.unsubscribe(listener);
  }
  const unsubscribe = [
    listen('create', ({ request }, active) => {
      // Exclude auth refreshes, discovery and uploads made by SDKs during setup.
      if (request.method === 'POST' &&
          /\/(?:chat\/completions|responses|messages|conversations)\/?$|:(?:streamGenerateContent|generateContent)$/.test(request.path.split('?')[0]!)) {
        const epoch = recordingToken(active.capture.root, active.capture.sessionId);
        if (epoch) requests.set(request, { epoch, ...active, at: Date.now(), chunks: [] });
      }
    }),
    listen('bodyChunkSent', ({ request, chunk }) => { requests.get(request)?.chunks.push(Buffer.from(chunk)); }),
    listen('bodySent', ({ request }) => finish(request, true)),
    listen('error', ({ request }) => finish(request, false))
  ];
  return () => unsubscribe.forEach(off => off());
}

/** Observe bytes after SDK serialization. A shared observer serves all live runtimes in this process. */
export function captureModelRequests(runtime: Pick<ModelRuntime, 'streamSimple' | 'stream'>,
  root: string, sessionId: string, failed: (message: string) => void, compression?: CompressionCapture): () => void {
  const capture: Capture = { root, sessionId, failed, compression, closed: false };
  const stream = runtime.stream;
  const simple = runtime.streamSimple;
  runtime.stream = (model, context, options) => scope.run({ capture, model: model.id, protocol: model.api, leaf: compression?.leaf() },
    () => stream.call(runtime, model, context, options));
  runtime.streamSimple = (model, context, options) => scope.run({ capture, model: model.id, protocol: model.api, leaf: compression?.leaf() },
    () => simple.call(runtime, model, context, options));
  if (++captureCount === 1) stopObserving = observeTransport();
  return () => {
    if (capture.closed) return;
    capture.closed = true;
    if (--captureCount === 0) { stopObserving?.(); stopObserving = undefined; }
    runtime.stream = stream;
    runtime.streamSimple = simple;
  };
}
