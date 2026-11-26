import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { writeTextAtomicSync } from '../atomicJson';
import type { ChatMessage, ToolCallRecord } from '../../shared/types';
import { sanitizeRestoredAskQuestions } from '../../shared/orchestratorAskQuestion';
import { cloneOrchestratorForkMessage } from '../../shared/orchestratorFork';
import { withoutDisplayThinking } from '../../shared/thinkingDisplay';
import { STALE_TURN_MS } from '../../shared/chatStaleTurn';
import { safeScopedKey, userDataStorage } from './storageRootResolver';
import { SchedulerSqliteStore, schedulerSqlitePath, type SchedulerSqliteSnapshot } from './schedulerSqlite';
import type { SessionLogFactory } from './sessionManager';

export type SchedulerSessionSnapshot = SchedulerSqliteSnapshot;

export type SchedulerDisplayEdit = {
  upsert?: Array<{ message: ChatMessage; index?: number }>;
  removeIds?: string[];
  moveToTail?: string[];
};

/** Structural commands carry changed messages/IDs, never historical bodies. */
export function applySchedulerDisplayEdit(display: ChatMessage[], edit: SchedulerDisplayEdit): ChatMessage[] {
  const removed = new Set(edit.removeIds ?? []);
  const moved = new Set(edit.moveToTail ?? []);
  let next = removed.size ? display.filter(message => !removed.has(message.id)) : [...display];
  const indexes = new Map(next.map((message, index) => [message.id, index]));
  for (const { message, index } of edit.upsert ?? []) {
    const existing = indexes.get(message.id);
    if (existing !== undefined) next[existing] = message;
    else {
      next.splice(index === undefined ? next.length : Math.max(0, Math.min(index, next.length)), 0, message);
      indexes.clear(); next.forEach((item, slot) => indexes.set(item.id, slot));
    }
  }
  if (moved.size) {
    const byId = new Map(next.filter(message => moved.has(message.id)).map(message => [message.id, message]));
    next = [...next.filter(message => !moved.has(message.id)), ...[...moved].flatMap(id => byId.has(id) ? [byId.get(id)!] : [])];
  }
  return next;
}

function cloneTool(tool: ToolCallRecord): ToolCallRecord {
  return { ...tool, ...(tool.input ? { input: { ...tool.input } } : {}) };
}

function cloneMessage(message: ChatMessage): ChatMessage {
  return {
    ...message,
    ...(message.parts ? { parts: message.parts.map(part => part.kind === 'tool'
      ? { kind: 'tool' as const, toolCall: cloneTool(part.toolCall) }
      : { kind: part.kind, text: part.text }) } : {}),
    ...(message.toolCalls ? { toolCalls: message.toolCalls.map(cloneTool) } : {}),
    ...(message.images ? { images: message.images.map(image => ({ ...image })) } : {}),
    ...(message.displayItems ? { displayItems: message.displayItems.map(item => ({ ...item })) } : {}),
    ...(message.turnChanges ? { turnChanges: structuredClone(message.turnChanges) } : {}),
    ...(message.userQuestion ? { userQuestion: structuredClone(message.userQuestion) } : {})
  };
}

function cloneSnapshot(snapshot: SchedulerSessionSnapshot): SchedulerSessionSnapshot {
  return {
    display: snapshot.display.map(cloneMessage),
    api: structuredClone(snapshot.api),
    ...(snapshot.piSessionFile === undefined ? {} : { piSessionFile: snapshot.piSessionFile }),
    ...(snapshot.fork === undefined ? {} : { fork: structuredClone(snapshot.fork) })
  };
}

function messageMetaKey(message: ChatMessage): string {
  const { parts: _parts, toolCalls: _toolCalls, thinking: _thinking, ...meta } = message;
  return JSON.stringify(meta);
}

function toolShapeKey(tool: ToolCallRecord): string {
  return JSON.stringify({
    id: tool.id,
    name: tool.name,
    status: tool.status,
    argumentsLength: tool.arguments?.length ?? 0,
    resultLength: tool.result?.length ?? 0,
    previewPath: tool.previewPath ?? '',
    patchLength: tool.patch?.length ?? 0
  });
}

function toolListsMatch(a: readonly ToolCallRecord[] | undefined, b: readonly ToolCallRecord[] | undefined): boolean {
  const left = a ?? [], right = b ?? [];
  return left.length === right.length && left.every((tool, index) => toolShapeKey(tool) === toolShapeKey(right[index]!));
}

function applyDelta(message: ChatMessage, token: string, thinking: boolean): void {
  if (thinking) message.thinking = `${message.thinking ?? ''}${token}`;
  else message.content = `${message.content ?? ''}${token}`;
  const kind = thinking ? 'thinking' : 'text';
  const parts = message.parts ??= [];
  const tail = parts.at(-1);
  if ((kind === 'thinking' && tail?.kind === 'thinking') || (kind === 'text' && tail?.kind === 'text')) tail.text += token;
  else parts.push({ kind, text: token });
  delete message.retryHint;
}

function applyTool(message: ChatMessage, toolCall: ToolCallRecord): void {
  const tools = message.toolCalls ??= [];
  const existing = tools.find(tool => tool.id === toolCall.id);
  if (existing) Object.assign(existing, cloneTool(toolCall));
  else tools.push(cloneTool(toolCall));
  const parts = message.parts ??= [];
  const part = parts.find(item => item.kind === 'tool' && item.toolCall.id === toolCall.id);
  if (part?.kind === 'tool') Object.assign(part.toolCall, cloneTool(toolCall));
  else parts.push({ kind: 'tool', toolCall: cloneTool(toolCall) });
}

function isMessageChanged(previous: ChatMessage | undefined, next: ChatMessage): boolean {
  if (!previous) return true;
  if (messageMetaKey(previous) !== messageMetaKey(next)) return true;
  if (!toolListsMatch(previous.toolCalls, next.toolCalls)) return true;
  const previousParts = previous.parts ?? [], nextParts = next.parts ?? [];
  return previousParts.length !== nextParts.length || previousParts.some((part, index) => {
    const other = nextParts[index];
    if (!other || part.kind !== other.kind) return true;
    if (part.kind === 'tool' && other.kind === 'tool') return part.toolCall.id !== other.toolCall.id;
    if (part.kind !== 'tool' && other.kind !== 'tool') return part.text !== other.text;
    return true;
  });
}

function messagePartsChanged(previous: ChatMessage, next: ChatMessage): boolean {
  if (previous.content !== next.content || previous.thinking !== next.thinking) return true;
  const parts = (message: ChatMessage) => message.parts?.length ? message.parts : [
    ...(message.thinking ? [{ kind: 'thinking' as const, text: message.thinking }] : []),
    ...(message.content ? [{ kind: 'text' as const, text: message.content }] : []),
    ...(message.toolCalls ?? []).map(tool => ({ kind: 'tool' as const, toolCall: tool }))
  ];
  const left = parts(previous), right = parts(next);
  if (left.length !== right.length) return true;
  return left.some((part, index) => {
    const other = right[index];
    if (!other || part.kind !== other.kind) return true;
    if (part.kind === 'tool' && other.kind === 'tool') return part.toolCall.id !== other.toolCall.id;
    if (part.kind !== 'tool' && other.kind !== 'tool') return part.text !== other.text;
    return true;
  });
}

function changedToolIds(previous: ChatMessage | undefined, next: ChatMessage): ToolCallRecord[] {
  const oldTools = new Map((previous?.toolCalls ?? []).map(tool => [tool.id, tool]));
  return (next.toolCalls ?? []).filter(tool => {
    const old = oldTools.get(tool.id);
    return !old || toolShapeKey(old) !== toolShapeKey(tool);
  });
}

function schedulerPointerPath(rootDir: string, workspaceId: string): string {
  return userDataStorage(rootDir).scopedPath('workspace', 'scheduler-sessions', workspaceId || 'default', id => `${schedulerSessionId(id)}.active.json`);
}

export function schedulerSessionId(workspaceId: string): string {
  const safe = safeScopedKey(workspaceId || 'default', 80);
  return `workspace-${safe}`;
}

/** A malformed active reference must never silently reopen the pre-fork branch. */
export function resolveSchedulerSessionId(rootDir: string, workspaceId: string): string {
  const base = schedulerSessionId(workspaceId);
  let raw: string;
  let fd: number;
  try { fd = fs.openSync(schedulerPointerPath(rootDir, workspaceId), 'r'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return base; throw error; }
  try {
    const size = fs.fstatSync(fd).size;
    if (size < 1 || size > 1024) throw new Error('Invalid scheduler active session pointer size');
    const bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const count = fs.readSync(fd, bytes, offset, size - offset, offset);
      if (!count) throw new Error('Truncated scheduler active session pointer');
      offset += count;
    }
    raw = bytes.toString('utf8');
  } finally { fs.closeSync(fd); }
  const pointer = JSON.parse(raw) as { version?: number; workspaceId?: string; sessionId?: string };
  if (pointer.version !== 1 || pointer.workspaceId !== workspaceId || typeof pointer.sessionId !== 'string' ||
      !pointer.sessionId.startsWith(`${base}-fork-`) || !/^[a-zA-Z0-9_-]+$/.test(pointer.sessionId)) {
    throw new Error('Invalid scheduler active session pointer');
  }
  if (!fs.existsSync(schedulerSqlitePath(rootDir, pointer.sessionId))) throw new Error('Scheduler active session database is missing');
  return pointer.sessionId;
}

/** Scheduler-facing current-state adapter. SQLite is the sole durable display store. */
export class SchedulerSessionAdapter {
  readonly sessionId: string;
  private readonly store: SchedulerSqliteStore;
  private state: SchedulerSessionSnapshot;
  private readonly loadedFromStore: boolean;
  private forkSourceRevisionValue: number;

  constructor(private readonly rootDir: string, private readonly workspaceId: string, initial: SchedulerSessionSnapshot, _factory?: SessionLogFactory, forkSessionId?: string) {
    this.sessionId = forkSessionId ?? resolveSchedulerSessionId(rootDir, workspaceId);
    this.store = new SchedulerSqliteStore(rootDir, this.sessionId);
    this.loadedFromStore = this.store.hasData;
    if (this.loadedFromStore) this.state = this.store.snapshot();
    else {
      this.state = cloneSnapshot(initial);
      if (initial.display.length || initial.api.length || initial.piSessionFile) {
        this.store.writeMessages(this.state.display, this.state.api, this.state.piSessionFile, this.state.fork);
      }
    }
    this.archiveExpired();
    this.state = this.store.snapshot();
    this.forkSourceRevisionValue = this.store.revision;
  }

  get revision(): number { return this.store.revision; }
  get forkSourceRevision(): number { return this.forkSourceRevisionValue; }
  get hasPersistedEvents(): boolean { return this.loadedFromStore; }
  hasMessage(id: string): boolean { return this.state.display.some(message => message.id === id); }

  private archiveExpired(): void {
    const result = this.store.archiveExpired(Date.now() - STALE_TURN_MS);
    if (result.ids.length) this.state = this.store.snapshot();
  }

  private replaceState(next: SchedulerSessionSnapshot, forkSource = true): void {
    this.state = cloneSnapshot(next);
    this.store.writeMessages(this.state.display, this.state.api, this.state.piSessionFile, this.state.fork);
    if (forkSource) this.forkSourceRevisionValue = this.store.revision;
    this.archiveExpired();
  }

  async prepareFork(messages: Iterable<ChatMessage>, piSessionFile: string, uptoMessageId?: string): Promise<SchedulerSessionAdapter> {
    await this.flush('fork-parent');
    const id = `${schedulerSessionId(this.workspaceId)}-fork-${randomUUID()}`;
    let child: SchedulerSessionAdapter | undefined;
    try {
      child = new SchedulerSessionAdapter(this.rootDir, this.workspaceId, { display: [], api: [] }, undefined, id);
      let count = 0;
      let lastId = '';
      for (const message of messages) {
        child.recordMessage(cloneOrchestratorForkMessage(message), false);
        lastId = message.id;
        if (++count % 256 === 0) await child.flush('fork-batch');
      }
      child.store.writeFork({ parentSessionId: this.sessionId, atSeq: this.revision, uptoMessageId: uptoMessageId ?? lastId });
      child.persistMetadata([], piSessionFile);
      await child.flush('fork-ready');
      return child;
    } catch (error) {
      if (child) await child.discardFork();
      else fs.rmSync(schedulerSqlitePath(this.rootDir, id), { force: true });
      throw error;
    }
  }

  publishFork(): void {
    if (!this.sessionId.startsWith(`${schedulerSessionId(this.workspaceId)}-fork-`)) throw new Error('Scheduler fork is not publishable');
    writeTextAtomicSync(schedulerPointerPath(this.rootDir, this.workspaceId), JSON.stringify({ version: 1, workspaceId: this.workspaceId, sessionId: this.sessionId }));
  }

  async discardFork(): Promise<void> {
    if (!this.sessionId.startsWith(`${schedulerSessionId(this.workspaceId)}-fork-`)) throw new Error('Cannot discard scheduler parent');
    if (resolveSchedulerSessionId(this.rootDir, this.workspaceId) === this.sessionId) throw new Error('Cannot discard active scheduler fork');
    this.store.close();
    const file = schedulerSqlitePath(this.rootDir, this.sessionId);
    for (const candidate of [file, `${file}-wal`, `${file}-shm`]) fs.rmSync(candidate, { force: true });
  }

  snapshot(): SchedulerSessionSnapshot { return cloneSnapshot(this.state); }

  persist(next: SchedulerSessionSnapshot): void { this.replaceState(next); }

  persistMetadata(api: unknown[], piSessionFile?: string): void {
    if (JSON.stringify(api) === JSON.stringify(this.state.api) && piSessionFile === this.state.piSessionFile) return;
    this.store.writeMetadata(api, piSessionFile);
    this.state.api = structuredClone(api);
    this.state.piSessionFile = piSessionFile;
  }

  recordEdit(edit: SchedulerDisplayEdit, liveThinkingOnly = true): void {
    const normalized: SchedulerDisplayEdit = {
      ...(edit.removeIds ? { removeIds: [...edit.removeIds] } : {}),
      ...(edit.moveToTail ? { moveToTail: [...edit.moveToTail] } : {}),
      ...(edit.upsert ? { upsert: edit.upsert.map(item => ({
        ...item,
        message: cloneMessage(liveThinkingOnly ? withoutDisplayThinking([item.message])[0] : item.message)
      })) } : {})
    };
    this.replaceState({ ...this.state, display: applySchedulerDisplayEdit(this.state.display, normalized) });
  }

  recordMessage(message: ChatMessage, liveThinkingOnly = true, index?: number): void {
    const normalized = cloneMessage(liveThinkingOnly ? withoutDisplayThinking([message])[0] : message);
    const at = this.state.display.findIndex(item => item.id === normalized.id);
    const previous = at >= 0 ? this.state.display[at] : undefined;
    if (previous && !isMessageChanged(previous, normalized)) return;
    if (at < 0) {
      const next = [...this.state.display];
      next.splice(index === undefined ? next.length : Math.max(0, Math.min(index, next.length)), 0, normalized);
      this.state = { ...this.state, display: next };
      this.store.writeMessage(normalized, index);
      this.forkSourceRevisionValue = this.store.revision;
    } else {
      this.state.display[at] = normalized;
      const tools = changedToolIds(previous, normalized);
      const partsChanged = messagePartsChanged(previous!, normalized);
      const forkEligibilityChanged = previous!.local !== normalized.local;
      if (partsChanged) this.store.replaceParts(normalized);
      if (tools.length) for (const tool of tools) this.store.writeTool(normalized, tool);
      if (!partsChanged && !tools.length) this.store.patchMessage(normalized);
      if (partsChanged || tools.length || forkEligibilityChanged) this.forkSourceRevisionValue = this.store.revision;
    }
    this.archiveExpired();
  }

  recordDisplayEvent(channel: string, raw: Record<string, unknown>, liveThinkingOnly: boolean, insertionIndex?: number): void {
    if (channel === 'agent:message') {
      const { workspaceId: _workspaceId, ...message } = raw;
      this.recordMessage(message as unknown as ChatMessage, liveThinkingOnly, insertionIndex);
      return;
    }
    if (channel === 'agent:done' && raw.message) {
      this.recordMessage(raw.message as ChatMessage, liveThinkingOnly);
      return;
    }
    if ((channel === 'agent:token' || channel === 'agent:thinking') && typeof raw.messageId === 'string' && typeof raw.token === 'string') {
      if (channel === 'agent:thinking' && liveThinkingOnly) return;
      const index = this.state.display.findIndex(message => message.id === raw.messageId);
      if (index < 0) throw new Error(`Scheduler event targets unknown message: ${raw.messageId}`);
      const message = this.state.display[index]!;
      const token = raw.token;
      applyDelta(message, token, channel === 'agent:thinking');
      this.store.writeDelta(message, token, channel === 'agent:thinking');
      this.forkSourceRevisionValue = this.store.revision;
      return;
    }
    if (channel === 'agent:tool' && typeof raw.messageId === 'string' && raw.toolCall) {
      const index = this.state.display.findIndex(message => message.id === raw.messageId);
      if (index < 0) throw new Error(`Scheduler event targets unknown message: ${raw.messageId}`);
      const message = this.state.display[index]!;
      const tool = cloneTool(raw.toolCall as ToolCallRecord);
      applyTool(message, tool);
      this.store.writeTool(message, tool);
      this.forkSourceRevisionValue = this.store.revision;
    }
  }

  async flush(_reason: string): Promise<void> {
    this.archiveExpired();
  }

  checkpointSync(): void {
    this.archiveExpired();
  }

  close(): void { this.store.close(); }
}

export function sanitizeRestoredSchedulerMessages(messages: ChatMessage[]): ChatMessage[] {
  const restored = sanitizeRestoredAskQuestions(messages);
  return restored.some(message => message.turnChanges?.state === 'collecting')
    ? restored.map(message => message.turnChanges?.state === 'collecting' ? {
      ...message,
      turnChanges: {
        ...message.turnChanges,
        state: 'error' as const,
        warnings: [...message.turnChanges.warnings, '上次改动采集中断，没有可用的回退快照']
      }
    } : message)
    : restored;
}

export function loadSchedulerSessionSnapshot(rootDir: string, workspaceId: string): SchedulerSessionSnapshot | null {
  const adapter = new SchedulerSessionAdapter(rootDir, workspaceId, { display: [], api: [] });
  try { return adapter.hasPersistedEvents ? adapter.snapshot() : null; }
  finally { adapter.close(); }
}

export function loadSchedulerHistoryRange(rootDir: string, workspaceId: string, before?: number, limit?: number, targetMessageId?: string, _factory?: SessionLogFactory): import('../../shared/chatSurface').ChatHistoryPage {
  const sessionId = resolveSchedulerSessionId(rootDir, workspaceId);
  const file = schedulerSqlitePath(rootDir, sessionId);
  if (!fs.existsSync(file)) return { messages: [], before: 0, total: 0, hasEarlier: false };
  const store = new SchedulerSqliteStore(rootDir, sessionId);
  try {
    store.archiveExpired(Date.now() - STALE_TURN_MS);
    const page = store.page(before, limit, targetMessageId);
    return { ...page, messages: sanitizeRestoredSchedulerMessages(page.messages) };
  } finally { store.close(); }
}

export function loadSchedulerSessionMetadata(rootDir: string, workspaceId: string, _factory?: SessionLogFactory): { piSessionFile?: string } {
  const sessionId = resolveSchedulerSessionId(rootDir, workspaceId);
  const file = schedulerSqlitePath(rootDir, sessionId);
  if (!fs.existsSync(file)) return {};
  const store = new SchedulerSqliteStore(rootDir, sessionId);
  try {
    return store.metadata();
  } finally { store.close(); }
}
