import { lstat, open } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { t } from './i18n.mjs';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_SCREENSHOT_BYTES = 20 * 1024 * 1024;

async function readScreenshot(image, signal) {
  if (image?.mimeType !== 'image/png' || typeof image.filePath !== 'string' || !isAbsolute(image.filePath)) return null;
  signal?.throwIfAborted();
  const expected = await lstat(image.filePath);
  if (!expected.isFile() || expected.nlink !== 1 || expected.size < PNG.length || expected.size > MAX_SCREENSHOT_BYTES) return null;
  const source = await open(image.filePath, 'r');
  try {
    const active = await source.stat();
    if (!active.isFile() || active.dev !== expected.dev || active.ino !== expected.ino || active.size !== expected.size) return null;
    const bytes = Buffer.alloc(active.size);
    for (let offset = 0; offset < bytes.length;) {
      signal?.throwIfAborted();
      const { bytesRead } = await source.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) return null;
      offset += bytesRead;
    }
    const settled = await source.stat();
    if (settled.size !== active.size || settled.mtimeMs !== active.mtimeMs || !bytes.subarray(0, PNG.length).equals(PNG)) return null;
    return {
      bytes, artifactId: randomUUID(), mediaType: 'image/png', fileName: 'workbench.png',
      name: 'workbench.png', load: async () => bytes,
    };
  } finally { await source.close(); }
}

function forwardChannelMessage(receive, input, { signal, sendText, sendImage }) {
  if (signal?.aborted || !input.senderId || !input.messageId || !input.conversationId
    || !['direct', 'group'].includes(input.conversationType) || input.senderIsBot === true) return Promise.resolve();
  return receive({
    ...input,
    text: typeof input.text === 'string' ? input.text : '',
    signal,
  }, async ({ text, image } = {}, authorizationSignal) => {
    const signals = [signal, authorizationSignal].filter(Boolean);
    const deliverySignal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
    if (deliverySignal?.aborted || typeof sendText !== 'function') return;
    if (text) await sendText(text, deliverySignal);
    if (deliverySignal?.aborted || !image) return;
    if (typeof sendImage !== 'function') {
      await sendText(t('该渠道暂不能回传截图。'), deliverySignal);
      return;
    }
    let file;
    try { file = await readScreenshot(image, deliverySignal); }
    catch { /* The snapshot may have expired before delivery. */ }
    if (deliverySignal?.aborted) return;
    if (file) await sendImage(file, deliverySignal);
    else await sendText(t('截图文件已失效，无法回传。'), deliverySignal);
  });
}

export function createChannelIngress(receive) {
  if (typeof receive !== 'function') throw new TypeError('Channel ingress is required');
  const pending = new Set();
  return {
    forward(input, options) {
      const work = forwardChannelMessage(receive, input, options);
      pending.add(work);
      const release = () => pending.delete(work);
      void work.then(release, release);
      return work;
    },
    async waitForIdle() {
      await Promise.allSettled(pending);
    },
  };
}
