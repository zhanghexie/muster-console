import type { ToolCallRecord } from './types';
import { coerceSourceAgentIdentity, type SourceAgentIdentity } from './subagentCharacters';
import { isHostNotification } from './hostNotification';

export interface ReadMailPresentation {
  key: string; text: string; subject?: string; offset: number; nextOffset?: number | null;
  sender: SourceAgentIdentity;
  hostEvent?: true;
}
export const EVENT_NOTIFICATION_SUBJECT_PREFIX = '事件通知：';

/** Only actual body pages returned by a successful read, never previews or wake notices. */
export function readMailPresentations(calls: readonly ToolCallRecord[]): ReadMailPresentation[] {
  const pages = new Map<string, ReadMailPresentation>();
  for (const call of calls) {
    if (call.status !== 'ok' || !call.result) continue;
    let name = call.name;
    try {
      // Codex records every MCP tool under this outer type; the actual tool
      // name is retained in the input by its stream mapper.
      if (name === 'mcp_tool_call') {
        const input = call.input ?? JSON.parse(call.arguments || '{}');
        name = typeof input.tool === 'string' ? input.tool : '';
      }
      if (/(?:^|[._])tools[._]call$/.test(name)) {
        const args = call.input ?? JSON.parse(call.arguments || '{}');
        name = args.name ?? '';
      }
      if (!/(?:^|[._])sessions[._]readMessages$/.test(name)) continue;
      let data = JSON.parse(call.result);
      for (let depth = 0; depth < 6 && data; depth++) {
        if (data.ok === false || data.isError) break;
        const rows = Array.isArray(data.messages) ? data.messages : typeof data.text === 'string' && data.id ? [data] : undefined;
        if (rows) {
          for (const row of rows) {
            if (isHostNotification(row) || row.from === 'host' && (!row.to || row.to === 'scheduler' || row.to.startsWith('orchestrator:')) &&
              (String(row.subject ?? '').startsWith(EVENT_NOTIFICATION_SUBJECT_PREFIX) || /^\s*\{\s*"type"\s*:\s*"event-notification"/.test(row.text ?? '') ||
                /^应用通知：[^\n]*\nappId: [^\n]+\nrecordIds: /.test(row.text ?? ''))) continue;
            if (typeof row.text !== 'string' || row.read !== true || typeof row.id !== 'string') continue;
            const sender = coerceSourceAgentIdentity(row.sourceAgent) ?? coerceSourceAgentIdentity({ sessionId: row.from, name: row.fromName || row.from });
            if (!sender) continue;
            const offset = typeof row.offset === 'number' ? row.offset : 0;
            const key = `${row.mailboxWorkspaceId ?? ''}:${row.id}:${offset}`;
            if ((pages.get(key)?.text.length ?? -1) >= row.text.length) continue;
            const hostEvent = row.from === 'host' && offset === 0 && typeof row.subject === 'string' &&
              row.subject.startsWith(EVENT_NOTIFICATION_SUBJECT_PREFIX) && /^\s*\{\s*"type"\s*:\s*"event-notification"(?:\s*[,}])/.test(row.text);
            pages.set(key, { key, sender, text: row.text, offset, nextOffset: row.nextOffset,
              ...(typeof row.subject === 'string' ? { subject: row.subject } : {}), ...(hostEvent ? { hostEvent: true } : {}) });
          }
          break;
        }
        if (data.result && typeof data.result === 'object') data = data.result;
        else if (data.structuredContent) data = data.structuredContent;
        else {
          const text = data.content?.find((v: { type?: string; text?: string }) => v.type === 'text' && typeof v.text === 'string')?.text;
          data = text ? JSON.parse(text) : undefined;
        }
      }
    } catch { /* Invalid tool output remains visible in its original tool card. */ }
  }
  return [...pages.values()];
}
