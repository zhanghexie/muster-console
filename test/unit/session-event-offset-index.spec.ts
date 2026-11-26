import { describe, expect, it } from 'vitest';
import {
  SessionEventOffsetIndex,
  SESSION_EVENT_OFFSET_INDEX_VERSION
} from '../../src/main/runtimeKernel/sessionEventOffsetIndex';

describe('SessionEventOffsetIndex', () => {
  it('keeps sparse checkpoints and seeks from the nearest preceding byte offset', () => {
    const index = new SessionEventOffsetIndex(3);
    for (let seq = 1; seq <= 10; seq += 1) index.observe(seq, (seq - 1) * 97);

    expect(index.lastSeq).toBe(10);
    expect(index.size).toBe(4);
    expect(index.entries()).toEqual([
      { seq: 1, byteOffset: 0 },
      { seq: 4, byteOffset: 291 },
      { seq: 7, byteOffset: 582 },
      { seq: 10, byteOffset: 873 }
    ]);
    expect(index.seek(1)).toEqual({ seq: 1, byteOffset: 0 });
    expect(index.seek(3)).toEqual({ seq: 1, byteOffset: 0 });
    expect(index.seek(4)).toEqual({ seq: 4, byteOffset: 291 });
    expect(index.seek(9)).toEqual({ seq: 7, byteOffset: 582 });
    expect(index.seek(100)).toEqual({ seq: 10, byteOffset: 873 });
  });

  it('round-trips a sidecar and rejects stale file stamps', () => {
    const index = new SessionEventOffsetIndex(2);
    index.observe(1, 0);
    index.observe(2, 42);
    index.observe(3, 89);
    const file = { byteLength: 140, mtimeMs: 1234.5 };
    const snapshot = index.snapshot(file);

    expect(snapshot).toEqual({
      version: SESSION_EVENT_OFFSET_INDEX_VERSION,
      stride: 2,
      lastSeq: 3,
      file,
      checkpoints: [{ seq: 1, byteOffset: 0 }, { seq: 3, byteOffset: 89 }]
    });

    const restored = SessionEventOffsetIndex.fromSnapshot(JSON.parse(JSON.stringify(snapshot)));
    expect(restored.entries()).toEqual(index.entries());
    expect(restored.seek(3)).toEqual({ seq: 3, byteOffset: 89 });
    expect(restored.matches(file)).toBe(true);
    expect(restored.matches({ ...file, byteLength: file.byteLength + 1 })).toBe(false);
    expect(restored.matches({ ...file, mtimeMs: file.mtimeMs + 1 })).toBe(false);

    // Appending after a snapshot invalidates the old stamp until the caller
    // captures a new one alongside the updated log.
    index.observe(4, 140);
    expect(index.matches(file)).toBe(false);
  });

  it('fails closed on gaps, offset regressions and malformed snapshots', () => {
    const index = new SessionEventOffsetIndex(4);
    expect(() => index.observe(2, 0)).toThrow('expected 1');
    index.observe(1, 0);
    expect(() => index.observe(2, 0)).toThrow('byte offset must increase');

    expect(() => SessionEventOffsetIndex.fromSnapshot({
      version: SESSION_EVENT_OFFSET_INDEX_VERSION,
      stride: 2,
      lastSeq: 3,
      file: { byteLength: 10, mtimeMs: 1 },
      checkpoints: [{ seq: 2, byteOffset: 0 }]
    })).toThrow('first checkpoint');

    expect(() => SessionEventOffsetIndex.fromSnapshot({
      version: SESSION_EVENT_OFFSET_INDEX_VERSION,
      stride: 2,
      lastSeq: 4,
      file: { byteLength: 10, mtimeMs: 1 },
      checkpoints: [{ seq: 1, byteOffset: 0 }, { seq: 4, byteOffset: 8 }]
    })).toThrow('does not match stride');
  });
});

