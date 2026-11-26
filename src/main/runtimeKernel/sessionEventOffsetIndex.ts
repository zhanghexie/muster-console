/**
 * Sparse byte-offset index for append-only session-event NDJSON files.
 *
 * This module deliberately does not read or write the event log. A caller can
 * observe an event's sequence and byte offset while it is scanning/appending,
 * persist the returned snapshot next to the log, and use `seek()` to choose a
 * bounded scan start for a later range read. The NDJSON envelope and the
 * SessionHandleContract therefore remain unchanged.
 */

export const SESSION_EVENT_OFFSET_INDEX_VERSION = 1 as const;
export const DEFAULT_SESSION_EVENT_OFFSET_STRIDE = 128;

export type SessionEventFileStamp = {
  /** File size in bytes at the point the index was produced. */
  byteLength: number;
  /** `fs.Stats.mtimeMs` at the point the index was produced. */
  mtimeMs: number;
};

export type SessionEventOffsetCheckpoint = {
  /** Sequence represented by the first byte of the corresponding line. */
  seq: number;
  /** UTF-8 byte offset of the line containing `seq`. */
  byteOffset: number;
};

export type SessionEventOffsetIndexSnapshot = {
  version: typeof SESSION_EVENT_OFFSET_INDEX_VERSION;
  stride: number;
  lastSeq: number;
  file: SessionEventFileStamp;
  checkpoints: SessionEventOffsetCheckpoint[];
};

export type SessionEventSeek = SessionEventOffsetCheckpoint;

function assertPositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`);
}

function assertNonNegativeSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer`);
}

function validateFileStamp(value: unknown): SessionEventFileStamp {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Session event index file stamp is invalid');
  const stamp = value as Partial<SessionEventFileStamp>;
  assertNonNegativeSafeInteger(stamp.byteLength ?? Number.NaN, 'Session event index file byteLength');
  if (typeof stamp.mtimeMs !== 'number' || !Number.isFinite(stamp.mtimeMs) || stamp.mtimeMs < 0) {
    throw new Error('Session event index file mtimeMs is invalid');
  }
  return { byteLength: stamp.byteLength!, mtimeMs: stamp.mtimeMs };
}

function validateCheckpoint(value: unknown, index: number): SessionEventOffsetCheckpoint {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Session event index checkpoint ${index} is invalid`);
  }
  const checkpoint = value as Partial<SessionEventOffsetCheckpoint>;
  assertPositiveSafeInteger(checkpoint.seq ?? Number.NaN, `Session event index checkpoint ${index} seq`);
  assertNonNegativeSafeInteger(checkpoint.byteOffset ?? Number.NaN, `Session event index checkpoint ${index} byteOffset`);
  return { seq: checkpoint.seq!, byteOffset: checkpoint.byteOffset! };
}

/**
 * An in-memory sparse index. `observe` is intentionally strict: event logs are
 * sequence ordered, so accepting gaps or offset regressions would make a
 * persisted sidecar unsafe to use for a range read.
 */
export class SessionEventOffsetIndex {
  private readonly checkpoints: SessionEventOffsetCheckpoint[] = [];
  private lastSeqValue = 0;
  private fileStamp: SessionEventFileStamp | undefined;

  constructor(readonly stride = DEFAULT_SESSION_EVENT_OFFSET_STRIDE) {
    if (!Number.isSafeInteger(stride) || stride < 1) {
      throw new Error('Session event index stride must be a positive safe integer');
    }
  }

  /** Number of events represented by the observed prefix. */
  get lastSeq(): number {
    return this.lastSeqValue;
  }

  /** Number of sparse checkpoints retained by this index. */
  get size(): number {
    return this.checkpoints.length;
  }

  /** A defensive copy suitable for diagnostics or tests. */
  entries(): SessionEventOffsetCheckpoint[] {
    return this.checkpoints.map(checkpoint => ({ ...checkpoint }));
  }

  /**
   * Observe one event line. `byteOffset` must point at the first byte of the
   * JSON line, before any UTF-8 decoding occurs.
   */
  observe(seq: number, byteOffset: number): void {
    assertPositiveSafeInteger(seq, 'Session event index seq');
    assertNonNegativeSafeInteger(byteOffset, 'Session event index byteOffset');
    if (seq !== this.lastSeqValue + 1) {
      throw new Error(`Session event index sequence must advance by one (expected ${this.lastSeqValue + 1}, got ${seq})`);
    }
    const previous = this.checkpoints[this.checkpoints.length - 1];
    if (previous && byteOffset <= previous.byteOffset) {
      throw new Error('Session event index byte offset must increase');
    }
    // Any mutation means a previously captured file stamp no longer describes
    // the index. The caller can capture a fresh stamp on the next snapshot.
    this.fileStamp = undefined;
    this.lastSeqValue = seq;
    // Keep the first event and then every `stride` events. This gives a
    // bounded scan of at most stride - 1 preceding records for a valid range.
    if (seq === 1 || (seq - 1) % this.stride === 0) {
      this.checkpoints.push({ seq, byteOffset });
    }
  }

  /**
   * Return the nearest checkpoint at or before `fromSeq`.
   *
   * A caller should still validate the sidecar's file stamp before using the
   * returned offset. `undefined` means that this index has observed no events.
   */
  seek(fromSeq = 1): SessionEventSeek | undefined {
    assertPositiveSafeInteger(fromSeq, 'Session event index fromSeq');
    if (this.checkpoints.length === 0) return undefined;
    let low = 0;
    let high = this.checkpoints.length;
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2);
      if (this.checkpoints[middle].seq <= fromSeq) low = middle + 1;
      else high = middle;
    }
    return { ...this.checkpoints[Math.max(0, low - 1)] };
  }

  /** Build a sidecar payload for a particular file version. */
  snapshot(file: SessionEventFileStamp): SessionEventOffsetIndexSnapshot {
    const stamp = validateFileStamp(file);
    this.fileStamp = stamp;
    return {
      version: SESSION_EVENT_OFFSET_INDEX_VERSION,
      stride: this.stride,
      lastSeq: this.lastSeqValue,
      file: { ...stamp },
      checkpoints: this.entries()
    };
  }

  /** True only when the index was produced for the exact observed file stamp. */
  matches(file: SessionEventFileStamp): boolean {
    if (!this.fileStamp) return false;
    const value = validateFileStamp(file);
    return value.byteLength === this.fileStamp.byteLength && value.mtimeMs === this.fileStamp.mtimeMs;
  }

  /** Restore a validated index sidecar without changing the event protocol. */
  static fromSnapshot(value: unknown): SessionEventOffsetIndex {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Session event index snapshot is invalid');
    const snapshot = value as Partial<SessionEventOffsetIndexSnapshot>;
    if (snapshot.version !== SESSION_EVENT_OFFSET_INDEX_VERSION) throw new Error('Session event index version is unsupported');
    const stride = snapshot.stride;
    if (typeof stride !== 'number' || !Number.isSafeInteger(stride) || stride < 1) throw new Error('Session event index stride is invalid');
    const lastSeq = snapshot.lastSeq;
    if (typeof lastSeq !== 'number' || !Number.isSafeInteger(lastSeq) || lastSeq < 0) throw new Error('Session event index lastSeq is invalid');
    const file = validateFileStamp(snapshot.file);
    if (!Array.isArray(snapshot.checkpoints)) throw new Error('Session event index checkpoints are invalid');

    const index = new SessionEventOffsetIndex(stride);
    let previous: SessionEventOffsetCheckpoint | undefined;
    for (let i = 0; i < snapshot.checkpoints.length; i += 1) {
      const checkpoint = validateCheckpoint(snapshot.checkpoints[i], i);
      if (i === 0 && checkpoint.seq !== 1) throw new Error('Session event index first checkpoint must be seq 1');
      if (checkpoint.seq === 1 && i !== 0) throw new Error('Session event index first checkpoint is misplaced');
      if (previous && (checkpoint.seq <= previous.seq || checkpoint.byteOffset <= previous.byteOffset)) {
        throw new Error('Session event index checkpoints must be strictly increasing');
      }
      if (checkpoint.seq !== 1 && (checkpoint.seq - 1) % index.stride !== 0) {
        throw new Error('Session event index checkpoint does not match stride');
      }
      previous = checkpoint;
      index.checkpoints.push(checkpoint);
    }
    if (lastSeq === 0 && index.checkpoints.length > 0) {
      throw new Error('Session event index has checkpoints but no events');
    }
    if (lastSeq > 0 && index.checkpoints.length === 0) {
      throw new Error('Session event index is missing its first checkpoint');
    }
    if (previous && previous.seq > lastSeq) {
      throw new Error('Session event index checkpoint exceeds lastSeq');
    }
    index.lastSeqValue = lastSeq;
    index.fileStamp = file;
    return index;
  }
}

