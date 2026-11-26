import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readMessageRangeIndex, readMessageRangeMetadata, writeMessageRangeIndex, writeMessageRangeIndexFromJson, messageRangeIndexPath } from '../../../src/main/runtimeKernel/messageRangeIndex';

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function fixture(count = 10000, pretty = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-range-index-')); dirs.push(dir);
  const checkpoint = path.join(dir, 'session.json'), events = path.join(dir, 'session.ndjson');
  const messages = Array.from({ length: count }, (_, i) => ({ id: `消息-${i}`, parts: [{ text: `汉字🙂 \"引号\\转义\" {[]} ${i}`.repeat(4), nested: [null, { foo: 'bar' }] }] }));
  const json = JSON.stringify({ version: 2, messages }, null, pretty ? 2 : undefined);
  fs.writeFileSync(checkpoint, json); fs.writeFileSync(events, 'event stamp');
  writeMessageRangeIndex(checkpoint, events, json, messages.map(message => message.id), { marker: 42 });
  return { checkpoint, events, messages, json };
}

describe('checkpoint message range index', () => {
  it('seeks a target in a 10k UTF-8 transcript without reading the checkpoint or index in full', () => {
    const f = fixture();
    let bytesRead = 0;
    const original = fs.readSync as (...args: any[]) => number;
    vi.spyOn(fs, 'readSync').mockImplementation(((...args: any[]) => {
      const count = original(...args); bytesRead += count; return count;
    }) as typeof fs.readSync);
    vi.spyOn(fs, 'readFileSync').mockImplementation(() => { throw new Error('Full-file read is forbidden on indexed range path'); });
    const result = readMessageRangeIndex(f.checkpoint, f.events, undefined, 120, '消息-5000');
    expect(result?.messages).toEqual(f.messages.slice(4940, 5060));
    expect(result).toMatchObject({ before: 4940, total: 10000, metadata: { marker: 42 } });
    expect(bytesRead).toBeLessThan(180000); // page bodies + fixed-width binary search, independent of total
    expect(readMessageRangeIndex(f.checkpoint, f.events, undefined, 120, 'missing')?.messages).toEqual([]);
    expect(readMessageRangeIndex(f.checkpoint, f.events, 3, 2)?.messages).toEqual(f.messages.slice(1, 3));
  });

  it('handles indented checkpoints and empty history', () => {
    const f = fixture(4, true);
    expect(readMessageRangeIndex(f.checkpoint, f.events, undefined, 2)?.messages).toEqual(f.messages.slice(2));
    const empty = fixture(0);
    expect(readMessageRangeIndex(empty.checkpoint, empty.events)).toMatchObject({ messages: [], total: 0, before: 0 });
  });

  it('builds a missing index from root messages without trusting nested fields', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-range-index-scan-')); dirs.push(dir);
    const checkpoint = path.join(dir, 'session.json'), events = path.join(dir, 'session.ndjson');
    const messages = [
      { id: 'plain', parts: [{ text: 'first' }] },
      { id: 'quoted-"汉字🙂', parts: [{ text: 'second' }] },
      { id: 'last', parts: [{ text: 'third', nested: { messages: [{ id: 'fake' }] } }] }
    ];
    const json = JSON.stringify({ version: 2, injections: [{ messages: [{ id: 'fake-root' }] }], lastUsage: null, messages }, null, 2);
    fs.writeFileSync(checkpoint, json); fs.writeFileSync(events, 'event stamp');
    writeMessageRangeIndexFromJson(checkpoint, events, json, { marker: 7 });
    expect(readMessageRangeIndex(checkpoint, events, undefined, 2, 'quoted-"汉字🙂')).toMatchObject({
      messages: messages.slice(0, 2), before: 0, total: 3, metadata: { marker: 7 }
    });
  });

  it('rejects a root message without a stable id while indexing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-range-index-scan-')); dirs.push(dir);
    const checkpoint = path.join(dir, 'session.json'), events = path.join(dir, 'session.ndjson');
    const json = JSON.stringify({ version: 2, messages: [{ parts: [{ text: 'missing id' }] }] });
    fs.writeFileSync(checkpoint, json); fs.writeFileSync(events, 'event stamp');
    expect(() => writeMessageRangeIndexFromJson(checkpoint, events, json, {})).toThrow('no id');
  });

  it('invalidates on checkpoint replacement or a newer event log', () => {
    const f = fixture(3);
    fs.appendFileSync(f.events, '\nnew event');
    expect(readMessageRangeIndex(f.checkpoint, f.events)).toBeNull();
    writeMessageRangeIndex(f.checkpoint, f.events, f.json, f.messages.map(message => message.id), {});
    fs.writeFileSync(f.checkpoint, JSON.stringify({ version: 2, messages: [] }));
    expect(readMessageRangeIndex(f.checkpoint, f.events)).toBeNull();
  });

  it('rejects truncated or corrupt offsets rather than returning unrelated messages', () => {
    const f = fixture(8);
    const file = messageRangeIndexPath(f.checkpoint);
    const bytes = fs.readFileSync(file);
    const ordinalStart = 16 + bytes.readUInt32LE(8);
    bytes.writeDoubleLE(bytes.readDoubleLE(ordinalStart + 48), ordinalStart);
    fs.writeFileSync(file, bytes);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(readMessageRangeIndex(f.checkpoint, f.events, 1, 1)).toBeNull();
    fs.truncateSync(file, 20);
    expect(readMessageRangeIndex(f.checkpoint, f.events)).toBeNull();
    expect(console.warn).toHaveBeenCalled();
  });
  it('reads only the validated envelope for metadata queries', () => {
    const f = fixture();
    let bytes = 0;
    const original = fs.readSync as (...args: any[]) => number;
    vi.spyOn(fs, 'readSync').mockImplementation(((...args: any[]) => {const count = original(...args);bytes += count;return count;}) as typeof fs.readSync);
    vi.spyOn(fs, 'readFileSync').mockImplementation(() => {throw new Error('full file reads forbidden');});
    expect(readMessageRangeMetadata(f.checkpoint, f.events)).toEqual({marker:42});
    expect(bytes).toBeLessThan(1024);
    fs.appendFileSync(f.events, 'changed');
    expect(readMessageRangeMetadata(f.checkpoint, f.events)).toBeNull();
  });

});
