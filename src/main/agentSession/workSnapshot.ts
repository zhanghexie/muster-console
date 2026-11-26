import type { AppContext } from '../context';

/** Bounded in-flight context for a managed GUI interruption, never an authorization. */
export function captureGuiWorkContext(ctx: AppContext, sessionId: string): string | undefined {
  const entry = ctx.agentSessions?.entries?.get(sessionId);
  if (!entry?.busy) return undefined;
  const parts = entry.assistant?.parts.map(part => part.kind === 'text' || part.kind === 'thinking'
    ? { kind: part.kind, text: part.text.slice(-4000) }
    : { kind: part.kind, tool: { name: part.tool.name, input: part.tool.input, status: part.tool.status } });
  return JSON.stringify({ input: entry.lastTurnInput?.text?.slice(-4000), assistant: parts }, null, 2).slice(0, 12000);
}
