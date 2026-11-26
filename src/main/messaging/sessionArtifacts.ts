import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { guiMessageText, type GuiChatMessage } from '../../shared/guiWorker';
import { checkedPath, inside, stamp } from '../turnChanges/files';

export type ArtifactFactory = (input: {
  fileName: string; bytes: Uint8Array; sessionId: string; turnId: string; signal: AbortSignal;
}) => Promise<unknown>;

/** Only explicit final links to files observed being written by this exact turn are eligible. */
export async function deliverMessagingArtifacts(options: {
  message: GuiChatMessage; workspace: string; sessionId: string; turnId: string; signal: AbortSignal;
  createArtifact: ArtifactFactory; onArtifact: (artifact: unknown) => unknown;
  releaseArtifact?: (artifact: unknown) => void;
}): Promise<number> {
  const { message, workspace, signal } = options;
  signal.throwIfAborted();
  if (message.id !== options.turnId || message.role !== 'assistant' || !message.finishedAt ||
    message.aborted || message.error || message.turnChanges?.state !== 'ready') return 0;
  const root = path.resolve(workspace);
  const physical = await fs.promises.realpath(root);
  const roots = [{ path: root, physical }];
  const evidence = new Set(message.turnChanges.files.filter(file =>
    (file.kind === 'added' || file.kind === 'modified') && !file.reverted &&
    ['native-tool', 'observed-tool', 'explicit-batch', 'mixed'].includes(file.origin ?? '')
  ).map(file => path.resolve(root, file.path)));
  const links = guiMessageText(message).replace(/```[^]*?```/g, '').matchAll(/!?\[[^\]\n]*\]\((?:<([^>\n]+)>|([^\s)]+))(?:\s+"[^"\n]*")?\)/g);
  const selected = new Set<string>();
  for (const match of links) {
    let raw = match[1] ?? match[2];
    if (!raw || raw.startsWith('#')) continue;
    try {
      if (raw.startsWith('file:')) raw = fileURLToPath(raw);
      else if (raw.startsWith('muster-file:')) raw = decodeURIComponent(raw.slice('muster-file:'.length).split('?')[0]);
      else if (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^[a-z]:[\\/]/i.test(raw)) continue;
      else raw = decodeURIComponent(raw);
    } catch { continue; }
    const absolute = path.resolve(root, raw);
    if (evidence.has(absolute) && inside(root, absolute)) selected.add(absolute);
  }
  if (selected.size > 8) throw new Error('Too many result files for one message.');
  let total = 0;
  let delivered = 0;
  for (const absolute of selected) {
    signal.throwIfAborted();
    if (!checkedPath(roots, absolute)) throw new Error('The result file is outside the authorized workspace.');
    const expected = path.join(physical, path.relative(root, absolute));
    if (await fs.promises.realpath(absolute) !== expected) throw new Error('The result file location changed.');
    const handle = await fs.promises.open(absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    let bytes: Buffer;
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.nlink !== 1 || before.size > 20 * 1024 * 1024 || total + before.size > 40 * 1024 * 1024 ||
        Math.floor(Math.max(before.mtimeMs, before.ctimeMs)) > message.finishedAt) {
        throw new Error('The result file changed after the turn or exceeds the delivery limit.');
      }
      bytes = Buffer.alloc(before.size);
      let offset = 0;
      while (offset < bytes.length) {
        signal.throwIfAborted();
        const read = await handle.read(bytes, offset, Math.min(64 * 1024, bytes.length - offset), offset);
        if (!read.bytesRead) throw new Error('The result file changed during delivery.');
        offset += read.bytesRead;
      }
      const after = await handle.stat();
      const located = await fs.promises.lstat(absolute);
      if (stamp(before) !== stamp(after) || stamp(after) !== stamp(located) || !checkedPath(roots, absolute)) {
        throw new Error('The result file changed during delivery.');
      }
      total += bytes.length;
    } finally { await handle.close(); }
    signal.throwIfAborted();
    const artifact = await options.createArtifact({ fileName: path.basename(absolute), bytes,
      sessionId: options.sessionId, turnId: options.turnId, signal });
    try { signal.throwIfAborted(); await options.onArtifact(artifact); }
    catch (error) { options.releaseArtifact?.(artifact); throw error; }
    delivered++;
  }
  return delivered;
}
