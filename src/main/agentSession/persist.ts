import {writeGuiMetadataRangeIndex,readGuiMetadataWindow,readGuiMetadataTimeline,readGuiInjectionDetails,guiMetadataRangeIndexPath} from '../runtimeKernel/guiMetadataRangeIndex';
import type {GuiInjectionSummary,GuiInjectionDetailRef,GuiMetadataKind,GuiHistoryMetadataStatus} from '../../shared/guiHistoryMetadata';
import { userDataStorage, type StoragePurpose } from '../runtimeKernel/storageRootResolver';
import {createForkContextSpool,readForkContextSpool,removeForkContextSpool,validateForkContextSpool,type ForkContextSpool} from './forkContextSpool';
import {writeGuiForkPrefix} from '../runtimeKernel/guiForkPrefix';
import {loadNativeForkPoint,saveNativeForkPoint,removeNativeForkPoints} from './nativeForkPoints';
/**
 * GUI 会话聊天记录持久化：userData/agent-sessions/<sessionId>.json（主进程读写）。
 * v1（text/thinking/tools 扁平字段）在 load 时迁移成 v2 parts；写盘恒为 v2。
 * lastUsage：会话最后已知上下文用量（重启恢复；fork 占位与 refresh 不写）。
 *
 * 热路径走 runtime-kernel 的 GUI session event log：一个回合里 tool-call /
 * tool-result / turn-end 只追加变化事件，避免长历史每次 persist 都 stringify +
 * rename 整份 JSON。旧 JSON 保留为初始化/检查点文件，退出时由 event log flush 收口。
 */
import { clearModelRequests, migrateModelRequests } from './modelRequestStore';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  GuiChatMessage,
  GuiCompactionRecord,
  GuiInjectionSnapshot
} from '../../shared/guiWorker';
import type { GuiMessagePart } from '../../shared/guiWorker';
import {
  migrateGuiChatMessage,
  parseCompactionRecords,
  parseInjectionSnapshots
} from '../../shared/guiWorker';
import type { GuiLastUsage } from '../../shared/guiContextUsage';
import { parseLastUsage } from '../../shared/guiContextUsage';
import { t } from '../../shared/i18n';
import { PersistQueue } from '../persistQueue';
import { writeTextAtomicSync } from '../atomicJson';
import type { GuiNativeForkPoint, GuiSeedMessage } from './types';
import { GuiSessionEventAdapter, guiProjectionChecksum, type GuiSessionCheckpoint, type GuiSessionProjection } from '../runtimeKernel/guiSession';
import { messageRangeIndexPath, readMessageRangeIndex, writeMessageRangeIndex, writeMessageRangeIndexFromJson, readMessageCheckpointProperty } from '../runtimeKernel/messageRangeIndex';
import type { SessionLogFactory } from '../runtimeKernel/sessionManager';

export interface PendingGuiFork {
  state: 'preparing' | 'pending' | 'sending' | 'unknown' | 'delivered' | 'clearing';
  seed: ForkContextSpool | null;
  transcript: ForkContextSpool | null;
  delivery?: 'seed' | 'transcript';
  /** Durable identity for a delivered transcript, before the session table catches up. */
  resumeToken?: string;
}

export interface GuiHostIntroDelivery {
  /** Worker routing starts a fresh native conversation for each replacement attempt. */
  attempt: number;
  delivered: boolean;
}

/** 会话文件名即 randomUUID；清扫只认标准 uuid 形状（36 位含连字符），其余文件一律不碰 */
const SESSION_FILE_UUID_RE = /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(?:\.trace)?\.json(?:\.ranges|\.timeline)?$/;
const SESSION_EVENT_FILE_UUID_RE = /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.ndjson(?:\.index\.json)?$/;

interface PersistedSession {
  checkpoint?: GuiSessionCheckpoint;
  messages?: GuiChatMessage[];
  lastUsage?: unknown;
  injections?: unknown;
  compactions?: unknown;
}

export interface GuiSessionSnapshot {
  messages: GuiChatMessage[];
  lastUsage: GuiLastUsage | null;
  injections: GuiInjectionSnapshot[];
  compactions: GuiCompactionRecord[];
}

export type GuiSessionRangeSnapshot = Omit<GuiSessionSnapshot,'injections'> & {injections:GuiInjectionSummary[];metadataStatus:GuiHistoryMetadataStatus;before:number;total:number;hasEarlier:boolean};
type GuiRangeMetadata={guiMetadataVersion:1;lastUsage:GuiLastUsage|null};

function restoreMessages(raw: PersistedSession | null): GuiChatMessage[] {
  if (!raw || !Array.isArray(raw.messages)) return [];
  // parts 缺失 = v1 扁平历史：迁移（thinking → tools → text 的旧渲染顺序）
  return raw.messages.map((m) =>
    Array.isArray((m as { parts?: unknown }).parts)
      ? m
      : migrateGuiChatMessage(m as unknown as Parameters<typeof migrateGuiChatMessage>[0])
  );
}

import { clearAttachments, attachmentDir } from '../attachments/service';
import { withAttachmentReadAccess } from '../attachments/access';
import type { WorkspaceExecutionContext } from '../../shared/workspaceExecutionContext';

export class GuiSessionStore {
  withAttachmentReadAccess(sessionId: string, context: WorkspaceExecutionContext | undefined): WorkspaceExecutionContext | undefined {
    return withAttachmentReadAccess(context, path.dirname(this.dir), sessionId);
  }
  private dir: string;
  private forkDir: string;
  private forkContextDir:string;
  private forkPointsDir: string;
  private engineInputDir: string;
  private eventRoot: string;
  private queue: PersistQueue;
  private eventAdapters = new Map<string, GuiSessionEventAdapter>();
  private liveSessionIds = new Set<string>();
  private releasingSessionIds = new Set<string>();
  private readonly touchedClearMarkers = new Set<string>();
  private readonly forkPreparationIds=new Set<string>();

  constructor(userDataDir: string, private readonly liveThinkingOnly: () => boolean = () => true,
    private readonly startupLiveIds: ReadonlySet<string> = new Set(), private readonly sessionFactory?: SessionLogFactory) {
    this.dir = userDataStorage(userDataDir).resolve('app', 'agent-sessions');
    this.forkDir = userDataStorage(userDataDir).resolve('app', 'agent-fork-pending');
    this.forkContextDir=userDataStorage(userDataDir).resolve('app', 'agent-fork-context');
    this.forkPointsDir = userDataStorage(userDataDir).resolve('app', 'agent-fork-points');
    this.engineInputDir = userDataStorage(userDataDir).resolve('app', 'agent-inputs');
    this.eventRoot = userDataDir;
    try { migrateModelRequests(userDataDir); }
    catch (error) { console.warn('[model-requests] archive migration failed', error); }
    fs.mkdirSync(this.dir, { recursive: true });
    this.queue = new PersistQueue(this.dir, { compact: true, resolveFile: file => this.scopedLeaf('agent-sessions', file, id => id) });
  }

  private scopedLeaf(purpose: StoragePurpose, sessionId: string, keyForId: (id: string) => string = id => this.fileName(id)): string {
    return userDataStorage(this.eventRoot).scopedPath('session', purpose, sessionId, keyForId);
  }

  private engineInputPath(sessionId: string, messageId?: string): string {
    if (!/^[a-zA-Z0-9_-]{1,160}$/.test(sessionId) ||
        (messageId !== undefined && !/^[a-zA-Z0-9_-]{1,160}$/.test(messageId))) {
      throw new Error('Invalid GUI input identity');
    }
    const directory = this.scopedLeaf('agent-inputs', sessionId, id => id);
    return messageId === undefined ? directory : path.join(directory, messageId);
  }

  saveEngineInput(sessionId: string, messageId: string, text: string): string {
    const ref = randomUUID();
    // A retry publishes a new ref; a checkpoint still pointing at the earlier
    // attempt remains readable if the app exits before the new ref is saved.
    writeTextAtomicSync(path.join(this.engineInputPath(sessionId, messageId), `${ref}.json`), JSON.stringify(text), { mode: 0o600 });
    return ref;
  }

  async readEngineInput(sessionId: string, messageId: string, ref: string): Promise<string | null> {
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(ref)) return null;
    try {
      const file = path.join(this.engineInputPath(sessionId, messageId), `${ref}.json`);
      const text: unknown = JSON.parse(await fs.promises.readFile(file, 'utf8'));
      return typeof text === 'string' ? text : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  removeEngineInput(sessionId: string, messageId: string): void {
    fs.rmSync(this.engineInputPath(sessionId, messageId), { recursive: true, force: true });
  }

  loadHostIntroDelivery(sessionId: string): GuiHostIntroDelivery | null {
    const file = path.join(this.engineInputPath(sessionId), 'host-intro.json');
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (raw && typeof raw === 'object' && 'attempt' in raw && typeof raw.attempt === 'number' &&
          Number.isSafeInteger(raw.attempt) && raw.attempt >= 0 && 'delivered' in raw && typeof raw.delivered === 'boolean') {
        return { attempt: raw.attempt, delivered: raw.delivered };
      }
      throw new Error('Invalid GUI host intro delivery record');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  saveHostIntroDelivery(sessionId: string, delivery: GuiHostIntroDelivery): void {
    const file = path.join(this.engineInputPath(sessionId), 'host-intro.json');
    writeTextAtomicSync(file, JSON.stringify(delivery), { mode: 0o600 });
  }

  private clearEngineInputs(sessionId: string): void {
    clearModelRequests(this.eventRoot, sessionId);
    fs.rmSync(this.engineInputPath(sessionId), { recursive: true, force: true });
  }

  /** sessionId 是宿主 randomUUID，但仍做一层 basename 防注入 */
  private fileName(sessionId: string): string {
    return `${path.basename(sessionId).replace(/[^a-zA-Z0-9_-]/g, '_')}.json`;
  }

  /** Separate, host-owned sidecar; it does not change the history JSON format. */
  beginForkPreparation(sessionId:string):void{
    if(!/^[a-zA-Z0-9_-]{1,160}$/.test(sessionId))throw new Error('Invalid GUI fork target');
    const pending=this.scopedLeaf('agent-fork-pending', sessionId);
    const targets=[pending,this.scopedLeaf('agent-sessions', sessionId),messageRangeIndexPath(this.scopedLeaf('agent-sessions',sessionId)),guiMetadataRangeIndexPath(this.scopedLeaf('agent-sessions',sessionId)),this.eventFile(sessionId),
      this.scopedLeaf('agent-fork-context', sessionId, id => `${id}.seeds.ndjson`),this.scopedLeaf('agent-fork-points', sessionId, id => id),this.engineInputPath(sessionId),attachmentDir(this.eventRoot,`gui:${sessionId}`)];
    if(targets.some(file=>fs.existsSync(file)))throw new Error('GUI fork target already exists');
    fs.mkdirSync(this.forkDir,{recursive:true});
    fs.writeFileSync(pending,JSON.stringify({version:2,state:'preparing',seed:null,transcript:null}),{flag:'wx',mode:0o600});
    this.forkPreparationIds.add(sessionId);
  }
  finishForkPreparation(sessionId:string):void{this.forkPreparationIds.delete(sessionId);}
  savePendingFork(sessionId:string,fork:PendingGuiFork):void{
    const text=JSON.stringify({version:2,...fork});if(Buffer.byteLength(text)>65536)throw new Error('Fork marker exceeds metadata budget');
    writeTextAtomicSync(this.scopedLeaf('agent-fork-pending', sessionId),text,{mode:0o600});
    if(fork.state==='clearing')this.touchedClearMarkers.add(sessionId);
  }
  loadPendingFork(sessionId:string):PendingGuiFork|null{
    const file=this.scopedLeaf('agent-fork-pending', sessionId);let fd:number;
    try{fd=fs.openSync(file,'r');}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
    try{
      const size=fs.fstatSync(fd).size;if(size<1||size>65536)throw new Error('待投递的分叉上下文格式损坏');
      const bytes=Buffer.alloc(size);let offset=0;while(offset<size){const n=fs.readSync(fd,bytes,offset,size-offset,offset);if(!n)throw new Error('待投递的分叉上下文无法读取');offset+=n;}
      const value=JSON.parse(bytes.toString('utf8')) as PendingGuiFork&{version:number};
      if(value.version!==2||!['preparing','pending','sending','unknown','delivered','clearing'].includes(value.state)||
        !(value.resumeToken===undefined||typeof value.resumeToken==='string'&&!!value.resumeToken)||
        !(value.delivery===undefined||value.delivery==='seed'||value.delivery==='transcript')||
        !(value.seed===null||value.seed&&typeof value.seed==='object'&&!Array.isArray(value.seed))||
        !(value.transcript===null||value.transcript&&typeof value.transcript==='object'&&!Array.isArray(value.transcript)))throw new Error('待投递的分叉上下文格式损坏');
      if(value.seed&&value.transcript||value.seed&&value.delivery!=='seed'||value.transcript&&value.delivery!=='transcript'||value.state==='delivered'&&(value.seed||value.transcript))throw new Error('待投递的分叉上下文格式损坏');
      if(value.seed)validateForkContextSpool(this.forkContextDir,sessionId,value.seed);
      if(value.transcript)validateForkContextSpool(this.forkContextDir,sessionId,value.transcript);
      return value;
    }finally{fs.closeSync(fd);}
  }
  clearPendingFork(sessionId:string):void{
    try{fs.unlinkSync(this.scopedLeaf('agent-fork-pending', sessionId));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    removeForkContextSpool(this.forkContextDir,sessionId);
  }
  createForkContext(sessionId:string,seeds:Iterable<GuiSeedMessage>):ForkContextSpool{return createForkContextSpool(this.forkContextDir,sessionId,seeds);}
  forkSeedSource(sessionId:string,descriptor:ForkContextSpool){validateForkContextSpool(this.forkContextDir,sessionId,descriptor);return{directory:this.forkContextDir,descriptor};}
  readForkTranscript(sessionId:string,descriptor:ForkContextSpool,maxCharacters:number):string{
    let body='',first=true;
    for(const seed of readForkContextSpool(this.forkContextDir,sessionId,descriptor)){
      const next=(first?'':'\n\n')+`【${seed.role==='user'?'用户':'助手'}】${seed.text}`;first=false;
      if(body.length<=maxCharacters)body+=next.slice(0,maxCharacters+1-body.length);
    }
    return '[本会话 fork 自另一会话，以下是先前的对话记录，仅作上下文参考]\n'+(body.length>maxCharacters?body.slice(0,maxCharacters)+'\n…（过长已截断）':body);
  }
  removeForkContext(sessionId:string):void{removeForkContextSpool(this.forkContextDir,sessionId);}
  loadForkPoint(sessionId:string,messageId:string):GuiNativeForkPoint|undefined{return loadNativeForkPoint(this.forkPointsDir,sessionId,messageId);}
  saveForkPoint(sessionId:string,messageId:string,point:GuiNativeForkPoint):void{saveNativeForkPoint(this.forkPointsDir,sessionId,messageId,point);}
  clearForkPoints(sessionId:string):void{removeNativeForkPoints(this.forkPointsDir,sessionId);}
  forkReadVersion(sessionId:string):string{
    const fileStamp=(file:string)=>{try{const s=fs.statSync(file);return[s.size,s.mtimeMs,s.ctimeMs];}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}};
    return JSON.stringify({projection:this.eventAdapters.get(sessionId)?.revision,checkpoint:fileStamp(this.scopedLeaf('agent-sessions', sessionId)),events:fileStamp(this.eventFile(sessionId))});
  }
  async saveForkPrefix(sessionId:string,messages:Iterable<GuiChatMessage>,assertCurrent:()=>void):Promise<void>{
    await writeGuiForkPrefix(this.eventRoot,sessionId,messages,{factory:this.sessionFactory,liveThinkingOnly:this.liveThinkingOnly(),assertCurrent});
  }

  /** Commit a fresh complete history snapshot before publishing its fork guard. */
  saveSnapshotStrict(sessionId: string, snapshot: () => GuiSessionSnapshot, commit: () => void): Promise<void> {
    return Promise.resolve()
      .then(() => this.eventAdapter(sessionId))
      .then(adapter => adapter.persistAndFlush(snapshot(), 'strict').then(() => ({ adapter })))
      .then(({ adapter }) => {
        this.queue.drop(this.fileName(sessionId));
        this.writeSnapshotSync(sessionId, adapter);
        commit();
      });
  }

  private readRaw(sessionId: string): PersistedSession | null {
    const file = this.fileName(sessionId);
    const absolute = this.scopedLeaf('agent-sessions', file, id => id);
    try {
      return JSON.parse(fs.readFileSync(absolute, 'utf8')) as PersistedSession;
    } catch (e) {
      // 文件不存在是正常新会话；损坏静默回空会让历史「无声消失」，必须留诊断线索
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`[agent-session] ${file} 解析失败，历史按空处理:`, (e as Error).message);
      }
      return null;
    }
  }

  private legacySnapshot(sessionId: string, raw: PersistedSession | null = this.readRaw(sessionId)): GuiSessionProjection {
    return {
      messages: restoreMessages(raw),
      lastUsage: parseLastUsage(raw?.lastUsage),
      injections: parseInjectionSnapshots(raw?.injections),
      compactions: parseCompactionRecords(raw?.compactions)
    };
  }

  private eventAdapter(sessionId: string, initial?: GuiSessionProjection): GuiSessionEventAdapter {
    const existing = this.eventAdapters.get(sessionId);
    if (existing) return existing;
    const adapter = this.createEventAdapter(sessionId, initial);
    this.eventAdapters.set(sessionId, adapter);
    return adapter;
  }

  private freshEventAdapter(sessionId: string): GuiSessionEventAdapter {
    return this.createEventAdapter(sessionId);
  }

  private createEventAdapter(sessionId: string, initial?: GuiSessionProjection): GuiSessionEventAdapter {
    const raw = initial ? null : this.readRaw(sessionId);
    const checkpoint = raw?.checkpoint;
    // Verify the exact saved projection before any legacy parsing can normalize
    // metadata or change property order. Recovery sanitation remains the Host's
    // persisted message change, not a reason to reject our own checkpoint.
    const saved = raw && Array.isArray(raw.messages) ? { messages: raw.messages,
      lastUsage: (raw.lastUsage ?? null) as GuiLastUsage | null,
      injections: (raw.injections ?? []) as GuiInjectionSnapshot[],
      compactions: (raw.compactions ?? []) as GuiCompactionRecord[] } : undefined;
    const intact = checkpoint && saved && checkpoint.checksum === guiProjectionChecksum(saved);
    const projection = initial ?? (intact ? saved : this.legacySnapshot(sessionId, raw));
    const external = !initial && !intact && this.prefersLegacyCheckpoint(sessionId);
    if (checkpoint && !intact) console.warn(external
      ? '[agent-session] checkpoint checksum changed; using newer external JSON as seed'
      : '[agent-session] checkpoint checksum invalid; rebuilding from event log', sessionId);
    const adapter = new GuiSessionEventAdapter(this.eventRoot, sessionId, projection, this.liveThinkingOnly, {
      preferInitial: initial !== undefined || external,
      ...(intact ? { checkpoint } : {}), factory: this.sessionFactory
    });
    // A missing/invalid checkpoint or a replayed suffix is rebuilt once. Normal
    // cold opens reuse it; unseeded external JSON remains explicit until saved.
    if (adapter.needsRecoveryCheckpoint && !adapter.hasUnflushedWrites) this.writeSnapshotSync(sessionId, adapter);
    return adapter;
  }

  private prefersLegacyCheckpoint(sessionId: string): boolean {
    try {
      const legacy = fs.statSync(this.scopedLeaf('agent-sessions', sessionId));
      const events = fs.statSync(this.eventFile(sessionId));
      return legacy.mtimeMs > events.mtimeMs;
    } catch {
      return false;
    }
  }

  /** Keep the hot projection only while a GUI host entry is open. */
  retain(sessionId: string, initial?: GuiSessionProjection): void {
    this.liveSessionIds.add(sessionId);
    this.eventAdapter(sessionId, initial);
  }

  /** Drain and evict a closed session's projection so cold sessions do not pin history in memory. */
  async release(sessionId: string): Promise<void> {
    this.releasingSessionIds.add(sessionId);
    try {
      this.liveSessionIds.delete(sessionId);
      const adapter = this.eventAdapters.get(sessionId);
      if (!adapter) return;
      await adapter.flush('release');
      if (this.eventAdapters.get(sessionId) !== adapter || this.liveSessionIds.has(sessionId)) return;
      this.queue.drop(this.fileName(sessionId));
      this.writeSnapshotSync(sessionId, adapter);
      this.eventAdapters.delete(sessionId);
      await this.sessionFactory?.release(sessionId, 'gui');
    } finally {
      this.releasingSessionIds.delete(sessionId);
    }
  }

  private eventFile(sessionId: string): string {
    return this.scopedLeaf('agent-session-events', sessionId, id => `${id}.ndjson`);
  }

  /**
   * A released session has a compact JSON checkpoint written after its event
   * log is flushed. Prefer that checkpoint for bounded cold reads so opening
   * one older page does not replay the entire event stream. If the event log
   * is newer (or the checkpoint is unavailable), return null and let the
   * event-backed adapter remain the authoritative fallback.
   */
  private readLegacyMessageRange(
    sessionId: string,
    before?: number,
    limit = 120,
    targetMessageId?: string
  ): GuiSessionRangeSnapshot | null {
    const checkpoint = this.scopedLeaf('agent-sessions', sessionId);
    let checkpointStat: fs.Stats;
    try {
      checkpointStat = fs.statSync(checkpoint);
    } catch {
      return null;
    }
    try {
      const eventStat = fs.statSync(this.eventFile(sessionId));
      if (checkpointStat.mtimeMs <= eventStat.mtimeMs) return null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null;
    }
    const text = fs.readFileSync(checkpoint, 'utf8');
    const events = this.eventFile(sessionId);
    const metadata = {
      guiMetadataVersion: 1 as const,
      lastUsage: parseLastUsage(readMessageCheckpointProperty(text, 'lastUsage'))
    } satisfies GuiRangeMetadata;
    // A missing range sidecar is a repair operation. Scan only root-level
    // message objects for IDs and let the validated range reader materialize
    // the requested page. This avoids restoring every message into memory.
    writeGuiMetadataRangeIndex(checkpoint, events, text);
    writeMessageRangeIndexFromJson(checkpoint, events, text, metadata);
    const indexed = readMessageRangeIndex<GuiChatMessage, GuiRangeMetadata>(checkpoint, events, before, limit, targetMessageId);
    if (!indexed) throw new Error('GUI message range index rebuild failed');
    const window = readGuiMetadataWindow(checkpoint, events, indexed.messages.map(message => message.ts));
    if (!window) throw new Error('GUI metadata index rebuild failed');
    return {
      lastUsage: parseLastUsage(indexed.metadata.lastUsage),
      messages: restoreMessages({ messages: indexed.messages }),
      before: indexed.before,
      total: indexed.total,
      hasEarlier: indexed.hasEarlier,
      injections: window.injections,
      compactions: window.compactions,
      metadataStatus: {
        injectionCount: window.injectionCount,
        compactionCount: window.compactionCount,
        compactionsOverflow: window.compactionsOverflow
      }
    };
  }

  load(sessionId: string): GuiChatMessage[] {
    return this.loadSnapshot(sessionId).messages;
  }

  /** Read-only strict history: missing is empty, malformed or unreadable is an error. */
  async loadStrictMessages(sessionId: string): Promise<GuiChatMessage[] | null> {
    if (fs.existsSync(this.eventFile(sessionId))) return this.loadSnapshot(sessionId).messages;
    let text: string;
    try { text = await fs.promises.readFile(this.scopedLeaf('agent-sessions', sessionId), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    const raw: unknown = JSON.parse(text);
    if (!raw || typeof raw !== 'object' || !Array.isArray((raw as PersistedSession).messages)) throw new Error(t('会话历史格式无效'));
    return restoreMessages(raw as PersistedSession);
  }

  /** Retention must not treat read failures as an empty transcript. */
  async loadForReviewRetention(sessionId: string): Promise<GuiChatMessage[] | null> {
    return this.loadStrictMessages(sessionId);
  }

  /** 恢复同一信封的全部字段只读/解析一次；冷会话每次调用重新读盘，热会话复用 live projection。 */
  loadSnapshot(sessionId: string): GuiSessionSnapshot {
    const cached = this.eventAdapters.get(sessionId);
    if (this.liveSessionIds.has(sessionId)) return this.eventAdapter(sessionId).snapshot();
    return (cached?.hasUnflushedWrites ? cached : this.freshEventAdapter(sessionId)).snapshot();
  }

  replayMaterial(sessionId: string, beforeMessageIds?: readonly string[]) {
    const adapter = this.eventAdapters.get(sessionId) ?? this.freshEventAdapter(sessionId);
    return adapter.replayMaterial(beforeMessageIds);
  }

  /** Bounded cold-read path for range IPC. The adapter owns event replay and projection state. */
  loadMessageRange(sessionId: string, before?: number, limit = 120, targetMessageId?: string): {
    messages: GuiChatMessage[];
    before: number;
    total: number;
    hasEarlier: boolean;
  } {
    return this.loadRangeSnapshot(sessionId, before, limit, targetMessageId);
  }

  loadRangeSnapshot(sessionId: string, before?: number, limit = 120, targetMessageId?: string): GuiSessionRangeSnapshot {
    let needsMetadataRepair=false;
    const cached = this.eventAdapters.get(sessionId);
    if (!this.liveSessionIds.has(sessionId) && !cached?.hasUnflushedWrites) {
      const checkpoint=this.scopedLeaf('agent-sessions',sessionId),events=this.eventFile(sessionId);
      const indexed=readMessageRangeIndex<GuiChatMessage,GuiRangeMetadata>(checkpoint,events,before,limit,targetMessageId);
      if(indexed?.metadata.guiMetadataVersion===1){
        const messages=restoreMessages(indexed),window=readGuiMetadataWindow(checkpoint,events,messages.map(message=>message.ts));
        if(window)return{before:indexed.before,total:indexed.total,hasEarlier:indexed.hasEarlier,messages,lastUsage:parseLastUsage(indexed.metadata.lastUsage),
          injections:window.injections,compactions:window.compactions,metadataStatus:{injectionCount:window.injectionCount,compactionCount:window.compactionCount,compactionsOverflow:window.compactionsOverflow}};
        needsMetadataRepair=true;
      }
      const checkpointRange = this.readLegacyMessageRange(sessionId, before, limit, targetMessageId);
      if (checkpointRange) return checkpointRange;
    }
    const adapter = this.liveSessionIds.has(sessionId)
      ? this.eventAdapter(sessionId)
      : (cached?.hasUnflushedWrites ? cached : this.freshEventAdapter(sessionId));
    if (!this.liveSessionIds.has(sessionId) && !adapter.hasUnflushedWrites) {
      // Recovery may already have rebuilt the checkpoint and its index. A
      // trusted, unchanged checkpoint can still have a missing/stale range
      // sidecar (including equal filesystem mtimes); rebuild that once too.
      const recoveredIndex = readMessageRangeIndex<GuiChatMessage, GuiRangeMetadata>(
        this.scopedLeaf('agent-sessions', sessionId), this.eventFile(sessionId), before, limit, targetMessageId);
      if (needsMetadataRepair||recoveredIndex?.metadata.guiMetadataVersion!==1) this.writeSnapshotSync(sessionId, adapter);
    }
    return adapter.readRangeSnapshot(before, limit, targetMessageId);
  }

  /** 重启恢复用的最后已知上下文用量；损坏/缺省为 null */
  loadLastUsage(sessionId: string): GuiLastUsage | null {
    return this.loadSnapshot(sessionId).lastUsage;
  }

  /** Harness 透明·注入快照信封（宽松解析；旧会话/无字段为空数组） */
  loadInjections(sessionId: string): GuiInjectionSnapshot[] {
    return this.loadSnapshot(sessionId).injections;
  }

  /** Harness 透明·压缩记录信封（宽松解析；旧会话/无字段为空数组） */
  loadCompactions(sessionId: string): GuiCompactionRecord[] {
    return this.loadSnapshot(sessionId).compactions;
  }

  /**
   * 写消息。lastUsage / injections：
   * - 传入值：覆盖（injections 传空数组=清空信封）
   * - 省略：保留盘上已有值（只改消息时不丢用量/信封）
   */
  save(
    sessionId: string,
    messages: GuiChatMessage[],
    lastUsage?: GuiLastUsage | null,
    injections?: GuiInjectionSnapshot[],
    compactions?: GuiCompactionRecord[],
    changedOnly = false
  ): void {
    const live = this.liveSessionIds.has(sessionId);
    const cached = this.eventAdapters.get(sessionId);
    if (!live && cached && !cached.hasUnflushedWrites) this.eventAdapters.delete(sessionId);
    const adapter = live
      ? this.eventAdapter(sessionId)
      : cached?.hasUnflushedWrites
        ? cached
        : this.freshEventAdapter(sessionId);
    if(changedOnly)adapter.persistChanges(messages,{lastUsage:lastUsage===undefined?adapter.usageSnapshot():lastUsage});
    else{
      const current=adapter.metadataSnapshot();
      adapter.persist({messages,lastUsage:lastUsage===undefined?current.lastUsage:lastUsage,
        injections:injections===undefined?current.injections:injections,compactions:compactions===undefined?current.compactions:compactions});
    }
    // Keep one compact JSON checkpoint for existing inspection/retention paths.
    // Subsequent hot-path writes are event-only, so long sessions no longer
    // stringify and rename the complete transcript on every persist call.
    if (!live) {
      adapter.flushSync();
      this.queue.drop(this.fileName(sessionId));
      this.writeSnapshotSync(sessionId, adapter);
      if (this.eventAdapters.get(sessionId) === adapter) this.eventAdapters.delete(sessionId);
    }
  }

  recordInjection(sessionId:string,snapshot:GuiInjectionSnapshot){return this.eventAdapter(sessionId).recordInjection(snapshot);}
  recordCompaction(sessionId:string,index:number,record:GuiCompactionRecord):void{this.eventAdapter(sessionId).recordCompaction(index,record);}
  metadataForMessages(sessionId:string,messages:readonly GuiChatMessage[]){
    const adapter=this.eventAdapters.get(sessionId);if(!adapter)throw new Error('GUI execution metadata is not materialized');
    const window=adapter.readMetadataWindow(messages.map(message=>message.ts));
    return{injections:window.injections,compactions:window.compactions,metadataStatus:{injectionCount:window.injectionCount,compactionCount:window.compactionCount,compactionsOverflow:window.compactionsOverflow}};
  }
  injectionDetails(sessionId:string,reference:GuiInjectionDetailRef):GuiInjectionSnapshot|null{
    const adapter=this.eventAdapters.get(sessionId);
    if(this.liveSessionIds.has(sessionId)||adapter?.hasUnflushedWrites)return this.eventAdapter(sessionId).readInjectionDetails(reference);
    const checkpoint=this.scopedLeaf('agent-sessions',sessionId),events=this.eventFile(sessionId);
    let detail=readGuiInjectionDetails(checkpoint,events,reference);if(detail.status==='ok')return detail.snapshot;if(detail.status==='missing')return null;
    this.loadRangeSnapshot(sessionId,undefined,1);detail=readGuiInjectionDetails(checkpoint,events,reference);return detail.status==='ok'?detail.snapshot:null;
  }
  metadataTimeline(sessionId:string,kind:GuiMetadataKind,before?:number,limit=120){
    if(kind!=='injections'&&kind!=='compactions')throw new Error('Invalid GUI metadata kind');
    if(before!==undefined&&!Number.isSafeInteger(before))throw new Error('Invalid GUI metadata cursor');
    const adapter=this.eventAdapters.get(sessionId);
    if(this.liveSessionIds.has(sessionId)||adapter?.hasUnflushedWrites)return this.eventAdapter(sessionId).readMetadataTimeline(kind,before,limit);
    const checkpoint=this.scopedLeaf('agent-sessions',sessionId),events=this.eventFile(sessionId);
    let page=readGuiMetadataTimeline(checkpoint,events,kind,before,limit);if(page)return page;
    this.loadRangeSnapshot(sessionId,undefined,1);page=readGuiMetadataTimeline(checkpoint,events,kind,before,limit);return page;
  }

  recordDelta(sessionId: string, messageId: string, kind: 'text' | 'thinking', delta: string): void {
    this.eventAdapter(sessionId).recordDelta(messageId, kind, delta);
  }

  recordToolPart(sessionId: string, messageId: string, part: Extract<GuiMessagePart, { kind: 'tool' }>): void {
    this.eventAdapter(sessionId).recordToolPart(messageId, part);
  }



  /**
   * 旧账本文件清理（pi-trajectory-plan v3 B3' 退役；不存在即无操作）。
   * 后缀 '.trace' + '.json' 拼接构造（账本命名的清理残留，非账本逻辑）。
   */
  private deleteLegacyTraceFile(sessionId: string): void {
    const name = `${this.fileName(sessionId).replace(/\.json$/, '')}${['.trace', '.json'].join('')}`;
    this.queue.drop(name);
    try {
      const file = this.scopedLeaf('agent-sessions', name, id => id);
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch {
      /* ignore */
    }
  }

  flushSync(): void {
    this.queue.flushSync();
    for (const [sessionId, adapter] of this.eventAdapters) {
      adapter.flushSync();
      this.writeSnapshotSync(sessionId, adapter);
      if (!this.liveSessionIds.has(sessionId)) this.eventAdapters.delete(sessionId);
    }
  }

  async flush(): Promise<void> {
    await Promise.all([...this.eventAdapters.values()].map(adapter => adapter.flush('store')));
    await this.queue.flush();
    for (const sessionId of this.eventAdapters.keys()) {
      if (!this.liveSessionIds.has(sessionId)) this.eventAdapters.delete(sessionId);
    }
  }

  private writeSnapshotSync(sessionId: string, adapter: GuiSessionEventAdapter): void {
    const snapshot = adapter.snapshot();
    const value = { ...this.snapshotValue(snapshot), checkpoint: adapter.checkpoint() };
    const text = JSON.stringify(value);
    writeTextAtomicSync(this.scopedLeaf('agent-sessions', sessionId), text);
    const { messages, ...metadata } = snapshot;
    this.writeRangeIndex(sessionId, text, messages, metadata);
  }

  private writeRangeIndex(sessionId: string, text: string, messages: readonly GuiChatMessage[], metadata: Omit<GuiSessionSnapshot, 'messages'>): void {
    try {
      const checkpoint=this.scopedLeaf('agent-sessions',sessionId),events=this.eventFile(sessionId);
      writeGuiMetadataRangeIndex(checkpoint,events,text);
      writeMessageRangeIndex(checkpoint,events,text,messages.map(message=>message.id),{guiMetadataVersion:1,lastUsage:metadata.lastUsage} satisfies GuiRangeMetadata);
    }
    catch (error) { console.warn('[agent-session] message range index unavailable; checkpoint retained', sessionId, error); }
  }

  private snapshotValue(snapshot: GuiSessionProjection): PersistedSession & { version: 2 } {
    return {
      version: 2,
      messages: snapshot.messages,
      ...(snapshot.lastUsage ? { lastUsage: snapshot.lastUsage } : {}),
      ...(snapshot.injections.length ? { injections: snapshot.injections } : {}),
      ...(snapshot.compactions.length ? { compactions: snapshot.compactions } : {})
    };
  }

  delete(sessionId: string): void {
    // The session row is removed asynchronously. If clear and delete race,
    // retain its tombstone until a later startup observes the row is gone.
    const errors: string[] = [];
    try {
      if (this.loadPendingFork(sessionId)?.state !== 'clearing') this.clearPendingFork(sessionId);
    } catch (error) {
      errors.push(t('分叉保护记录无法确认，已保留 {{path}}：{{error}}', { path: this.scopedLeaf('agent-fork-pending', sessionId), error: String(error) }));
    }
    try { this.clearForkPoints(sessionId); }
    catch (error) { errors.push(t('分叉索引清理失败：{{error}}', { error: String(error) })); }
    try { this.clearEngineInputs(sessionId); }
    catch (error) { errors.push(t('发送原文清理失败：{{error}}', { error: String(error) })); }
    try { clearAttachments(path.dirname(this.dir), `gui:${sessionId}`); }
    catch (error) { errors.push(t('会话附件清理失败：{{error}}', { error: String(error) })); }
    // 退役前的旧账本文件残留一并清（文件已无人读写，纯磁盘垃圾；见 deleteLegacyTraceFile）
    this.deleteLegacyTraceFile(sessionId);
    const name = this.fileName(sessionId);
    // 先撤掉待写，否则合并窗口内的写会把刚删掉的文件复活
    this.queue.drop(name);
    this.liveSessionIds.delete(sessionId);
    const adapter = this.eventAdapters.get(sessionId);
    this.eventAdapters.delete(sessionId);
    try { adapter?.deleteSync(); }
    catch (error) { errors.push(t('会话事件历史清理失败：{{error}}', { error: String(error) })); }
    if (!adapter) {
      try { fs.unlinkSync(this.eventFile(sessionId)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') errors.push(t('会话事件历史清理失败：{{error}}', { error: String(error) })); }
    }
    try { fs.unlinkSync(`${this.eventFile(sessionId)}.index.json`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') errors.push(String(error)); }
    try { fs.unlinkSync(this.scopedLeaf('agent-sessions', name, id => id)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') errors.push(t('会话历史清理失败：{{error}}', { error: String(error) }));
    }
    try { fs.unlinkSync(guiMetadataRangeIndexPath(this.scopedLeaf('agent-sessions',sessionId))); }
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')errors.push(String(error));}
    try { fs.unlinkSync(messageRangeIndexPath(this.scopedLeaf('agent-sessions', name, id => id))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') errors.push(String(error)); }
    if (errors.length) throw new Error(errors.join(t('；')));
  }

  /** Delete GUI data after all older history writes settle, retaining the clear tombstone. */
  clearDataStrict(sessionId: string, validate: () => void): Promise<void> {
    const name = this.fileName(sessionId);
    const adapter = this.eventAdapters.get(sessionId);
    return (adapter ? adapter.flush('clear') : Promise.resolve()).then(() => this.queue.runStrict(name, () => {
      validate();
      this.clearForkPoints(sessionId);
      this.clearEngineInputs(sessionId);
      clearAttachments(path.dirname(this.dir), `gui:${sessionId}`);
      this.deleteLegacyTraceFile(sessionId);
      try { fs.unlinkSync(this.scopedLeaf('agent-sessions', name, id => id)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      try { fs.unlinkSync(messageRangeIndexPath(this.scopedLeaf('agent-sessions', name, id => id))); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      this.eventAdapters.delete(sessionId);
      if (adapter) adapter.deleteSync();
      else {
        try { fs.unlinkSync(this.eventFile(sessionId)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
    }));
  }

  /**
   * 启动孤儿清扫：删无对应会话的历史、分叉保护及截点文件（只动 uuid 命名的文件）。
   * X2-F05：被删 id 的会话附件目录（conversation-attachments/&lt;hash(gui:id)&gt;）一并清
   * （与 delete() 同一入口语义），否则孤儿附件（可含视频帧等大文件）永久无主滞留。
   * turn-changes/gui: 记录属 turn-checkpoint 清理面（已另案），此处不捎带。
   */
  sweepOrphans(liveIds: ReadonlySet<string>): number {
    let removed = 0;
    const clearedIds = new Set<string>();
    const eventDir = userDataStorage(this.eventRoot).resolve('app', 'agent-session-events');
    for (const dir of [this.dir, this.forkDir, this.forkPointsDir, eventDir]) {
      let names: string[];
      try {
        names = fs.readdirSync(dir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
          console.warn('[agent-session] 无法读取孤儿清扫目录', dir, error);
        continue;
      }
      for (const name of names) {
        const m = (dir === eventDir ? SESSION_EVENT_FILE_UUID_RE : SESSION_FILE_UUID_RE).exec(name);
        if (!m || liveIds.has(m[1]) || (dir !== this.dir && name.includes('.trace.'))) continue;
        if (this.releasingSessionIds.has(m[1])||this.forkPreparationIds.has(m[1])) continue;
        if (dir === this.forkDir) {
          // An unreadable record might be a clear tombstone: never guess.
          // A session removed since startup may still exist in sessions.json.
          try {
            if (this.loadPendingFork(m[1])?.state === 'clearing' &&
                (this.startupLiveIds.has(m[1]) || this.touchedClearMarkers.has(m[1]))) continue;
          }
          catch (error) {
            console.warn('[agent-session] 无法确认孤儿保护记录，保留文件', name, error);
            continue;
          }
        }
        try {
          if (dir === this.dir) this.queue.drop(name);
          if (dir === eventDir) {
            // Event logs are cleaned in the same orphan sweep as legacy snapshots.
            const adapter = this.eventAdapters.get(m[1]);
            adapter?.deleteSync();
            this.eventAdapters.delete(m[1]);
            this.liveSessionIds.delete(m[1]);
          }
          fs.rmSync(path.join(dir, name), { force: true });
          removed += 1;
        } catch (error) {
          console.warn('[agent-session] 孤儿文件清理失败', path.join(dir, name), error);
        }
        // 准备事务可能在写历史前崩溃；sidecar 也必须能触发附件清理。
        if (!clearedIds.has(m[1])) {
          clearedIds.add(m[1]);
          try { clearAttachments(path.dirname(this.dir), `gui:${m[1]}`); }
          catch (error) { console.warn('[agent-session] 孤儿附件清理失败', m[1], error); }
        }
      }
    }
    for(const directory of [this.forkContextDir,this.forkPointsDir,this.engineInputDir,this.dir]){
      let names:string[];try{names=fs.readdirSync(directory);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
      for(const name of names){
        const match=directory===this.forkContextDir?/^([0-9a-fA-F-]{36})\.seeds\.ndjson$/.exec(name):directory===this.dir?/^\.([0-9a-fA-F-]{36})\.prefix-/.exec(name):/^([0-9a-fA-F-]{36})$/.exec(name);
        const id=match?.[1];if(!id||liveIds.has(id)||this.forkPreparationIds.has(id)||this.releasingSessionIds.has(id))continue;
        try{
          if(this.loadPendingFork(id)?.state==='clearing'&&(this.startupLiveIds.has(id)||this.touchedClearMarkers.has(id)))continue;
          if(directory===this.forkContextDir)this.removeForkContext(id);
          else if(directory===this.forkPointsDir)this.clearForkPoints(id);
          else if(directory===this.engineInputDir)this.clearEngineInputs(id);
          else{const target=path.resolve(directory,name);if(path.dirname(target)!==path.resolve(directory))throw new Error('Unsafe fork stage cleanup');fs.rmSync(target,{recursive:true,force:true});}
          removed++;
        }catch(error){console.warn('[agent-session] fork orphan cleanup failed',id,error);}
      }
    }
    return removed;
  }
}
