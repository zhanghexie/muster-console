/** Session observation is a projection of host state, never another task/state store. */
import type { GuiChatMessage } from './guiWorker';
import type { ChatMessage, SessionMeta } from './types';
import type { SessionShareEntry } from './runtimeFacts';

export const OBSERVE_REPLY_CHARS = 6000;
export const OBSERVE_TERMINAL_CHARS = 4000;

export function clipObservationText(text: string, max: number, fromEnd = false) {
  const take = (n: number) => fromEnd ? text.slice(text.length - n) : text.slice(0, n);
  let lo = 0, hi = Math.min(text.length, max);
  // Tool results are JSON; escaped output must also fit the common result budget.
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (JSON.stringify(take(mid)).length <= max + 2) lo = mid;
    else hi = mid - 1;
  }
  return { text: take(lo), truncated: lo < text.length, totalChars: text.length };
}

export interface ObservedReply {
  messageId: string;
  text: string;
  status: 'completed' | 'error' | 'aborted' | 'unknown';
  createdAt: number;
  finishedAt: number | null;
  truncated: boolean;
  totalChars: number;
  error?: string;
  retryAttempts?: number;
}

/** Adjacent text parts may be stream chunks; only intervening non-text parts prove a block boundary. */
function observedText(parts: readonly { kind: string; text?: string }[]): string {
  let text = '', separated = false;
  for (const part of parts) {
    if (part.kind !== 'text') { separated = true; continue; }
    if (!part.text) continue;
    if (separated && text) {
      const existing = (text.match(/\n*$/)?.[0].length ?? 0) + (part.text.match(/^\n*/)?.[0].length ?? 0);
      text += '\n'.repeat(Math.max(0, 2 - existing));
    }
    text += part.text;
    separated = false;
  }
  return text;
}

/** Streaming/steered fragments are not completed replies. Legacy history remains explicitly unknown. */
export function observeReply(messages: readonly GuiChatMessage[], activeMessageId?: string): ObservedReply | null {
  let legacy: GuiChatMessage | undefined;
  let settled: GuiChatMessage | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== 'assistant' || m.id === activeMessageId) continue;
    if (typeof m.finishedAt === 'number' && Number.isFinite(m.finishedAt)) { settled = m; break; }
    if (!legacy && (observedText(m.parts).trim() || m.error || m.aborted)) legacy = m;
  }
  const m = settled ?? legacy;
  if (!m) return null;
  return {
    messageId: m.id,
    ...clipObservationText(observedText(m.parts), OBSERVE_REPLY_CHARS),
    status: m.aborted ? 'aborted' : m.error ? 'error' : settled ? 'completed' : 'unknown',
    createdAt: m.ts,
    finishedAt: settled?.finishedAt ?? null,
    ...(m.retryAttempts ? { retryAttempts: m.retryAttempts } : {}),
    ...(m.error ? { error: clipObservationText(m.error, 1000).text } : {})
  };
}

/** The scheduler's existing display format projects into the same reply contract. */
export function observeSchedulerReply(messages: readonly ChatMessage[], activeMessageId?: string) {
  return observeReply(messages.filter(m => !m.local).map(m => {
    const text = m.parts?.some(p => p.kind === 'text') ? observedText(m.parts) : m.content;
    return { id: m.id, role: m.role, ts: m.createdAt, finishedAt: m.finishedAt,
      error: m.error, aborted: m.aborted,
      parts: [{ kind: 'text' as const, text }] };
  }), activeMessageId);
}

export function sessionObservation(s: SessionMeta, share?: SessionShareEntry, busy: boolean | null = null) {
  const note = s.liveStatus?.label?.trim();
  const summary = share?.text?.trim()
    ? { text: clipObservationText(share.text, 500).text, source: 'share' as const, updatedAt: share.updatedAt }
    : note ? { text: clipObservationText(note, 500).text, source: 'note' as const, updatedAt: s.liveStatus!.ts } : null;
  return {
    sessionId: s.id, name: clipObservationText(s.name, 200).text, workspaceId: s.workspaceId ?? null,
    parentSessionId: s.parentSessionId ?? null, runtime: s.runtime ?? null,
    cwd: s.cwd ? clipObservationText(s.cwd, 1000).text : null,
    worktreePath: s.worktreePath ? clipObservationText(s.worktreePath, 1000).text : null,
    worktreeBranch: s.worktreeBranch ?? null, externalSessionId: s.externalSessionId ?? null,
    lastUsedAt: s.lastUsedAt ?? s.createdAt,
    archived: s.archived === true, lifecycle: s.lifecycle ?? null,
    processStatus: s.status ?? null,
    runtimePresence: s.runtimePresence ?? null,
    launchError: typeof s.meta?.launchError === 'string' ? clipObservationText(s.meta.launchError, 1000).text : null,
    activity: s.activity?.kind ?? null, phase: s.phase?.value ?? null, busy,
    summary,
    // lastUsedAt includes UI navigation; observing must not manufacture work activity.
    updatedAt: Math.max(s.createdAt, s.activity?.ts ?? 0, s.liveStatus?.ts ?? 0,
      s.phase?.ts ?? 0, share?.updatedAt ?? 0)
  };
}
