import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { EventEnvelope, SessionHandleContract, SessionRangeQuery } from './contracts';
import {
  DEFAULT_SESSION_EVENT_OFFSET_STRIDE,
  SessionEventOffsetIndex,
  type SessionEventFileStamp
} from './sessionEventOffsetIndex';

const WRITE_BEHIND_MS = 200;
const MAX_RANGE_LIMIT = 1000;
const MAX_RECENT_EVENT_IDS = 4096;
const DEFAULT_MAX_PENDING_BYTES = 8 * 1024 * 1024;
const SESSION_ID_RE = /^[a-zA-Z0-9_-]+$/;
const OFFSET_INDEX_SUFFIX = '.index.json';

/** Integrity covers the acceleration payload only, never its own checksum. */
function recoveryIndexChecksum(value: Record<string, unknown>): string {
  const { checksum: _checksum, ...payload } = value;
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function sameFileStamp(a: SessionEventFileStamp, b: SessionEventFileStamp): boolean {
  return a.byteLength === b.byteLength && a.mtimeMs === b.mtimeMs;
}

function sameCheckpoints(
  a: readonly { seq: number; byteOffset: number }[],
  b: readonly { seq: number; byteOffset: number }[]
): boolean {
  return a.length === b.length && a.every((item, index) => {
    const other = b[index];
    return item.seq === other?.seq && item.byteOffset === other?.byteOffset;
  });
}

export type SessionEventLogOptions = {
  writeBehindMs?: number;
  createEventId?: () => string;
  /** Sparse checkpoint spacing for the optional range-read sidecar. */
  offsetIndexStride?: number;
  /** Maximum encoded bytes retained before the write-behind append. */
  maxPendingBytes?: number;
};

/** File-backed append-only session log used by scheduler and GUI adapters. */
export class SessionEventLog implements SessionHandleContract {
  private readonly file: string;
  private readonly indexFile: string;
  private readonly recentEventSeqById = new Map<string, number>();
  private readonly pending: Array<{ event: EventEnvelope; serialized: string; bytes: number }> = [];
  private readonly listeners = new Set<(event: EventEnvelope) => void>();
  private readonly writeBehindMs: number;
  private readonly createEventId: () => string;
  private readonly offsetIndexStride: number;
  private readonly maxPendingBytes: number;
  private offsetIndex: SessionEventOffsetIndex;
  private loaded = false;
  private loadPromise: Promise<void> | null = null;
  private flushPromise: Promise<void> | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private eventCount = 0;
  private persistedEventCount = 0;
  private persistedFileStamp: SessionEventFileStamp | undefined;
  private nextByteOffset = 0;
  private pendingBytes = 0;

  constructor(
    private readonly rootDir: string,
    readonly sessionId: string,
    options: SessionEventLogOptions = {}
  ) {
    if (!SESSION_ID_RE.test(sessionId)) throw new Error(`Invalid session id: ${sessionId}`);
    this.file = path.join(rootDir, `${sessionId}.ndjson`);
    this.indexFile = `${this.file}${OFFSET_INDEX_SUFFIX}`;
    this.writeBehindMs = options.writeBehindMs ?? WRITE_BEHIND_MS;
    this.createEventId = options.createEventId ?? randomUUID;
    this.offsetIndexStride = options.offsetIndexStride ?? DEFAULT_SESSION_EVENT_OFFSET_STRIDE;
    this.maxPendingBytes = options.maxPendingBytes ?? DEFAULT_MAX_PENDING_BYTES;
    if (!Number.isSafeInteger(this.maxPendingBytes) || this.maxPendingBytes < 1) throw new Error('Session pending byte limit is invalid');
    this.offsetIndex = new SessionEventOffsetIndex(this.offsetIndexStride);
  }

  async append(event: EventEnvelope): Promise<{ seq: number }> {
    await this.ensureLoaded();
    return this.appendLoaded(event);
  }

  /** Synchronous append used by in-process projections that must flush during quit. */
  appendSync(event: EventEnvelope): { seq: number } {
    this.loadSync();
    return this.appendLoaded(event);
  }

  get hasPendingWrites(): boolean {
    return this.pending.length > 0 || this.flushPromise !== null || this.flushTimer !== null;
  }

  /** Encoded bytes waiting for the write-behind append (including newlines). */
  get pendingBytesCount(): number { return this.pendingBytes; }

  private appendLoaded(event: EventEnvelope): { seq: number } {
    this.validateEvent(event);
    const existingSeq = this.recentEventSeqById.get(event.eventId);
    if (existingSeq !== undefined) return { seq: existingSeq };
    const next: EventEnvelope = {
      ...event,
      sessionId: this.sessionId,
      seq: this.eventCount + 1
    };
    // Serialize once at admission and retain the encoded form for flush. A
    // streaming GUI turn can append hundreds of deltas; serializing every
    // event again at flush doubled CPU and transient allocations.
    const serialized = this.serializeEvent(next);
    const bytes = Buffer.byteLength(serialized, 'utf8') + 1;
    if (this.pendingBytes + bytes > this.maxPendingBytes) {
      throw new Error(`Session event pending byte limit exceeded (${this.maxPendingBytes})`);
    }
    this.eventCount = next.seq;
    this.rememberEventId(next.eventId, next.seq);
    this.offsetIndex.observe(next.seq, this.nextByteOffset);
    this.nextByteOffset += bytes;
    this.pending.push({ event: next, serialized, bytes });
    this.pendingBytes += bytes;
    for (const listener of [...this.listeners]) {
      try { listener(next); } catch (error) { console.error('[runtime-kernel] session event listener failed:', error); }
    }
    this.scheduleFlush();
    return { seq: next.seq };
  }

  async readRange(query: SessionRangeQuery): Promise<EventEnvelope[]> {
    await this.ensureLoaded();
    const limit = this.validateLimit(query.limit);
    const from = Math.max(1, query.fromSeq ?? 1);
    const to = Math.min(this.eventCount, query.toSeq ?? Number.MAX_SAFE_INTEGER);
    if (to < from) return [];
    const pending = this.pending.map(item => item.event).filter(event => event.seq >= from && event.seq <= to);
    const persisted = await this.readPersistedRange(from, to, limit);
    if (persisted.length >= limit || pending.length === 0) return persisted.slice(0, limit);
    const bySeq = new Map<number, EventEnvelope>();
    for (const event of persisted) bySeq.set(event.seq, event);
    for (const event of pending) bySeq.set(event.seq, event);
    return [...bySeq.values()].sort((a, b) => a.seq - b.seq).slice(0, limit);
  }

  readRangeSync(query: SessionRangeQuery): EventEnvelope[] {
    this.loadSync();
    const limit = this.validateLimit(query.limit);
    const from = Math.max(1, query.fromSeq ?? 1);
    const to = Math.min(this.eventCount, query.toSeq ?? Number.MAX_SAFE_INTEGER);
    if (to < from) return [];
    const stamp = this.fileStampSync();
    const seek = this.persistedFileStamp && sameFileStamp(stamp, this.persistedFileStamp) ? this.offsetIndex.seek(from) : undefined;
    const events: EventEnvelope[] = [];
    const done = {}, invalidSeek = {};
    const scan = (start = seek): void => {
      let expected = start?.seq ?? 1;
      let first = true;
      try {
        this.forEachFileLineSync((line, lineNumber) => {
          if (!line.trim()) return;
          let event: EventEnvelope;
          try {
            let raw: unknown;
            try { raw = JSON.parse(line); } catch { throw new Error(`Session event log line ${lineNumber} is invalid JSON`); }
            event = this.parseEvent(raw, lineNumber);
            if (event.seq !== expected++) throw new Error(`Session event log sequence gap at ${lineNumber}`);
          } catch (error) {
            if (first && start && start.byteOffset > 0) throw invalidSeek;
            throw error;
          }
          first = false;
          if (event.seq > to) throw done;
          if (event.seq >= from) events.push(event);
          if (events.length >= limit) throw done;
        }, this.persistedFileStamp?.byteLength ?? 0, start?.byteOffset ?? 0);
      } catch (error) { if (error !== done) throw error; }
    };
    try { scan(); } catch (error) {
      if (error !== invalidSeek) throw error;
      events.length = 0;
      scan({seq: 1, byteOffset: 0});
    }
    const bySeq = new Map(events.map(event => [event.seq, event]));
    for (const item of this.pending) if (item.event.seq >= from && item.event.seq <= to) bySeq.set(item.event.seq, item.event);
    return [...bySeq.values()].sort((a,b) => a.seq-b.seq).slice(0, limit);
  }

  async readAll(): Promise<EventEnvelope[]> {
    await this.ensureLoaded();
    const pending = this.pending.map(item => item.event);
    const persisted = await this.readPersistedRange(1, this.eventCount, Number.MAX_SAFE_INTEGER);
    const bySeq = new Map<number, EventEnvelope>();
    for (const event of persisted) bySeq.set(event.seq, event);
    for (const event of pending) bySeq.set(event.seq, event);
    return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  }

  loadSync(consumer?: (event: EventEnvelope) => void): void {
    if (!this.loaded && !consumer) {
      const sidecar = this.readOffsetIndexSync();
      const recent = this.readRecoveryIdsSync();
      const stamp = this.fileStampSync();
      if (sidecar?.matches(stamp) && recent && recent.length === Math.min(sidecar.lastSeq, MAX_RECENT_EVENT_IDS) &&
          recent.every(([,seq], index) => seq === sidecar.lastSeq - recent.length + index + 1)) {
        this.offsetIndex = sidecar;
        this.eventCount = this.persistedEventCount = sidecar.lastSeq;
        this.nextByteOffset = stamp.byteLength;
        this.persistedFileStamp = stamp;
        for (const [id, seq] of recent) this.rememberEventId(id, seq);
        this.loaded = true;
        return;
      }
    }
    if (this.loaded) {
      // A second projection may share this factory-owned writer. Replay into
      // that projection without resetting writer offsets or allocating readAll.
      if (consumer) {
        this.forEachFileLineSync((line, lineNumber) => {
          if (line.trim()) consumer(this.parseEvent(JSON.parse(line), lineNumber));
        }, this.persistedFileStamp?.byteLength ?? 0);
        for (const item of this.pending) consumer(item.event);
      }
      return;
    }
    fs.mkdirSync(this.rootDir, { recursive: true });
    let tornTail = false;
    let unterminatedTail = false;
    this.forEachFileLineSync((line, lineNumber, unterminated, byteOffset) => {
      try {
        const event = this.consumePersistedLine(line, lineNumber, byteOffset);
        if (event) consumer?.(event);
        if (unterminated) unterminatedTail = true;
      } catch (error) {
        if (unterminated && this.isTornTailError(error)) {
          tornTail = true;
          return;
        }
        throw error;
      }
    });
    if (tornTail) this.truncateTornTailSync();
    else if (unterminatedTail) this.ensureTrailingNewlineSync();
    this.loaded = true;
    this.finalizeLoaded();
  }

  readAllSync(): EventEnvelope[] {
    this.loadSync();
    const persisted: EventEnvelope[] = [];
    this.forEachFileLineSync((line, lineNumber) => {
      if (!line.trim()) return;
      let raw: unknown;
      try { raw = JSON.parse(line); } catch { throw new Error(`Session event log line ${lineNumber} is invalid JSON`); }
      persisted.push(this.parseEvent(raw, lineNumber));
    }, this.persistedFileStamp?.byteLength ?? 0);
    return [...persisted, ...this.pending.map(item => item.event)].sort((a, b) => a.seq - b.seq);
  }

  subscribeLive(listener: (event: EventEnvelope) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async flush(_reason: string): Promise<void> {
    await this.ensureLoaded();
    if (this.flushPromise) return this.flushPromise;
    this.flushPromise = this.flushPending();
    try {
      await this.flushPromise;
    } finally {
      this.flushPromise = null;
    }
  }

  /** Synchronous emergency drain used after the async quit barrier has settled. */
  flushSync(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.flushPromise) return;
    if (this.pending.length === 0) {
      this.persistOffsetIndexSync();
      return;
    }
    fs.mkdirSync(this.rootDir, { recursive: true });
    const batch = this.pending.splice(0, this.pending.length);
    try {
      fs.appendFileSync(this.file, `${batch.map(item => item.serialized).join('\n')}\n`, 'utf8');
      this.pendingBytes -= batch.reduce((total, item) => total + item.bytes, 0);
      this.persistOffsetIndexSync();
    } catch (error) {
      this.pending.unshift(...batch);
      this.pendingBytes += batch.reduce((total, item) => total + item.bytes, 0);
      throw error;
    }
  }

  deleteSync(): void {
    if (this.flushPromise) throw new Error('Cannot delete a session while its write is in flight');
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.pending.length = 0;
    this.pendingBytes = 0;
    try { fs.unlinkSync(this.file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    try { fs.unlinkSync(this.indexFile); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    this.recentEventSeqById.clear();
    this.eventCount = 0;
    this.persistedEventCount = 0;
    this.persistedFileStamp = undefined;
    this.nextByteOffset = 0;
    this.offsetIndex = new SessionEventOffsetIndex(this.offsetIndexStride);
    this.loaded = true;
  }

  async fork(options: { atSeq?: number } = {}): Promise<{ sessionId: string }> {
    await this.ensureLoaded();
    if (options.atSeq !== undefined && (!Number.isSafeInteger(options.atSeq) || options.atSeq < 0)) {
      throw new Error('Fork sequence must be a non-negative safe integer');
    }
    // Capture the boundary before yielding to flush; concurrent appends belong
    // to the parent, not to this fork.
    const atSeq = Math.min(this.eventCount, options.atSeq ?? this.eventCount);
    await this.flush('fork');
    const forkedSessionId = this.createEventId();
    if (!SESSION_ID_RE.test(forkedSessionId)) throw new Error('Generated fork session id is invalid');
    const forkedFile = path.join(this.rootDir, `${forkedSessionId}.ndjson`);
    await fs.promises.mkdir(this.rootDir, { recursive: true });
    // Exclusive creation prevents an ID collision from truncating another
    // session (including the parent). The new ID is published only on success.
    const output = await fs.promises.open(forkedFile, 'wx');
    try {
      for (let fromSeq = 1; fromSeq <= atSeq;) {
        const batch = await this.readRange({ fromSeq, toSeq: atSeq, limit: 512 });
        if (!batch.length || batch.some((event, index) => event.seq !== fromSeq + index)) {
          throw new Error(`Fork source has a sequence gap at ${fromSeq}`);
        }
        await output.writeFile(batch.map(event => this.serializeEvent({
          ...event,
          eventId: this.createEventId(),
          sessionId: forkedSessionId
        })).join('\n') + '\n', 'utf8');
        fromSeq += batch.length;
      }
    } catch (error) {
      await output.close();
      await fs.promises.unlink(forkedFile);
      throw error;
    }
    await output.close();
    return { sessionId: forkedSessionId };
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    if (!this.loadPromise) this.loadPromise = this.loadFromDisk();
    await this.loadPromise;
  }

  private async loadFromDisk(): Promise<void> {
    await fs.promises.mkdir(this.rootDir, { recursive: true });
    let stream: fs.ReadStream;
    try {
      stream = fs.createReadStream(this.file);
      await this.consumePersistedLines(stream);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.loaded = true;
        this.finalizeLoaded();
        return;
      }
      throw error;
    }
    this.loaded = true;
    this.finalizeLoaded();
  }

  private async consumePersistedLines(stream: fs.ReadStream): Promise<void> {
    let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let lineNumber = 0;
    let byteOffset = 0;
    let tornTail = false;
    let unterminatedTail = false;
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      // `bytes` may be a view over a reusable stream buffer. Copy the first
      // chunk before the next read can overwrite it while a long JSON line is
      // still being assembled.
      buffer = (buffer.length ? Buffer.concat([buffer, bytes]) : Buffer.from(bytes)) as Buffer<ArrayBufferLike>;
      let newline = buffer.indexOf(0x0a);
      while (newline >= 0) {
        const rawLine = buffer.subarray(0, newline);
        buffer = buffer.subarray(newline + 1);
        const line = rawLine.toString('utf8').replace(/\r$/, '');
        this.consumePersistedLine(line, ++lineNumber, byteOffset);
        byteOffset += rawLine.length + 1;
        newline = buffer.indexOf(0x0a);
      }
    }
    if (buffer.toString('utf8').trim()) {
      const line = buffer.toString('utf8');
      try {
        this.consumePersistedLine(line, ++lineNumber, byteOffset);
        unterminatedTail = true;
      } catch (error) {
        if (!this.isTornTailError(error)) throw error;
        tornTail = true;
      }
    }
    if (tornTail) await this.truncateTornTail();
    else if (unterminatedTail) await this.ensureTrailingNewline();
  }

  private forEachFileLineSync(consumer: (line: string, lineNumber: number, unterminated: boolean, byteOffset: number) => void, byteLimit = Number.MAX_SAFE_INTEGER, startOffset = 0): void {
    let fd: number;
    try {
      fd = fs.openSync(this.file, 'r');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let lineNumber = 0;
    let byteOffset = startOffset;
    const consumeChunk = (bytes: Buffer): void => {
      buffer = (buffer.length ? Buffer.concat([buffer, bytes]) : Buffer.from(bytes)) as Buffer<ArrayBufferLike>;
      let newline = buffer.indexOf(0x0a);
      while (newline >= 0) {
        const rawLine = buffer.subarray(0, newline);
        buffer = buffer.subarray(newline + 1);
        consumer(rawLine.toString('utf8').replace(/\r$/, ''), ++lineNumber, false, byteOffset);
        byteOffset += rawLine.length + 1;
        newline = buffer.indexOf(0x0a);
      }
    };
    try {
      let bytesRead = 0, readTotal = startOffset;
      while (readTotal < byteLimit && (bytesRead = fs.readSync(fd, chunk, 0, Math.min(chunk.length, byteLimit - readTotal), readTotal)) > 0) {
        consumeChunk(chunk.subarray(0, bytesRead));
        readTotal += bytesRead;
      }
      if (buffer.toString('utf8').trim()) consumer(buffer.toString('utf8'), ++lineNumber, true, byteOffset);
    } finally {
      fs.closeSync(fd);
    }
  }

  private consumePersistedLine(line: string, lineNumber: number, byteOffset?: number): EventEnvelope | undefined {
    if (!line.trim()) return undefined;
    let raw: unknown;
    try { raw = JSON.parse(line); } catch { throw new Error(`Session event log line ${lineNumber} is invalid JSON`); }
    const event = this.parseEvent(raw, lineNumber);
    const expectedSeq = this.eventCount + 1;
    if (event.seq !== expectedSeq) throw new Error(`Session event log sequence gap at ${lineNumber}`);
    if (this.recentEventSeqById.has(event.eventId)) throw new Error(`Session event log duplicate event id at ${lineNumber}`);
    this.eventCount = event.seq;
    this.rememberEventId(event.eventId, event.seq);
    if (byteOffset !== undefined) this.offsetIndex.observe(event.seq, byteOffset);
    return event;
  }

  private isTornTailError(error: unknown): boolean {
    return error instanceof Error && /invalid JSON/.test(error.message);
  }

  private truncateTornTailSync(): void {
    try {
      const text = fs.readFileSync(this.file, 'utf8');
      const newline = text.lastIndexOf('\n');
      fs.writeFileSync(this.file, newline >= 0 ? text.slice(0, newline + 1) : '', 'utf8');
      console.warn(`[runtime-kernel] truncated torn session event tail: ${this.file}`);
    } catch (error) {
      throw new Error(`Session event log torn tail recovery failed: ${String(error)}`);
    }
  }

  private async truncateTornTail(): Promise<void> {
    try {
      const text = await fs.promises.readFile(this.file, 'utf8');
      const newline = text.lastIndexOf('\n');
      await fs.promises.writeFile(this.file, newline >= 0 ? text.slice(0, newline + 1) : '', 'utf8');
      console.warn(`[runtime-kernel] truncated torn session event tail: ${this.file}`);
    } catch (error) {
      throw new Error(`Session event log torn tail recovery failed: ${String(error)}`);
    }
  }

  private ensureTrailingNewlineSync(): void {
    try {
      fs.appendFileSync(this.file, '\n', 'utf8');
    } catch (error) {
      throw new Error(`Session event log newline recovery failed: ${String(error)}`);
    }
  }

  private async ensureTrailingNewline(): Promise<void> {
    try {
      await fs.promises.appendFile(this.file, '\n', 'utf8');
    } catch (error) {
      throw new Error(`Session event log newline recovery failed: ${String(error)}`);
    }
  }

  private finalizeLoaded(): void {
    const stamp = this.fileStampSync();
    this.nextByteOffset = stamp.byteLength;
    this.persistedEventCount = this.eventCount;
    this.persistedFileStamp = { ...stamp };

    // A sidecar is only an acceleration hint. The loaded event prefix remains
    // the authority: if the sidecar stamp, stride, or checkpoints disagree
    // with the controlled rebuild, keep the rebuilt index and replace the
    // sidecar. This also makes torn-tail/newline recovery invalidate it.
    const sidecar = this.readOffsetIndexSync();
    const rebuiltEntries = this.offsetIndex.entries();
    const useSidecar = !!sidecar &&
      sidecar.lastSeq === this.eventCount &&
      sidecar.stride === this.offsetIndexStride &&
      sidecar.matches(stamp) &&
      sameCheckpoints(sidecar.entries(), rebuiltEntries) && this.readRecoveryIdsSync() !== undefined;
    if (useSidecar) {
      this.offsetIndex = sidecar!;
      return;
    }
    this.persistOffsetIndexSync();
  }

  private readRecoveryIdsSync(): Array<[string, number]> | undefined {
    try {
      const snapshot = JSON.parse(fs.readFileSync(this.indexFile, 'utf8')) as Record<string, unknown>;
      if (typeof snapshot.checksum !== 'string' || snapshot.checksum !== recoveryIndexChecksum(snapshot)) return undefined;
      const value = snapshot.recentEventIds;
      if (!Array.isArray(value) || value.length > MAX_RECENT_EVENT_IDS) return undefined;
      const ids = new Set<string>();
      let previous = 0;
      for (const entry of value) {
        if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || !entry[0] ||
            !Number.isSafeInteger(entry[1]) || entry[1] <= previous || ids.has(entry[0])) return undefined;
        ids.add(entry[0]); previous = entry[1];
      }
      const lastSeq = snapshot.lastSeq;
      if (typeof lastSeq !== 'number' || !Number.isSafeInteger(lastSeq) || value.length !== Math.min(lastSeq, MAX_RECENT_EVENT_IDS) ||
          !value.every((entry, index) => entry[1] === lastSeq - value.length + index + 1)) return undefined;
      return value;
    } catch { return undefined; }
  }

  private readOffsetIndexSync(): SessionEventOffsetIndex | undefined {
    let raw: string;
    try {
      raw = fs.readFileSync(this.indexFile, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      console.warn(`[runtime-kernel] ignoring unreadable session event index: ${this.indexFile}`, error);
      return undefined;
    }
    try {
      return SessionEventOffsetIndex.fromSnapshot(JSON.parse(raw));
    } catch (error) {
      console.warn(`[runtime-kernel] ignoring invalid session event index: ${this.indexFile}`, error);
      return undefined;
    }
  }

  private fileStampSync(): SessionEventFileStamp {
    try {
      const stats = fs.statSync(this.file);
      return { byteLength: stats.size, mtimeMs: stats.mtimeMs };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { byteLength: 0, mtimeMs: 0 };
      throw error;
    }
  }

  private persistOffsetIndexSync(): void {
    if (this.pending.length > 0 || this.offsetIndex.lastSeq !== this.eventCount) return;
    const stamp = this.fileStampSync();
    // A file edited behind this handle cannot safely reuse our offsets. The
    // next restart will perform the bounded controlled rebuild instead.
    if (stamp.byteLength !== this.nextByteOffset) {
      this.persistedFileStamp = undefined;
      return;
    }
    const payload = { ...this.offsetIndex.snapshot(stamp), recentEventIds: [...this.recentEventSeqById] };
    const snapshot = { ...payload, checksum: recoveryIndexChecksum(payload) };
    this.persistedFileStamp = { ...stamp };
    this.persistedEventCount = this.eventCount;
    try {
      fs.mkdirSync(this.rootDir, { recursive: true });
      const temporary = `${this.indexFile}.${process.pid}.${randomUUID()}.tmp`;
      try {
        fs.writeFileSync(temporary, `${JSON.stringify(snapshot)}\n`, 'utf8');
        try {
          fs.renameSync(temporary, this.indexFile);
        } catch (error) {
          // Windows does not replace an existing destination with rename.
          fs.rmSync(this.indexFile, { force: true });
          fs.renameSync(temporary, this.indexFile);
        }
      } finally {
        try { fs.rmSync(temporary, { force: true }); } catch { /* best effort */ }
      }
    } catch (error) {
      // The event log is durable without this optimization. A failed sidecar
      // write is observable and causes a controlled rebuild on next restart.
      console.error(`[runtime-kernel] session event index write failed: ${this.indexFile}`, error);
    }
  }

  private async persistOffsetIndex(): Promise<void> {
    if (this.pending.length > 0 || this.offsetIndex.lastSeq !== this.eventCount) return;
    const stamp = this.fileStampSync();
    if (stamp.byteLength !== this.nextByteOffset) {
      this.persistedFileStamp = undefined;
      return;
    }
    const payload = { ...this.offsetIndex.snapshot(stamp), recentEventIds: [...this.recentEventSeqById] };
    const snapshot = { ...payload, checksum: recoveryIndexChecksum(payload) };
    const temporary = `${this.indexFile}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.promises.mkdir(this.rootDir, { recursive: true });
      await fs.promises.writeFile(temporary, `${JSON.stringify(snapshot)}\n`, 'utf8');
      try {
        await fs.promises.rename(temporary, this.indexFile);
      } catch (error) {
        await fs.promises.rm(this.indexFile, { force: true });
        await fs.promises.rename(temporary, this.indexFile);
      }
      // An append can happen while the sidecar is being replaced. In that
      // case the written stamp is intentionally stale and will be ignored.
      if (this.pending.length === 0 && this.eventCount === snapshot.lastSeq) {
        this.persistedFileStamp = { ...stamp };
        this.persistedEventCount = snapshot.lastSeq;
      }
    } catch (error) {
      // The event log remains durable when this optimization cannot be
      // replaced (for example a transient Windows file lock).
      console.error(`[runtime-kernel] session event index write failed: ${this.indexFile}`, error);
    } finally {
      try { await fs.promises.rm(temporary, { force: true }); } catch { /* best effort */ }
    }
  }

  private serializeEvent(event: EventEnvelope): string {
    const serialized = JSON.stringify(event);
    if (typeof serialized !== 'string') throw new Error('Session event envelope is not serializable');
    return serialized;
  }

  private async readPersistedRange(from: number, to: number, limit: number): Promise<EventEnvelope[]> {
    const persistedTo = Math.min(to, this.persistedEventCount);
    if (persistedTo < from) return [];
    const stamp = this.fileStampSync();
    const canSeek = !!this.persistedFileStamp &&
      sameFileStamp(stamp, this.persistedFileStamp) &&
      this.offsetIndex.lastSeq >= this.persistedEventCount;
    const seek = canSeek ? this.offsetIndex.seek(Math.min(from, persistedTo)) : undefined;
    const attempted = await this.scanPersistedRange(
      from,
      persistedTo,
      limit,
      seek?.byteOffset ?? 0,
      seek?.seq ?? 1,
      !!seek
    );
    if (!attempted.invalidIndex) return attempted.events;
    // A malformed or externally replaced sidecar must never change results.
    // Fall back to the existing full scan path and leave the next restart to
    // rebuild the sidecar from the authoritative event stream.
    return (await this.scanPersistedRange(from, persistedTo, limit, 0, 1, false)).events;
  }

  private async scanPersistedRange(
    from: number,
    to: number,
    limit: number,
    byteOffset: number,
    expectedStartSeq: number,
    indexed: boolean
  ): Promise<{ events: EventEnvelope[]; invalidIndex: boolean }> {
    const result: EventEnvelope[] = [];
    let lineNumber = Math.max(0, expectedStartSeq - 1);
    let expectedSeq = expectedStartSeq;
    let firstEvent = true;
    let invalidIndex = false;
    try {
      const stream = fs.createReadStream(this.file, { encoding: 'utf8', start: byteOffset });
      let buffer = '';
      const consume = (line: string): boolean => {
        if (!line.trim()) return false;
        let raw: unknown;
        try { raw = JSON.parse(line); } catch (error) {
          if (indexed) { invalidIndex = true; return true; }
          throw new Error(`Session event log line ${lineNumber + 1} is invalid JSON`);
        }
        const event = this.parseEvent(raw, ++lineNumber);
        if (firstEvent && event.seq !== expectedStartSeq) {
          invalidIndex = true;
          firstEvent = false;
          return true;
        }
        firstEvent = false;
        if (event.seq !== expectedSeq) {
          if (indexed) { invalidIndex = true; return true; }
          throw new Error(`Session event log sequence gap at ${lineNumber}`);
        }
        expectedSeq = event.seq + 1;
        if (event.seq >= from && event.seq <= to) result.push(event);
        return event.seq >= to || result.length >= limit;
      };
      for await (const chunk of stream) {
        buffer += String(chunk);
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';
        let done = false;
        for (const line of lines) {
          if (consume(line)) { done = true; break; }
        }
        if (done) break;
      }
      if (buffer.trim() && result.length < limit) consume(buffer);
      if (indexed && firstEvent) invalidIndex = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { events: result, invalidIndex: false };
      if (indexed && (error instanceof Error && /invalid envelope|invalid JSON|sequence gap/.test(error.message))) {
        return { events: [], invalidIndex: true };
      }
      throw error;
    }
    return { events: result, invalidIndex };
  }

  private rememberEventId(eventId: string, seq: number): void {
    this.recentEventSeqById.set(eventId, seq);
    while (this.recentEventSeqById.size > MAX_RECENT_EVENT_IDS) {
      const oldest = this.recentEventSeqById.keys().next().value;
      if (oldest === undefined) break;
      this.recentEventSeqById.delete(oldest);
    }
  }

  private async flushPending(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    while (true) {
      while (this.pending.length) {
        const batch = this.pending.slice();
        try {
          await fs.promises.mkdir(this.rootDir, { recursive: true });
          await fs.promises.appendFile(this.file, `${batch.map(item => item.serialized).join('\n')}\n`, 'utf8');
          this.persistedEventCount = batch[batch.length - 1].event.seq;
          this.persistedFileStamp = this.fileStampSync();
          this.pending.splice(0, batch.length);
          this.pendingBytes -= batch.reduce((total, item) => total + item.bytes, 0);
        } catch (error) {
          throw error;
        }
      }
      // A synchronous append can arrive while the optional sidecar is being
      // replaced. Loop once more so that append is never left without a
      // write-behind timer while flushPromise is active.
      await this.persistOffsetIndex();
      if (this.pending.length === 0) break;
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer || this.flushPromise) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush('write-behind').catch(error => console.error('[runtime-kernel] session event flush failed:', error));
    }, this.writeBehindMs);
    this.flushTimer.unref?.();
  }

  private validateLimit(limit: number): number {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RANGE_LIMIT) {
      throw new Error(`Session event range limit must be between 1 and ${MAX_RANGE_LIMIT}`);
    }
    return limit;
  }

  private validateEvent(event: EventEnvelope): void {
    if (event.sessionId !== this.sessionId) throw new Error('Session event belongs to another session');
    if (!event.eventId.trim()) throw new Error('Session event id is required');
    if (!event.type.trim()) throw new Error('Session event type is required');
    if (!Number.isInteger(event.schemaVersion) || event.schemaVersion < 1) throw new Error('Session event schema version is invalid');
    if (!Number.isFinite(event.createdAt)) throw new Error('Session event timestamp is invalid');
  }

  private parseEvent(raw: unknown, line: number): EventEnvelope {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`Session event log line ${line} is not an object`);
    const value = raw as Partial<EventEnvelope>;
    if (typeof value.eventId !== 'string' || typeof value.sessionId !== 'string' || typeof value.seq !== 'number' ||
        typeof value.type !== 'string' || typeof value.schemaVersion !== 'number' || typeof value.createdAt !== 'number' ||
        value.sessionId !== this.sessionId) {
      throw new Error(`Session event log line ${line} has invalid envelope`);
    }
    const event = value as EventEnvelope;
    this.validateEvent(event);
    return event;
  }
}
