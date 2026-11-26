import { useMemo, useSyncExternalStore } from 'react';
import { isChatRuntimeId } from '../../../shared/agentRuntimeCapabilities';
import type { ChatSurface, ChatSurfaceSnapshot } from '../../../shared/chatSurface';
import type { GuiChatMessage } from '../../../shared/guiWorker';
import { replayMessage, sessionReplayFrames, type ReplaySession, type SessionReplayHandle,
  type SessionReplayMaterial } from '../../../shared/sessionReplay';
import { t } from '../../../shared/i18n';
import { jumpToSession } from '../sessionJump';

const takes = new Map<string, ReplayTake>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const notify = () => { for (const listener of listeners) listener(); };
const latestRequest = new Map<string, number>();
let nextRequest = 0;

class ReplayTake implements SessionReplayHandle {
  private readonly listeners = new Set<() => void>();
  private timer?: ReturnType<typeof setTimeout>;
  private resolve!: (status: 'finished' | 'stopped') => void;
  private reject!: (error: unknown) => void;
  readonly finished = new Promise<'finished' | 'stopped'>((resolve, reject) => {
    this.resolve = resolve;
    this.reject = reject;
  });
  private busy = false;
  constructor(readonly target: string, readonly key: number, private rows: GuiChatMessage[]) {}
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private notify() { for (const listener of this.listeners) listener(); }

  stop = () => {
    clearTimeout(this.timer);
    this.resolve('stopped');
    if (takes.get(this.target) === this) { takes.delete(this.target); notify(); }
  };

  play(material: SessionReplayMaterial, speed: number) {
    const frames = sessionReplayFrames(material);
    let frame = frames.next();
    let due = performance.now() + (frame.done ? 0 : frame.value.delay / speed);
    const tick = () => {
      try {
        const now = performance.now();
        if (!frame.done && due <= now) {
          const rows = this.rows.slice();
          do {
            const { message, append, busy } = frame.value;
            if (append) rows.push(message);
            else rows[rows.length - 1] = message;
            this.busy = busy;
            frame = frames.next();
            if (!frame.done) due += frame.value.delay / speed;
          } while (!frame.done && due <= now);
          this.rows = rows;
        }
        if (frame.done) {
          this.busy = false;
          this.resolve('finished');
        } else {
          this.timer = setTimeout(tick, Math.min(2_147_483_647, Math.max(1, due - performance.now())));
        }
        this.notify();
      } catch (error) {
        this.reject(error);
        this.stop();
      }
    };
    tick();
  }

  bind(live: ChatSurface): ChatSurface {
    const { status, mode, preset } = live.getSnapshot();
    let cached: ChatSurfaceSnapshot;
    return {
      sessionId: this.target,
      caps: { ...live.caps, draftKey: 'session-replay:' + this.target, notes: false, fork: false, bgTasks: false },
      subscribe: this.subscribe,
      getSnapshot: () => {
        if (cached?.messages !== this.rows || cached.busy !== this.busy) {
          cached = { messages: this.rows, busy: this.busy, queuedCount: 0, queuedItems: [], status, mode, preset };
        }
        return cached;
      },
      actions: { send: async () => false, stop: this.stop, clear: async () => this.stop(), retry() {}, cancelQueued() {} }
    };
  }
}

/** Only switching takes rerenders the pane. Individual frames notify the transcript directly. */
export function useSessionReplay(live: ChatSurface) {
  const take = useSyncExternalStore(subscribe, () => takes.get(live.sessionId));
  const surface = useMemo(() => take?.bind(live) ?? live, [take, live]);
  return { surface, replayKey: take?.key };
}

export const replaySession: ReplaySession = async (source, targetSessionId, options) => {
  const request = ++nextRequest;
  const speed = options?.speed ?? 1;
  if (!Number.isFinite(speed) || speed <= 0) throw new Error(t('回放速度必须是正数'));
  const { sessions, activeId } = await window.api.sessions.list();
  const target = targetSessionId ?? (typeof source === 'string' ? source : activeId);
  const session = sessions.find(item => item.id === target);
  if (!session || !isChatRuntimeId(session.runtime ?? '')) throw new Error(t('请选择一个 GUI 聊天会话'));
  const id = session.id;
  function assertCurrent() {
    if ((latestRequest.get(id) ?? 0) > request) throw new Error(t('回放已被新请求替换'));
  }
  assertCurrent();
  latestRequest.set(id, request);
  const input = typeof source === 'string' || source === undefined
    ? await window.api.agentSession.replayMaterial(source ?? id) : source;
  assertCurrent();
  const material: SessionReplayMaterial = Array.isArray(input) ? { version: 1, messages: input } : input;
  if (material?.version !== 1 || !material.messages?.length) throw new Error(t('会话没有可回放的消息'));
  const messages = material.messages.map(replayMessage);
  const selected = new Set(messages.map(message => message.id));
  if (selected.size !== messages.length) throw new Error(t('回放素材包含重复的消息编号'));
  if (material.tracks !== undefined && (!Array.isArray(material.tracks) ||
      material.tracks.some(track => !track || typeof track.messageId !== 'string' || !Array.isArray(track.steps))))
    throw new Error(t('回放素材的分片记录无效'));
  const tracks = structuredClone(material.tracks?.filter(track => selected.has(track.messageId)));
  const history = source === undefined || source === id ? []
    : (await window.api.agentSession.replayMaterial(id, [...selected])).messages;
  assertCurrent();
  if (id !== activeId) {
    const { activeWorkspaceId } = await window.api.workspaces.list();
    assertCurrent();
    const result = await jumpToSession({ sessionId: id, workspaceId: session.workspaceId, activeWorkspaceId,
      switchWorkspace: workspaceId => window.api.workspaces.switch(workspaceId) });
    if (!result.ok) throw new Error(result.message || t('无法打开回放会话'));
  }
  assertCurrent();
  const previous = takes.get(id);
  const take = new ReplayTake(id, request, history);
  takes.set(id, take);
  previous?.stop();
  take.play({ version: 1, messages, tracks }, speed);
  notify();
  return { finished: take.finished, stop: take.stop };
};
