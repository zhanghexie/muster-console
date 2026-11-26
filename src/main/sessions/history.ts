import type { AppContext } from '../context';
import { t } from '../../shared/i18n';
import { clampChatTailN, guiChatTailLine, tailChatLines, type ChatTailLine } from '../../shared/chatTail';

export const readSessionHistory = async (ctx: AppContext, args: { sessionId?: string; n?: number }) => {
    const sid = typeof args?.sessionId === 'string' ? args.sessionId.trim() : '';
    if (!sid) throw new Error(t('缺少 sessionId'));
    const resolved = ctx.sessions.resolveSessionRef({ sessionId: sid });
    const s = ctx.sessions.get(resolved.id);
    if (!s) throw new Error(t('会话不存在: {{id}}', { id: sid }));
    const n = clampChatTailN(args?.n);
    const lines: ChatTailLine[] = [];
    if (ctx.sessions.isChatRuntime(s.runtime)) {
      let before: number | undefined;
      while (ctx.agentSessions && lines.length < n) {
        const page = ctx.agentSessions.getHistoryRange(s.id, before, n);
        if (!page) break;
        for (let i = page.messages.length - 1; i >= 0 && lines.length < n; i--) {
          const m = page.messages[i];
          // Cold pages keep empty shells to preserve absolute renderer ordinals.
          // They do not consume an observation line; failed/aborted turns do.
          if (m.role === 'assistant' && !m.parts.length && !m.error && !m.aborted && !m.plan && !m.turnChanges && !m.userQuestion && !m.approval) continue;
          lines.unshift(guiChatTailLine(m));
        }
        if (!page.hasEarlier) break;
        if (before !== undefined && page.before >= before) throw new Error('Session history range did not advance');
        before = page.before;
      }
    } else {
      const buf = ctx.pty.getBufferTail(s.id, 12_000) ?? '';
      if (buf.trim()) lines.push({ role: 'terminal', text: buf, ts: s.lastUsedAt });
    }
    const messages = tailChatLines(lines, n);
    return {
      sessionId: s.id,
      name: s.name,
      n,
      count: messages.length,
      messages,
      selected: false
    };
  };
