import { sanitizeSuggestedReplies } from './guiWorker';

export interface ComposerReplySuggestions {
  messageId: string;
  replies: string[];
}

export interface ClearReplySuggestionsRequest {
  kind: 'cli' | 'gui' | 'dispatch';
  targetId: string;
  messageId: string;
  replies: string[];
}

export interface ClearReplySuggestionsResult { ok: boolean; cleared?: boolean; error?: string }

/** Only suggestions attached to the most recent conversational turn are actionable. */
export function currentSuggestedReplies(
  messages: readonly unknown[], busy: boolean, surfaceKind: string
): ComposerReplySuggestions | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as {
      id?: string; role?: string; queued?: boolean; error?: unknown; aborted?: boolean;
      suggestedReplies?: unknown; userQuestion?: { status?: string };
    };
    if (!message || message.queued) continue;
    if (message.role === 'user') return null;
    if (message.role !== 'assistant') continue;
    if (!message.id || message.error || message.aborted) return null;
    // Pending question cards may contain suggestions persisted by older versions.
    if (busy || (surfaceKind === 'dispatch' && message.userQuestion?.status === 'pending')) return null;
    const replies = sanitizeSuggestedReplies(message.suggestedReplies);
    return replies.length ? { messageId: message.id, replies } : null;
  }
  return null;
}

/** A late clear request must not remove suggestions that arrived after the click. */
export function sameReplySuggestions(a: ComposerReplySuggestions | null | undefined, b: Pick<ComposerReplySuggestions, 'messageId' | 'replies'>): boolean {
  return !!a && a.messageId === b.messageId && a.replies.length === b.replies.length && a.replies.every((reply, i) => reply === b.replies[i]);
}
