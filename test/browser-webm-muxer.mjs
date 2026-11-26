/** WebM container regression: parse EBML sizes and the actual block layout.
 * VP8 decoding is separately verified by the real Electron recording/playback test. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(import.meta.dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-webm-muxer-'));
const compile = createSharedCompiler(root, tmp);
const { muxWebm, normalizeFrames } = await import(pathToFileURL(compile('main/browser/webmMuxer.ts')));

// Opaque sample payloads test preservation without claiming to decode VP8.
const fakeFrame = mark => Uint8Array.from([0x10, 0x20, mark, 0x30, 0x40]);
assert.throws(() => normalizeFrames([]), /至少需要一帧/);
const norm = normalizeFrames([
  { data: fakeFrame(3), timestampMs: 500 }, { data: fakeFrame(1), timestampMs: 100 },
  { data: fakeFrame(2), timestampMs: 100 }, { data: fakeFrame(0), timestampMs: -20 }
]);
assert.equal(norm.length, 3);
assert.deepEqual(norm.map(frame => frame.timestampMs), [0, 100, 500]);
assert.deepEqual(norm[0].data, fakeFrame(0));

const masters = new Set([0x1a45dfa3, 0x18538067, 0x1549a966, 0x1654ae6b, 0xae, 0xe0, 0x1f43b675]);
function vint(bytes, offset, identifier = false) {
  const first = bytes[offset];
  assert.ok(first, 'a VINT cannot start with zero or exceed the buffer');
  let marker = 0x80, width = 1;
  while (!(first & marker)) { marker >>= 1; width++; }
  assert.ok(width <= (identifier ? 4 : 8));
  assert.ok(offset + width <= bytes.length);
  let value = identifier ? first : first & (marker - 1);
  let unknown = !identifier && value === marker - 1;
  for (let i = 1; i < width; i++) {
    value = value * 256 + bytes[offset + i];
    unknown = unknown && bytes[offset + i] === 0xff;
  }
  return { value, width, unknown };
}
function elements(bytes, start = 0, end = bytes.length) {
  const parsed = [];
  for (let offset = start; offset < end;) {
    const id = vint(bytes, offset, true); offset += id.width;
    const size = vint(bytes, offset); offset += size.width;
    if (size.unknown) assert.equal(id.value, 0x18538067, 'only the streaming Segment may have unknown size');
    const stop = size.unknown ? end : offset + size.value;
    assert.ok(stop <= end, 'the payload must fit its enclosing element');
    const entry = { id: id.value, size, data: bytes.slice(offset, stop) };
    if (masters.has(id.value)) entry.children = elements(bytes, offset, stop);
    parsed.push(entry); offset = stop;
  }
  return parsed;
}
const find = (parent, id) => {
  const found = parent.children.find(element => element.id === id);
  assert.ok(found, 'missing EBML element 0x' + id.toString(16)); return found;
};
const uint = bytes => [...bytes].reduce((value, byte) => value * 256 + byte, 0);
const decode = bytes => new TextDecoder().decode(bytes);

const webm = muxWebm(norm), parsed = elements(webm);
assert.equal(parsed[0].id, 0x1a45dfa3);
assert.equal(decode(find(parsed[0], 0x4282).data), 'webm');
const segment = parsed.find(element => element.id === 0x18538067);
assert.ok(segment.size.unknown);
const info = find(segment, 0x1549a966);
assert.equal(uint(find(info, 0x2ad7b1).data), 1_000_000);
assert.equal(decode(find(info, 0x4d80).data), 'muster-browser');
assert.equal(find(info, 0x73a4).data.length, 16, 'SegmentUID is a 128-bit binary identifier');
const duration = find(info, 0x4489).data;
assert.equal(duration.length, 8, 'Duration uses EBML float64, never an unsigned integer');
assert.equal(new DataView(duration.buffer, duration.byteOffset, duration.byteLength).getFloat64(0, false), 533);
const track = find(find(segment, 0x1654ae6b), 0xae);
assert.equal(decode(find(track, 0x86).data), 'V_VP8');
assert.equal(segment.children.filter(element => element.id === 0x1f43b675).length, norm.length);

// Standard SimpleBlock = track VINT + signed 16-bit timecode + flags + coded frame.
// https://www.matroska.org/technical/notes.html#simpleblock-structure
const mixedFrames = [
  { data: fakeFrame(1), timestampMs: 0, width: 2, height: 2, key: true },
  { data: fakeFrame(2), timestampMs: 100, width: 2, height: 2, key: false },
  { data: fakeFrame(3), timestampMs: 200, width: 2, height: 2 }
];
const mixedSegment = elements(muxWebm(mixedFrames)).find(element => element.id === 0x18538067);
const clusters = mixedSegment.children.filter(element => element.id === 0x1f43b675);
for (let i = 0; i < clusters.length; i++) {
  const cluster = clusters[i], block = find(cluster, 0xa3).data;
  assert.equal(uint(find(cluster, 0xe7).data), mixedFrames[i].timestampMs);
  assert.equal(block.length, 4 + mixedFrames[i].data.length);
  assert.deepEqual([...block.slice(0, 3)], [0x81, 0x00, 0x00], 'both relative timecode bytes precede flags');
  assert.equal(block[3], i === 1 ? 0 : 0x80);
  assert.deepEqual(block.slice(4), mixedFrames[i].data, 'encoded payload begins after all four header bytes');
}
const video = find(find(find(mixedSegment, 0x1654ae6b), 0xae), 0xe0);
assert.equal(uint(find(video, 0xb0).data), 2); assert.equal(uint(find(video, 0xba).data), 2);

// A 127-byte block cannot use the one-byte all-ones unknown-size VINT.
const boundary = elements(muxWebm([{ data: new Uint8Array(123), timestampMs: 0 }])).find(element => element.id === 0x18538067);
const boundaryBlock = find(find(boundary, 0x1f43b675), 0xa3);
assert.equal(boundaryBlock.size.value, 127); assert.equal(boundaryBlock.size.width, 2);
assert.equal(boundaryBlock.size.unknown, false);
fs.writeFileSync(path.join(tmp, 'probe.webm'), webm);
console.log('browser-webm-muxer: all assertions passed,', webm.length, 'bytes');
