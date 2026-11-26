import path from 'node:path';
import { app } from 'electron';
import type { AppConfig, SessionMeta } from '../../shared/types';
import { prepareAttachments } from '../attachments/service';
import type { GuiSendImage } from '../agentSession/types';

const MAX_COUNT = 16;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;

type FileSource = {
  name?: unknown; filename?: unknown; data?: unknown; buffer?: unknown; stream?: unknown; size?: unknown;
  mediaType?: unknown; mimetype?: unknown; mimeType?: unknown;
  load?: (input: { signal: AbortSignal; maxBytes: number }) => unknown;
};
type IncomingAttachment = { data: string; mimeType: string; name?: string };

function attachmentError(code: string): Error {
  return Object.assign(new Error('The messaging attachment could not be prepared.'), { code, details: { submissionState: 'not-submitted' } });
}

function actualImageType(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  const signature = bytes.toString('ascii', 0, 6);
  if (signature === 'GIF87a' || signature === 'GIF89a') return 'image/gif';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
}

async function boundedBytes(input: unknown, limit: number, signal: AbortSignal): Promise<Buffer> {
  if (input instanceof Uint8Array) {
    if (input.byteLength === 0 || input.byteLength > limit) throw attachmentError('attachment-size-invalid');
    return Buffer.from(input);
  }
  const stream = input as AsyncIterable<unknown> & { destroy?: (error?: Error) => void };
  if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') throw attachmentError('attachment-content-invalid');
  const abort = () => stream.destroy?.();
  signal.addEventListener('abort', abort, { once: true });
  const buffers: Buffer[] = [];
  let length = 0;
  try {
    signal.throwIfAborted();
    for await (const chunk of stream) {
      signal.throwIfAborted();
      if (!(chunk instanceof Uint8Array)) throw attachmentError('attachment-content-invalid');
      length += chunk.byteLength;
      if (length > limit) throw attachmentError('attachment-size-invalid');
      buffers.push(Buffer.from(chunk));
    }
  } finally { signal.removeEventListener('abort', abort); }
  signal.throwIfAborted();
  if (!length) throw attachmentError('attachment-content-invalid');
  return Buffer.concat(buffers, length);
}

export async function stageMessagingPrompt(input: {
  text: string; images?: GuiSendImage[]; fileSources?: readonly unknown[]; imageSources?: readonly unknown[];
  session: SessionMeta; userData: string; config: AppConfig; signal: AbortSignal;
}): Promise<{ text: string; images?: GuiSendImage[] }> {
  const { text, images = [], fileSources = [], imageSources = [], session, config, signal } = input;
  if (!images.length && !fileSources.length && !imageSources.length) return { text };
  if (images.length + fileSources.length + imageSources.length > MAX_COUNT) throw attachmentError('attachment-count-limit');
  const attachments: IncomingAttachment[] = [];
  let total = 0;
  const append = (bytes: Buffer, rawName: unknown, rawMime: unknown, image: boolean): void => {
    total += bytes.length;
    if (!bytes.length || bytes.length > MAX_FILE_BYTES || total > MAX_TOTAL_BYTES) throw attachmentError('attachment-size-invalid');
    const name = typeof rawName === 'string' ? rawName.replaceAll('\\', '/').split('/').at(-1)?.slice(0, 160) : undefined;
    const mime = typeof rawMime === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(rawMime) ? rawMime : 'application/octet-stream';
    const actualImage = actualImageType(bytes);
    if ((image || mime.startsWith('image/') || /\.(png|jpe?g|webp|gif)$/i.test(name ?? '')) && !actualImage) {
      throw attachmentError('attachment-image-invalid');
    }
    attachments.push({ data: bytes.toString('base64'), name, mimeType: actualImage ?? mime });
  };
  for (const image of images) append(Buffer.from(image.data, 'base64'), image.name, image.mimeType, true);
  for (const [sources, image] of [[fileSources, false], [imageSources, true]] as const) {
    for (const candidate of sources) {
      signal.throwIfAborted();
      if (!candidate || typeof candidate !== 'object') throw attachmentError('attachment-source-invalid');
      const source = candidate as FileSource;
      const maxBytes = Math.min(MAX_FILE_BYTES, MAX_TOTAL_BYTES - total);
      if (maxBytes <= 0 || (typeof source.size === 'number' && source.size > maxBytes)) throw attachmentError('attachment-size-invalid');
      let value: unknown;
      try { value = source.data ?? source.buffer ?? source.stream ?? await source.load?.({ signal, maxBytes }); }
      catch { signal.throwIfAborted(); throw attachmentError('attachment-download-failed'); }
      const loaded = (value ?? {}) as FileSource;
      const content = value instanceof Uint8Array ? value : loaded.data ?? loaded.buffer ?? loaded.stream ?? value;
      const bytes = await boundedBytes(content, maxBytes, signal);
      append(bytes, loaded.name ?? loaded.filename ?? source.name ?? source.filename,
        loaded.mediaType ?? loaded.mimeType ?? loaded.mimetype ?? source.mediaType ?? source.mimeType ?? source.mimetype, image);
    }
  }
  signal.throwIfAborted();
  const provider = config.llm?.providers.find(item => item.id === (session.modelOverride?.providerId ?? config.llm?.activeProviderId));
  const model = provider?.models.find(item => item.id === (session.modelOverride?.modelId ?? config.llm?.activeModelId));
  const prepared = await prepareAttachments({ userData: input.userData, scope: `gui:${session.id}`, text, attachments,
    model, api: provider?.api, tools: config.attachmentTools, processing: config.attachmentProcessing,
    ...(typeof app.getAppPath === 'function' ? { workerFile: path.join(app.getAppPath(), 'out/main/attachments/worker.mjs') } : {}) });
  signal.throwIfAborted();
  return prepared;
}
