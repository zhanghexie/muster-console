import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { writeBytesAtomicSync } from '../atomicJson';
import { resolveChatHistoryBounds } from '../../shared/chatHistory';

const MAGIC = Buffer.from('MSTRRNG1');
const HEADER = 16;
const ORDINAL = 48;
const ID_ENTRY = 36;
type Stamp = { size: number; mtimeMs: number; ctimeMs: number };
type IndexMetadata<M> = { source: Stamp; events: Stamp | null; metadata: M };

function stamp(file: string): Stamp | null {
  try {
    const stat = fs.statSync(file);
    return { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
function sameStamp(a: Stamp | null, b: Stamp | null): boolean {
  return a === b || (!!a && !!b && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs);
}
function read(fd: number, size: number, position: number): Buffer {
  const buffer = Buffer.alloc(size);
  let done = 0;
  while (done < size) {
    const bytes = fs.readSync(fd, buffer, done, size - done, position + done);
    if (!bytes) throw new Error('Truncated message range index');
    done += bytes;
  }
  return buffer;
}
const hashId = (id: string): Buffer => createHash('sha256').update(id).digest();
export const messageRangeIndexPath = (checkpoint: string): string => `${checkpoint}.ranges`;

function skipWhitespace(bytes: Buffer, position: number): number {
  while ([9, 10, 13, 32].includes(bytes[position]!)) position++;
  return position;
}

/** Return the byte span of one JSON value. The scan is deliberately limited
 * to the checkpoint root so a nested field named `messages` cannot be used as
 * the history source. */
function skipJsonValue(bytes: Buffer, position: number): number {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let cursor = position; cursor < bytes.length; cursor++) {
    const byte = bytes[cursor]!;
    if (quoted) {
      if (escaped) escaped = false;
      else if (byte === 92) escaped = true;
      else if (byte === 34) {
        quoted = false;
        if (!depth) return cursor + 1;
      }
      continue;
    }
    if (byte === 34) quoted = true;
    else if (byte === 123 || byte === 91) depth++;
    else if (byte === 125 || byte === 93) {
      if (!depth) return cursor;
      if (--depth === 0) return cursor + 1;
    } else if (!depth && (byte === 44 || [9, 10, 13, 32].includes(byte))) {
      return cursor;
    }
  }
  throw new Error('Unterminated message checkpoint value');
}

function rootArraySpans(bytes: Buffer, key: string): Array<{ offset: number; length: number }> {
  let cursor = skipWhitespace(bytes, 0);
  if (bytes[cursor++] !== 123) throw new Error('Invalid message checkpoint object');
  for (;;) {
    cursor = skipWhitespace(bytes, cursor);
    if (bytes[cursor] === 125) break;
    if (bytes[cursor] !== 34) throw new Error('Invalid message checkpoint key');
    const keyEnd = skipJsonValue(bytes, cursor);
    const name = JSON.parse(bytes.subarray(cursor, keyEnd).toString('utf8'));
    cursor = skipWhitespace(bytes, keyEnd);
    if (bytes[cursor++] !== 58) throw new Error('Invalid message checkpoint property');
    cursor = skipWhitespace(bytes, cursor);
    if (name === key) {
      if (bytes[cursor++] !== 91) throw new Error(`Message checkpoint property is not an array: ${key}`);
      const spans: Array<{ offset: number; length: number }> = [];
      cursor = skipWhitespace(bytes, cursor);
      while (bytes[cursor] !== 93) {
        const offset = cursor;
        cursor = skipJsonValue(bytes, cursor);
        spans.push({ offset, length: cursor - offset });
        cursor = skipWhitespace(bytes, cursor);
        if (bytes[cursor] === 93) break;
        if (bytes[cursor++] !== 44) throw new Error('Invalid message checkpoint array separator');
        cursor = skipWhitespace(bytes, cursor);
      }
      return spans;
    }
    cursor = skipWhitespace(bytes, skipJsonValue(bytes, cursor));
    if (bytes[cursor] === 125) break;
    if (bytes[cursor++] !== 44) throw new Error('Invalid message checkpoint separator');
  }
  throw new Error(`Message checkpoint has no ${key} array`);
}

/**
 * Builds the disposable message index from an existing checkpoint without
 * creating a second full `GuiChatMessage[]` object graph. The checkpoint bytes
 * are scanned once, each message object is parsed only long enough to read its
 * stable ID, and the existing validated writer persists the sidecar.
 */
export function writeMessageRangeIndexFromJson<M>(
  checkpoint: string,
  events: string,
  json: string,
  metadata: M
): void {
  const bytes = Buffer.from(json);
  const ids = rootArraySpans(bytes, 'messages').map(({ offset, length }) => {
    const value = JSON.parse(bytes.subarray(offset, offset + length).toString('utf8')) as { id?: unknown };
    if (!value || typeof value.id !== 'string' || !value.id) throw new Error('Message checkpoint entry has no id');
    return value.id;
  });
  writeMessageRangeIndex(checkpoint, events, json, ids, metadata);
}

/** Reads one root-level checkpoint field while leaving all other large arrays
 * untouched. Missing fields return undefined, explicit JSON null is preserved.
 */
export function readMessageCheckpointProperty(json: string, key: string): unknown {
  const bytes = Buffer.from(json);
  let cursor = skipWhitespace(bytes, 0);
  if (bytes[cursor++] !== 123) throw new Error('Invalid message checkpoint object');
  for (;;) {
    cursor = skipWhitespace(bytes, cursor);
    if (bytes[cursor] === 125) return undefined;
    if (bytes[cursor] !== 34) throw new Error('Invalid message checkpoint key');
    const keyEnd = skipJsonValue(bytes, cursor);
    const name = JSON.parse(bytes.subarray(cursor, keyEnd).toString('utf8'));
    cursor = skipWhitespace(bytes, keyEnd);
    if (bytes[cursor++] !== 58) throw new Error('Invalid message checkpoint property');
    cursor = skipWhitespace(bytes, cursor);
    const valueEnd = skipJsonValue(bytes, cursor);
    if (name === key) return JSON.parse(bytes.subarray(cursor, valueEnd).toString('utf8'));
    cursor = skipWhitespace(bytes, valueEnd);
    if (bytes[cursor] === 125) return undefined;
    if (bytes[cursor++] !== 44) throw new Error('Invalid message checkpoint separator');
  }
}

/**
 * Disposable index over an atomic JSON checkpoint. Ordinal byte spans and a
 * sorted fixed-width SHA-256 table permit O(page size + log message count) reads.
 * No message bodies or per-session ID map are retained after reading a page.
 */
export function writeMessageRangeIndex<M>(checkpoint: string, events: string, json: string, ids: readonly string[], metadata: M): void {
  const source = stamp(checkpoint);
  if (!source) throw new Error('Message checkpoint missing');
  const bytes = Buffer.from(json);
  if (bytes.length !== source.size) throw new Error('Message checkpoint changed before indexing');
  const spans = rootArraySpans(bytes, 'messages');
  if (spans.length !== ids.length) throw new Error('Message index count does not match checkpoint');
  const ordinal = Buffer.alloc(ids.length * ORDINAL);
  for (let index = 0; index < ids.length; index++) {
    const span = spans[index]!;
    ordinal.writeDoubleLE(span.offset, index * ORDINAL);
    ordinal.writeDoubleLE(span.length, index * ORDINAL + 8);
    hashId(ids[index]!).copy(ordinal, index * ORDINAL + 16);
  }
  const hashes = ids.map((id, index) => ({ hash: hashId(id), index })).sort((a, b) => Buffer.compare(a.hash, b.hash));
  const lookup = Buffer.alloc(ids.length * ID_ENTRY);
  hashes.forEach(({ hash, index }, row) => { hash.copy(lookup, row * ID_ENTRY); lookup.writeUInt32LE(index, row * ID_ENTRY + 32); });
  const meta = Buffer.from(JSON.stringify({ source, events: stamp(events), metadata } satisfies IndexMetadata<M>));
  const header = Buffer.alloc(HEADER);
  MAGIC.copy(header); header.writeUInt32LE(meta.length, 8); header.writeUInt32LE(ids.length, 12);
  writeBytesAtomicSync(messageRangeIndexPath(checkpoint), Buffer.concat([header, meta, ordinal, lookup]));
}

export function readMessageRangeIndex<T extends { id: string }, M>(
  checkpoint: string, events: string, before?: number, limit?: number, targetMessageId?: string,
  options: { allowStaleEvents?: boolean } = {}
): { messages: T[]; before: number; total: number; hasEarlier: boolean; metadata: M } | null {
  let indexFd: number | undefined;
  let checkpointFd: number | undefined;
  try {
    indexFd = fs.openSync(messageRangeIndexPath(checkpoint), 'r');
    const header = read(indexFd, HEADER, 0);
    if (!header.subarray(0, 8).equals(MAGIC)) throw new Error('Invalid message range index header');
    const metaLength = header.readUInt32LE(8), count = header.readUInt32LE(12);
    const size = fs.fstatSync(indexFd).size;
    if (metaLength > 16 * 1024 * 1024 || size !== HEADER + metaLength + count * (ORDINAL + ID_ENTRY)) throw new Error('Invalid message range index size');
    const meta = JSON.parse(read(indexFd, metaLength, HEADER).toString('utf8')) as IndexMetadata<M>;
    if (!meta || !meta.source || !meta.metadata || typeof meta.metadata !== 'object' || Array.isArray(meta.metadata)) {
      throw new Error('Invalid message range metadata');
    }
    if (!sameStamp(meta.source, stamp(checkpoint)) || (!options.allowStaleEvents && !sameStamp(meta.events, stamp(events)))) return null;
    const ordinalStart = HEADER + metaLength, hashStart = ordinalStart + count * ORDINAL;
    let target: number | undefined;
    if (targetMessageId) {
      const hash = hashId(targetMessageId);
      let lo = 0, hi = count;
      target = -1;
      while (lo < hi) {
        const middle = Math.floor((lo + hi) / 2);
        const entry = read(indexFd, ID_ENTRY, hashStart + middle * ID_ENTRY);
        const position = entry.readUInt32LE(32);
        if (position >= count || !read(indexFd, 32, ordinalStart + position * ORDINAL + 16).equals(entry.subarray(0, 32))) {
          throw new Error('Invalid message ID lookup entry');
        }
        const order = Buffer.compare(entry.subarray(0, 32), hash);
        if (order === 0) { target = entry.readUInt32LE(32); break; }
        if (order < 0) lo = middle + 1; else hi = middle;
      }
      if (target >= count) throw new Error('Invalid target index');
    }
    const { start, end } = resolveChatHistoryBounds(count, before, limit, target);
    let messages: T[] = [];
    if (end > start) {
      const ordinals = read(indexFd, (end - start) * ORDINAL, ordinalStart + start * ORDINAL);
      const first = ordinals.subarray(0, ORDINAL);
      const last = ordinals.subarray(ordinals.length - ORDINAL);
      const offset = first.readDoubleLE(0), lastOffset = last.readDoubleLE(0), lastSize = last.readDoubleLE(8);
      const length = lastOffset + lastSize - offset;
      if (![offset, lastOffset, lastSize, length].every(Number.isSafeInteger) || offset < 0 || lastSize <= 0 || length <= 0 || offset + length > meta.source.size) throw new Error('Invalid message byte range');
      checkpointFd = fs.openSync(checkpoint, 'r');
      messages = JSON.parse(`[${read(checkpointFd, length, offset).toString('utf8')}]`) as T[];
      if (messages.length !== end - start || messages.some(message => typeof message?.id !== 'string') ||
          messages.some((message, index) => !hashId(message.id).equals(ordinals.subarray(index * ORDINAL + 16, (index + 1) * ORDINAL))) ||
          (targetMessageId && !messages.some(message => message.id === targetMessageId))) throw new Error('Message index does not match checkpoint');
    }
    if (!sameStamp(meta.source, stamp(checkpoint)) || (!options.allowStaleEvents && !sameStamp(meta.events, stamp(events)))) return null;
    return { messages, before: start, total: count, hasEarlier: start > 0, metadata: meta.metadata };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('[message-range-index] rebuilding unavailable index:', String(error));
    return null;
  } finally {
    if (checkpointFd !== undefined) fs.closeSync(checkpointFd);
    if (indexFd !== undefined) fs.closeSync(indexFd);
  }
}

/** Read a checkpoint's validated small envelope without reading any message
 * body, ordinal span or ID lookup table. */
export function readMessageRangeMetadata<M>(checkpoint: string, events: string): M | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(messageRangeIndexPath(checkpoint), 'r');
    const header = read(fd, HEADER, 0);
    if (!header.subarray(0, 8).equals(MAGIC)) throw new Error('Invalid message range index header');
    const length = header.readUInt32LE(8), count = header.readUInt32LE(12);
    if (length > 16 * 1024 * 1024 || fs.fstatSync(fd).size !== HEADER + length + count * (ORDINAL + ID_ENTRY)) throw new Error('Invalid message range index size');
    const envelope = JSON.parse(read(fd, length, HEADER).toString('utf8')) as IndexMetadata<M>;
    if (!envelope || !envelope.source || !envelope.metadata || typeof envelope.metadata !== 'object' || Array.isArray(envelope.metadata)) throw new Error('Invalid message range metadata');
    if (!sameStamp(envelope.source, stamp(checkpoint)) || !sameStamp(envelope.events, stamp(events))) return null;
    return envelope.metadata;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('[message-range-index] unavailable metadata:', String(error));
    return null;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
