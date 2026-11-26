import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import type { Agent, AgentMessage } from '@earendil-works/pi-agent-core';
import type { DesktopCaptureImage } from '../../../desktop/captureImageScope';
import { isDesktopLookCall } from '../../../desktop/lookInvocation';

type Snapshot = { id: string; name: string; generation: number; signal: AbortSignal; model: string; supported: boolean };
type Pending = { snapshot: Snapshot; text: string; image?: DesktopCaptureImage };
type Expected = { snapshot: Snapshot; text: string; digest: string };
type TextBlock = { type: 'text'; text: string };
const MAX_BYTES = 20 * 1024 * 1024;
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);


function modelIdentity(agent: Agent | undefined): { key: string; supported: boolean } {
  const model = agent?.state.model;
  if (!model || typeof model.id !== 'string' || typeof model.provider !== 'string' || typeof model.api !== 'string' ||
      !Array.isArray(model.input)) return { key: '', supported: false };
  return { key: JSON.stringify([model.provider, model.id, model.api, model.input, model.inputLimits ?? null]),
    // A virtual router can choose a different physical model on the next request.
    supported: model.api !== 'pi-virtual' && model.input.includes('image') };
}

function imageInfo(image: unknown): { digest: string; width: number; height: number; encodedBytes: number } | undefined {
  if (!image || typeof image !== 'object' || Array.isArray(image)) return undefined;
  const value = image as Record<string, unknown>;
  if (value.type !== 'image' || value.mimeType !== 'image/png' || typeof value.data !== 'string' ||
      value.data.length < 60 || value.data.length > Math.ceil(MAX_BYTES / 3) * 4 || value.data.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(value.data)) return undefined;
  const bytes = Buffer.from(value.data, 'base64');
  if (bytes.length < 45 || bytes.length > MAX_BYTES || !bytes.subarray(0, 8).equals(PNG) || bytes.toString('base64') !== value.data ||
      bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') return undefined;
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (!width || !height || width > 32768 || height > 32768 || width * height > 40_000_000) return undefined;
  return { digest: createHash('sha256').update(bytes).digest('hex'), width, height, encodedBytes: value.data.length };
}

function withinModelLimits(agent: Agent | undefined, image: { width: number; height: number; encodedBytes: number }): boolean {
  const limits = agent?.state.model?.inputLimits;
  const resize = limits?.images?.resize;
  const allows = (value: number, max: number | undefined): boolean => max === undefined ||
    (Number.isSafeInteger(max) && max > 0 && value <= max);
  return allows(image.width, resize?.maxWidth) && allows(image.height, resize?.maxHeight) &&
    allows(image.encodedBytes, resize?.maxBytes) && allows(image.encodedBytes, limits?.maxRequestBytes) &&
    allows(1, limits?.images?.maxPerMessage) && allows(1, limits?.images?.maxPerRequest);
}

function matchesDimensions(text: string, image: { width: number; height: number }): boolean {
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const outer = value as { ok?: unknown; result?: unknown };
    if (outer.ok !== true || !outer.result || typeof outer.result !== 'object' || Array.isArray(outer.result)) return false;
    const result = outer.result as { width?: unknown; height?: unknown };
    return result.width === image.width && result.height === image.height;
  } catch { return false; }
}

/** The image and its model capability come only from the supervised worker and host IPC. */
export class PiWorkerCaptureImages {
  private agent?: Agent;
  private readonly noResize = new AsyncLocalStorage<boolean>();
  private readonly pending = new Map<string, Pending>();
  private readonly expected = new Map<string, Expected>();
  private readonly nested = new Set<string>();
  private nestedOverflow = false;
  private closed = false;
  constructor(private readonly generation: () => number | undefined, private readonly connected: () => boolean) {}

  attach(agent: Agent, settings: { getImageAutoResize(): boolean }): void {
    if (this.closed || this.agent || !agent || typeof agent.afterToolCall !== 'function' ||
        !settings || typeof settings.getImageAutoResize !== 'function') throw new Error('Pi screenshot handling is unavailable');
    this.agent = agent;
    const getResize = settings.getImageAutoResize.bind(settings);
    settings.getImageAutoResize = () => this.noResize.getStore() === true ? false : getResize();
    const after = agent.afterToolCall.bind(agent);
    agent.afterToolCall = async (context, signal) => {
      const expected = this.expected.get(context.toolCall.id);
      if (!expected || context.toolCall.name !== expected.snapshot.name.replace(/\./g, '_')) return after(context, signal);
      // Only the host-produced screenshot keeps its original coordinate space.
      // Parallel non-screenshot tool results retain the user's image settings.
      const result = await this.noResize.run(true, () => after(context, signal));
      const content = result?.content ?? context.result.content;
      const text = content.filter(part => part.type === 'text');
      const images = content.filter(part => part.type === 'image');
      if (!this.current(expected.snapshot) || context.isError || result?.isError || text.length !== 1 ||
          text[0]?.text !== expected.text || images.length !== 1 || imageInfo(images[0])?.digest !== expected.digest) {
        return { content: [{ type: 'text', text: 'Desktop screenshot changed or became unavailable; capture it again.' }], isError: true };
      }
      return result;
    };
    const transform = agent.transformContext?.bind(agent);
    agent.transformContext = async (messages, signal) => {
      const projected = transform ? await transform(messages, signal) : messages;
      return projected.map(message => {
        if (message.role !== 'toolResult' || this.expected.size === 0) return message;
        const text = message.content.filter(part => part.type === 'text');
        const images = message.content.filter(part => part.type === 'image');
        const digests = images.map(part => imageInfo(part)?.digest);
        const expected = this.expected.get(message.toolCallId) ?? [...this.expected.values()]
          .find(item => digests.includes(item.digest));
        if (!expected) return message;
        if (message.toolCallId === expected.snapshot.id && message.toolName === expected.snapshot.name.replace(/\./g, '_') &&
            this.current(expected.snapshot) && !message.isError && text.length === 1 && text[0]?.text === expected.text &&
            images.length === 1 && digests[0] === expected.digest) return message;
        return { ...message, isError: true, content: [{ type: 'text' as const,
          text: 'Desktop screenshot changed or became unavailable; capture it again.' }] };
      });
    };
  }

  begin(name: string, args: unknown, id: string | undefined, signal: AbortSignal | undefined): Snapshot | undefined {
    if (!isDesktopLookCall(name, args)) return undefined;
    const generation = this.generation();
    if (this.closed || !this.agent || !this.connected() || !Number.isSafeInteger(generation) ||
        !id || id.length > 1024 || !signal || signal.aborted || this.agent.signal !== signal ||
        this.pending.size + this.expected.size >= 256 || this.pending.has(id) || this.expected.has(id)) {
      throw new Error('Pi screenshot context is unavailable');
    }
    // Nested Pi tools bypass agent.afterToolCall and can silently resize an image.
    // Only a call directly present in this assistant message uses the guarded hook.
    const messages = this.agent.state.messages;
    let assistant: AgentMessage | undefined;
    for (let index = messages.length - 1; index >= 0; index--) {
      if (messages[index]?.role === 'assistant') { assistant = messages[index]; break; }
    }
    const calls = assistant?.role === 'assistant' && Array.isArray(assistant.content)
      ? assistant.content.filter(part => part?.type === 'toolCall' && part.id === id && part.name === name.replace(/\./g, '_')) : [];
    if (this.nestedOverflow || this.nested.has(id) || calls.length !== 1) throw new Error('Nested Pi screenshots are unavailable; call desktop.look directly.');
    const model = modelIdentity(this.agent);
    return { id, name, generation: generation!, signal, model: model.key, supported: model.supported };
  }

  observeToolStart(event: { toolCallId?: unknown; toolName?: unknown; parentToolCallId?: unknown }): void {
    if (typeof event.parentToolCallId !== 'string' || !event.parentToolCallId || typeof event.toolCallId !== 'string' ||
        !['desktop_look', 'host_desktop_look', 'desktop_run', 'host_desktop_run'].includes(String(event.toolName))) return;
    if (this.nested.size >= 4096) { this.nestedOverflow = true; return; }
    this.nested.add(event.toolCallId);
  }

  stage(snapshot: Snapshot | undefined, text: string, image: unknown): void {
    if (!snapshot) {
      if (image !== undefined) throw new Error('Unexpected desktop screenshot image');
      return;
    }
    if (!this.current(snapshot)) throw new Error('Pi screenshot context changed');
    if (image !== undefined) {
      const info = imageInfo(image);
      if (!snapshot.supported || !info || !matchesDimensions(text, info)) throw new Error('Desktop screenshot image or dimensions are invalid');
      if (!withinModelLimits(this.agent, info)) throw new Error('Desktop screenshot exceeds the current model image limits; capture a smaller region.');
    }
    this.pending.set(snapshot.id, { snapshot, text, ...(image ? { image: image as DesktopCaptureImage } : {}) });
  }

  content(name: string, id: string, signal: AbortSignal | undefined, text: string): Array<TextBlock | DesktopCaptureImage> {
    // pending 只在 begin 通过 look 判定后写入；这里按 id 查比再判一次名字更可靠。
    void name;
    if (!this.pending.has(id)) return [];
    const item = this.pending.get(id);
    this.pending.delete(id);
    if (!item || signal !== item.snapshot.signal || text !== item.text || !this.current(item.snapshot)) {
      throw new Error('Pi screenshot result changed');
    }
    if (!item.image) return [{ type: 'text', text: item.snapshot.supported
      ? '未收到截图图像；本次仅返回截图元数据。'
      : '当前模型不支持或无法确认图像输入；本次仅返回截图元数据。' }];
    const info = imageInfo(item.image);
    if (!info) throw new Error('Invalid desktop screenshot image');
    this.expected.set(id, { snapshot: item.snapshot, text, digest: info.digest });
    return [item.image];
  }

  invalidate(): void { this.pending.clear(); this.expected.clear(); this.nested.clear(); this.nestedOverflow = false; }
  close(): void { this.closed = true; this.invalidate(); this.agent = undefined; }
  private current(snapshot: Snapshot): boolean {
    const model = modelIdentity(this.agent);
    return !this.closed && this.connected() && this.generation() === snapshot.generation && !snapshot.signal.aborted &&
      this.agent?.signal === snapshot.signal && model.key === snapshot.model && model.supported === snapshot.supported;
  }
}
