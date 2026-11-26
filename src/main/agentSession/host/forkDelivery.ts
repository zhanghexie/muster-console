import type { HostCore, SessionEntry } from './internal';
import { log, push } from './base';

function writeState(host: HostCore, entry: SessionEntry, state: 'pending' | 'sending' | 'unknown' | 'delivered'): void {
  host.store.savePendingFork(entry.sessionId, { state, seed: entry.forkSeed, transcript: entry.forkTranscriptSource, delivery: 'transcript' });
}

/** Persist before sending so a crash cannot turn an uncertain write into a retry. */
export function startForkDelivery(host: HostCore, entry: SessionEntry): void {
  if (!(entry.forkTranscriptSource || entry.forkTranscript) || entry.forkDeliveryState !== 'pending') return;
  if (entry.clearing || entry.closed) throw new Error('会话正在清空或关闭');
  writeState(host, entry, 'sending');
  entry.forkGuardToken = host.ctx.sessions.get(entry.sessionId)?.runtimeResumeToken;
  entry.forkDeliveryState = 'sending';
}

export function markForkUncertain(host: HostCore, entry: SessionEntry): void {
  if (!(entry.forkTranscriptSource || entry.forkTranscript) || entry.forkDeliveryState !== 'sending') return;
  entry.forkDeliveryState = 'unknown';
  entry.forkGuardToken = undefined;
  if (entry.clearing || entry.closed) return;
  try { writeState(host, entry, 'unknown'); }
  catch (error) {
    // The existing on-disk 'sending' state is also treated as unknown on open.
    entry.forkPendingError = `分叉投递状态无法保存：${(error as Error).message}`;
    log(host, entry, 'error', entry.forkPendingError);
  }
}

/** Only an adapter's explicit pre-submit rejection is safe to retry. */
export function markForkNotSubmitted(host: HostCore, entry: SessionEntry): void {
  if (!(entry.forkTranscriptSource || entry.forkTranscript) || entry.forkDeliveryState !== 'sending') return;
  if (entry.clearing || entry.closed) {
    entry.forkDeliveryState = 'unknown';
    entry.forkGuardToken = undefined;
    return;
  }
  try {
    writeState(host, entry, 'pending');
    entry.forkDeliveryState = 'pending';
    entry.forkGuardToken = undefined;
  } catch (error) {
    entry.forkDeliveryState = 'unknown';
    entry.forkGuardToken = undefined;
    entry.forkPendingError = `分叉投递状态无法保存：${(error as Error).message}`;
    log(host, entry, 'error', entry.forkPendingError);
  }
}

/** A completed turn confirms the transcript was submitted, but not a resume identity. */
export function markForkDelivered(host: HostCore, entry: SessionEntry): void {
  if (!(entry.forkTranscriptSource || entry.forkTranscript) || entry.forkDeliveryState !== 'sending') return;
  const token = host.ctx.sessions.get(entry.sessionId)?.runtimeResumeToken;
  if (entry.forkGuardToken && token !== entry.forkGuardToken) {
    markForkUncertain(host, entry);
    entry.forkPendingError = '分叉投递期间引擎标识与会话记录不一致，请检查原生历史后新建会话';
    log(host, entry, 'error', entry.forkPendingError);
    push(host, { kind: 'error', sessionId: entry.sessionId, message: entry.forkPendingError });
    return;
  }
  try {
    host.store.savePendingFork(entry.sessionId, { state: token ? 'delivered' : 'sending', seed: null, transcript: null,
      ...(token ? { resumeToken: token } : {}) });
  } catch (error) {
    entry.forkDeliveryState = 'unknown';
    entry.forkGuardToken = undefined;
    entry.forkPendingError = `分叉投递结果无法保存：${(error as Error).message}`;
    log(host, entry, 'error', entry.forkPendingError);
    push(host, { kind: 'error', sessionId: entry.sessionId, message: entry.forkPendingError });
    return;
  }
  entry.forkTranscript = null;
  entry.forkTranscriptSource = null;
  try { host.store.removeForkContext(entry.sessionId); }
  catch (error) { log(host,entry,'warn',`分叉上下文正文清理失败：${(error as Error).message}`); }
  entry.forkGuardToken = undefined;
  if (token) {
    entry.forkDeliveryState = undefined;
  } else {
    entry.forkDeliveryState = 'unknown';
    entry.forkPendingError = '分叉上下文已投递，但引擎没有提供可恢复的会话标识；已停止继续发送和压缩，请检查原生历史后新建会话';
    log(host, entry, 'error', entry.forkPendingError);
    push(host, { kind: 'error', sessionId: entry.sessionId, message: entry.forkPendingError });
  }
  // Keep this guard until the session is cleared/deleted. The registry uses a
  // debounced write and can otherwise lose the newly acquired resume token.
  entry.forkResumeGuard = true;
}

/** Write a blocking marker before a later guarded turn can reconnect or send. */
export function startForkGuardTurn(host: HostCore, entry: SessionEntry): void {
  if (!entry.forkResumeGuard) return;
  if (entry.clearing || entry.closed) throw new Error('会话正在清空或关闭');
  try {
    const token = host.ctx.sessions.get(entry.sessionId)?.runtimeResumeToken;
    host.store.savePendingFork(entry.sessionId, { state: 'sending', seed: null, transcript: null,
      ...(token ? { resumeToken: token } : {}) });
    if (!token) throw new Error('引擎未提供可恢复的会话标识');
    entry.forkGuardToken = token;
    entry.forkGuardInFlight = true;
  } catch (error) {
    entry.forkDeliveryState = 'unknown';
    entry.forkPendingError = `分叉会话无法确认恢复标识，未启动本次操作：${(error as Error).message}`;
    throw new Error(entry.forkPendingError);
  }
}

/** A failed, stopped, or disconnected guarded turn cannot safely resume automatically. */
export function markForkGuardUncertain(entry: SessionEntry): void {
  if (!entry.forkGuardInFlight) return;
  entry.forkGuardInFlight = false;
  entry.forkGuardToken = undefined;
  entry.forkDeliveryState = 'unknown';
  entry.forkPendingError = '分叉会话本轮的引擎状态未确认，已停止自动续写；请检查原生历史后新建会话';
}

/** Only a completed turn and a known identity can make the guard resumable. */
export function completeForkGuardTurn(host: HostCore, entry: SessionEntry): void {
  if (!entry.forkGuardInFlight) return;
  try {
    const token = host.ctx.sessions.get(entry.sessionId)?.runtimeResumeToken;
    if (entry.forkGuardToken && token !== entry.forkGuardToken) {
      throw new Error('操作期间引擎标识与会话记录不一致');
    }
    host.store.savePendingFork(entry.sessionId, { state: token ? 'delivered' : 'sending', seed: null, transcript: null,
      ...(token ? { resumeToken: token } : {}) });
    entry.forkGuardInFlight = false;
    entry.forkGuardToken = undefined;
  } catch (error) {
    markForkGuardUncertain(entry);
    entry.forkPendingError = `分叉会话恢复标识无法保存：${(error as Error).message}；请检查本地存储`;
    log(host, entry, 'error', entry.forkPendingError);
    push(host, { kind: 'error', sessionId: entry.sessionId, message: entry.forkPendingError });
  }
}

/** Decide whether an engine identity can be recorded in the session table. */
export function noteForkResumeToken(host: HostCore, entry: SessionEntry, token: string): boolean {
  if (entry.forkDeliveryState === 'unknown' || entry.forkPendingError) return false;
  if (!entry.forkResumeGuard) {
    // During the first transcript delivery, accept the initial identity but
    // never let a later one silently replace it within the same operation.
    if (entry.forkTranscript && entry.forkDeliveryState === 'sending') {
      if (token && (!entry.forkGuardToken || token === entry.forkGuardToken)) {
        entry.forkGuardToken = token;
        return true;
      }
      markForkUncertain(host, entry);
      entry.forkPendingError = '分叉投递期间引擎标识发生变化，无法确认上下文；请检查原生历史后新建会话';
      log(host, entry, 'error', entry.forkPendingError);
      push(host, { kind: 'error', sessionId: entry.sessionId, message: entry.forkPendingError });
      return false;
    }
    return true;
  }
  // A new identity during a guarded operation can mean that an adapter
  // silently started a blank engine session instead of resuming the fork.
  if (entry.forkGuardInFlight) {
    if (token && token === entry.forkGuardToken) return true;
    markForkGuardUncertain(entry);
    entry.forkPendingError = '分叉会话的引擎标识发生变化，无法确认原有上下文，已停止自动续写；请检查原生历史后新建会话';
    log(host, entry, 'error', entry.forkPendingError);
    push(host, { kind: 'error', sessionId: entry.sessionId, message: entry.forkPendingError });
    return false;
  }
  const current = host.ctx.sessions.get(entry.sessionId)?.runtimeResumeToken;
  if (token && token === current) return true;

  // An identity change after settlement has no trustworthy operation to
  // attribute it to. Do not overwrite the registry or treat it as delivered.
  entry.forkDeliveryState = 'unknown';
  entry.forkPendingError = '分叉会话收到无法归属的引擎标识，已停止自动续写；请检查原生历史后新建会话';
  try {
    host.store.savePendingFork(entry.sessionId, { state: 'sending', seed: null, transcript: null,
      ...(current ? { resumeToken: current } : {}) });
  } catch (error) {
    entry.forkPendingError += `；保护记录无法保存：${(error as Error).message}`;
  }
  log(host, entry, 'error', entry.forkPendingError);
  push(host, { kind: 'error', sessionId: entry.sessionId, message: entry.forkPendingError });
  return false;
}
