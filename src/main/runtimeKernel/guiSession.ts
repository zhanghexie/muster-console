import {summarizeGuiInjection} from './guiMetadataRangeIndex';
import {GuiMetadataProjectionIndex} from './guiMetadataProjectionIndex';
import type {GuiInjectionDetailRef,GuiMetadataKind} from '../../shared/guiHistoryMetadata';
import { userDataStorage } from './storageRootResolver';
import { createHash, randomUUID } from 'node:crypto';
import type { GuiChatMessage, GuiCompactionRecord, GuiInjectionSnapshot, GuiMessagePart } from '../../shared/guiWorker';
import type { GuiLastUsage } from '../../shared/guiContextUsage';
import { withoutDisplayThinking } from '../../shared/thinkingDisplay';
import type { EventEnvelope } from './contracts';
import { ProjectionManager } from './projectionManager';
import { SessionEventLog } from './sessionEventLog';
import type { SessionLogFactory, SessionLogHandle } from './sessionManager';
import { resolveChatHistoryWindow } from '../../shared/chatHistory';
import { guiReplayMaterial } from './guiReplayMaterial';

export type GuiSessionProjection = {
  messages: GuiChatMessage[];
  lastUsage: GuiLastUsage | null;
  injections: GuiInjectionSnapshot[];
  compactions: GuiCompactionRecord[];
};

export type GuiSessionCheckpoint = {
  version: 1;
  lastAppliedSeq: number;
  lastEventId: string;
  checksum: string;
};

export function guiProjectionChecksum(value: GuiSessionProjection): string {
  return createHash('sha256').update(JSON.stringify({ messages: value.messages, lastUsage: value.lastUsage,
    injections: value.injections, compactions: value.compactions })).digest('hex');
}

type GuiSessionEvent =
  | { kind: 'snapshot'; snapshot: GuiSessionProjection }
  | { kind: 'messages'; upsert: GuiChatMessage[]; metadata: Pick<GuiSessionProjection,'lastUsage'> & Partial<Pick<GuiSessionProjection,'injections'|'compactions'>> }
  | { kind:'injection'; snapshot:GuiInjectionSnapshot }
  | { kind:'compaction'; index:number; record:GuiCompactionRecord }
  | { kind: 'delta'; messageId: string; deltaKind: 'text' | 'thinking'; delta: string }
  | { kind: 'tool'; messageId: string; part: Extract<GuiMessagePart, { kind: 'tool' }> }
  | {
      kind: 'patch';
      upsert: GuiChatMessage[];
      removeIds: string[];
      order: string[];
      lastUsage?: GuiLastUsage | null;
      injections?: GuiInjectionSnapshot[];
      compactions?: GuiCompactionRecord[];
    };

function clone<T>(value: T): T {
  return structuredClone(value);
}

function cloneProjection(value: GuiSessionProjection): GuiSessionProjection {
  return clone(value);
}

function applyEvent(
  projection: GuiSessionProjection,
  event: EventEnvelope<GuiSessionEvent>,
  indexes: Map<string, number>
): GuiSessionProjection {
  if (!event.type.startsWith('gui-session.')) return projection;
  const payload = event.payload;
  if (payload.kind === 'snapshot') {
    const next = cloneProjection(payload.snapshot);
    indexes.clear(); next.messages.forEach((message, index) => indexes.set(message.id, index));
    return next;
  }
  if(payload.kind==='injection'){projection.injections.push(clone(payload.snapshot));return projection;}
  if(payload.kind==='compaction'){
    if(!Number.isSafeInteger(payload.index)||payload.index<0||payload.index>projection.compactions.length)throw new Error('Invalid GUI compaction ordinal');
    projection.compactions[payload.index]=clone(payload.record);return projection;
  }
  if (payload.kind === 'messages') {
    for (const message of payload.upsert) {
      const index = indexes.get(message.id);
      if (index !== undefined) projection.messages[index] = clone(message);
      else { indexes.set(message.id, projection.messages.length); projection.messages.push(clone(message)); }
    }
    projection.lastUsage = clone(payload.metadata.lastUsage);
    if(payload.metadata.injections!==undefined)projection.injections = clone(payload.metadata.injections);
    if(payload.metadata.compactions!==undefined)projection.compactions = clone(payload.metadata.compactions);
    return projection;
  }
  if (payload.kind === 'delta' || payload.kind === 'tool') {
    const index = indexes.get(payload.messageId);
    if (index === undefined) throw new Error(`GUI event targets unknown message: ${payload.messageId}`);
    const message = projection.messages[index];
    if (payload.kind === 'delta') {
      const last = message.parts.at(-1);
      if (last?.kind === payload.deltaKind) last.text += payload.delta;
      else message.parts.push({ kind: payload.deltaKind, text: payload.delta });
    } else {
      const at = message.parts.findIndex(part => part.kind === 'tool' && part.tool.id === payload.part.tool.id);
      if (at < 0) message.parts.push(clone(payload.part));
      else message.parts[at] = clone(payload.part);
    }
    return projection;
  }
  const byId = new Map(projection.messages.map(message => [message.id, message]));
  for (const id of payload.removeIds) byId.delete(id);
  for (const message of payload.upsert) byId.set(message.id, clone(message));
  const next = {
    messages: payload.order.map(id => byId.get(id)).filter((message): message is GuiChatMessage => !!message),
    lastUsage: payload.lastUsage !== undefined ? clone(payload.lastUsage) : projection.lastUsage,
    injections: payload.injections ? clone(payload.injections) : projection.injections,
    compactions: payload.compactions ? clone(payload.compactions) : projection.compactions
  };
  indexes.clear(); next.messages.forEach((message, index) => indexes.set(message.id, index));
  return next;
}

function normalizeProjection(value: GuiSessionProjection, liveThinkingOnly: boolean): GuiSessionProjection {
  return cloneProjection({
    messages: liveThinkingOnly ? withoutDisplayThinking(value.messages) : value.messages,
    lastUsage: value.lastUsage,
    injections: value.injections,
    compactions: value.compactions
  });
}

/** Incremental GUI session projection backed by an append-only event log. */
export class GuiSessionEventAdapter {
  readonly sessionId: string;
  private readonly log: SessionLogHandle;
  private readonly projections = new ProjectionManager();
  private state: GuiSessionProjection;
  private metadataIndex:GuiMetadataProjectionIndex;
  private seeded: boolean;
  private lastEventId = '';
  private checkpointSeq = 0;
  private readonly indexes = new Map<string, number>();

  constructor(
    rootDir: string,
    sessionId: string,
    initial: GuiSessionProjection,
    private readonly liveThinkingOnly: () => boolean,
    options: { preferInitial?: boolean; checkpoint?: GuiSessionCheckpoint; factory?: SessionLogFactory } = {}
  ) {
    this.sessionId = sessionId;
    this.log = options.factory?.openSync('gui', sessionId) ?? new SessionEventLog(userDataStorage(rootDir).resolve('app', 'agent-session-events'), sessionId);
    this.projections.register<GuiSessionProjection>({
      id: 'gui-session',
      initial: { messages: [], lastUsage: null, injections: [], compactions: [] },
      apply: (projection, event) => applyEvent(projection, event as EventEnvelope<GuiSessionEvent>, this.indexes)
    });
    // Open the writer through its bounded sidecar path, never request a full
    // consumer replay when a checkpoint can establish the projection prefix.
    this.log.loadSync();
    let fromSeq = 1;
    const checkpoint = options.checkpoint;
    if (checkpoint && !options.preferInitial) {
      try {
        if (checkpoint.version !== 1 || !Number.isSafeInteger(checkpoint.lastAppliedSeq) || checkpoint.lastAppliedSeq < 1 ||
            checkpoint.checksum !== guiProjectionChecksum(initial)) throw new Error('Invalid GUI checkpoint checksum or sequence');
        const anchor = this.log.readRangeSync({ fromSeq: checkpoint.lastAppliedSeq, toSeq: checkpoint.lastAppliedSeq, limit: 1 })[0];
        if (!anchor || anchor.eventId !== checkpoint.lastEventId) throw new Error('GUI checkpoint does not match event log');
        const value = cloneProjection(initial);
        this.projections.checkpoint('gui-session', { value, lastAppliedSeq: checkpoint.lastAppliedSeq });
        value.messages.forEach((message, index) => this.indexes.set(message.id, index));
        this.lastEventId = checkpoint.lastEventId;
        fromSeq = checkpoint.lastAppliedSeq + 1;
        this.checkpointSeq = checkpoint.lastAppliedSeq;
      } catch (error) {
        console.warn('[gui-session] rebuilding unavailable checkpoint:', sessionId, String(error));
      }
    }
    let hasPersistedEvents = fromSeq > 1;
    for (;;) {
      const batch = this.log.readRangeSync({ fromSeq, limit: 512 });
      if (!batch.length) break;
      for (const event of batch) {
        hasPersistedEvents = true;
        this.projections.apply(event as EventEnvelope<GuiSessionEvent>);
        this.lastEventId = event.eventId;
      }
      fromSeq = batch[batch.length - 1].seq + 1;
    }
    // An explicitly newer external JSON edit must be seeded before the next
    // incremental event. A host-written checkpoint never takes this path.
    this.seeded = hasPersistedEvents && !options.preferInitial;
    this.state = hasPersistedEvents && !options.preferInitial
      ? this.projections.snapshot<GuiSessionProjection>('gui-session').value
      : cloneProjection(initial);
    this.metadataIndex=new GuiMetadataProjectionIndex(this.state.injections,this.state.compactions);
  }

  get revision():number{return this.projections.snapshot('gui-session').lastAppliedSeq;}

  replayMaterial(beforeMessageIds?: readonly string[]) {
    return guiReplayMaterial(this.state.messages, this.revision, query => this.log.readRange(query), beforeMessageIds);
  }

  get needsRecoveryCheckpoint(): boolean {
    return this.seeded && this.projections.snapshot('gui-session').lastAppliedSeq > this.checkpointSeq;
  }

  checkpoint(): GuiSessionCheckpoint | undefined {
    const lastAppliedSeq = this.projections.snapshot<GuiSessionProjection>('gui-session').lastAppliedSeq;
    if (!this.seeded || !lastAppliedSeq || !this.lastEventId) return undefined;
    return { version: 1, lastAppliedSeq, lastEventId: this.lastEventId, checksum: guiProjectionChecksum(this.state) };
  }

  snapshot(): GuiSessionProjection {
    return cloneProjection(this.state);
  }

  metadataSnapshot(): Omit<GuiSessionProjection, 'messages'> {
    return clone({ lastUsage: this.state.lastUsage, injections: this.state.injections, compactions: this.state.compactions });
  }

  /** Changed records only; transcript replacements use persist explicitly. */
  persistChanges(messages: readonly GuiChatMessage[], metadata: Pick<GuiSessionProjection,'lastUsage'>): void {
    if (!this.seeded) {
      this.enqueue({ kind: 'snapshot', snapshot: normalizeProjection(this.state, this.liveThinkingOnly()) });
      this.seeded = true;
    }
    const upsert = this.liveThinkingOnly() ? withoutDisplayThinking([...messages]) : [...messages];
    this.enqueue({ kind: 'messages', upsert: clone(upsert), metadata: clone({
      lastUsage: metadata.lastUsage
    }) });
  }

  recordInjection(snapshot:GuiInjectionSnapshot){
    const ordinal=this.state.injections.length,summary=summarizeGuiInjection(snapshot);
    this.ensureMetadataSeed();this.enqueue({kind:'injection',snapshot:clone(snapshot)});
    return this.metadataIndex.appendInjection(ordinal,summary);
  }
  recordCompaction(index:number,record:GuiCompactionRecord):void{
    if(!Number.isFinite(record.at))throw new Error('Invalid GUI compaction time');
    if(!Number.isSafeInteger(index)||index<0||index>this.state.compactions.length)throw new Error('Invalid GUI compaction ordinal');
    this.ensureMetadataSeed();this.enqueue({kind:'compaction',index,record:clone(record)});
    this.metadataIndex.upsertCompaction(index,record);
  }
  private ensureMetadataSeed():void{
    if(this.seeded)return;
    this.enqueue({kind:'snapshot',snapshot:normalizeProjection(this.state,this.liveThinkingOnly())});this.seeded=true;
  }

  recordDelta(messageId: string, deltaKind: 'text' | 'thinking', delta: string): void {
    if (!delta || (deltaKind === 'thinking' && this.liveThinkingOnly())) return;
    this.ensureMessageSeed(messageId);
    this.enqueue({ kind: 'delta', messageId, deltaKind, delta });
  }

  recordToolPart(messageId: string, part: Extract<GuiMessagePart, { kind: 'tool' }>): void {
    this.ensureMessageSeed(messageId);
    this.enqueue({ kind: 'tool', messageId, part: clone(part) });
  }

  private ensureMessageSeed(messageId: string): void {
    if (this.seeded) return;
    if (!this.state.messages.some(message => message.id === messageId)) throw new Error(`GUI event targets unknown message: ${messageId}`);
    this.enqueue({ kind: 'snapshot', snapshot: normalizeProjection(this.state, this.liveThinkingOnly()) });
    this.seeded = true;
  }

  readRangeSnapshot(before?:number,limit=120,targetMessageId?:string){
    const page=this.readMessagesRange(before,limit,targetMessageId),metadata=this.metadataIndex.window(page.messages.map(message=>message.ts));
    return{...page,lastUsage:clone(this.state.lastUsage),injections:metadata.injections,compactions:metadata.compactions,
      metadataStatus:{injectionCount:metadata.injectionCount,compactionCount:metadata.compactionCount,compactionsOverflow:metadata.compactionsOverflow}};
  }
  readInjectionDetails(reference:GuiInjectionDetailRef):GuiInjectionSnapshot|null{
    const ordinal=this.metadataIndex.detailOrdinal(reference);return ordinal===undefined?null:clone(this.state.injections[ordinal]);
  }
  readMetadataWindow(timestamps:readonly number[]){return this.metadataIndex.window(timestamps);}
  readMetadataTimeline(kind:GuiMetadataKind,before?:number,limit=120){return this.metadataIndex.timeline(kind,before,limit);}
  usageSnapshot():GuiLastUsage|null{return clone(this.state.lastUsage);}

  /** Read a bounded message range without exposing the full projection to IPC. */
  readMessagesRange(before?: number, limit = 120, targetMessageId?: string): { messages: GuiChatMessage[]; before: number; total: number; hasEarlier: boolean } {
    const all = this.state.messages;
    const { start, end } = resolveChatHistoryWindow(all, before, limit, targetMessageId);
    return { messages: clone(all.slice(start, end)), before: start, total: all.length, hasEarlier: start > 0 };
  }

  get hasUnflushedWrites(): boolean {
    return this.log.hasPendingWrites;
  }

  persist(next: GuiSessionProjection): void {
    const normalized = normalizeProjection(next, this.liveThinkingOnly());
    this.enqueue({ kind: 'snapshot', snapshot: normalized });
    this.metadataIndex=new GuiMetadataProjectionIndex(this.state.injections,this.state.compactions);
    this.seeded = true;
  }

  async persistAndFlush(next: GuiSessionProjection, reason: string): Promise<void> {
    this.persist(next);
    await this.flush(reason);
  }

  async flush(reason: string): Promise<void> {
    await this.log.flush(reason);
  }

  flushSync(): void {
    this.log.flushSync();
  }

  deleteSync(): void {
    this.log.deleteSync();
  }

  private enqueue(payload: GuiSessionEvent): void {
    const messageId = 'messageId' in payload ? payload.messageId : payload.kind === 'messages' && payload.upsert.length === 1 ? payload.upsert[0].id : undefined;
    if ('messageId' in payload && !this.indexes.has(payload.messageId)) throw new Error(`GUI event targets unknown message: ${payload.messageId}`);
    const event: EventEnvelope<GuiSessionEvent> = {
      eventId: randomUUID(),
      sessionId: this.sessionId,
      seq: 0,
      type: `gui-session.${payload.kind}`,
      schemaVersion: 1,
      createdAt: Date.now(),
      payload,
      ...(messageId ? { causationId: payload.kind === 'tool' ? payload.part.tool.id : messageId, correlationId: `${this.sessionId}:${messageId}` } : {})
    };
    const result = this.log.appendSync(event);
    this.projections.apply({ ...event, seq: result.seq });
    this.lastEventId = event.eventId;
    this.state = this.projections.snapshot<GuiSessionProjection>('gui-session').value;
  }

}
