/** Projects normalized Codex turn and item events into the GUI stream. */
import type { GuiDriverStreamEvent } from '../../types';
import type { CodexThreadEvent, CodexThreadItem } from './protocol';

export interface CodexStreamState {
  textById: Map<string, string>;
  thinkingById: Map<string, string>;
  toolStarted: Set<string>;
  toolEnded: Set<string>;
}

export function createCodexStreamState(): CodexStreamState {
  return { textById: new Map(), thinkingById: new Map(), toolStarted: new Set(), toolEnded: new Set() };
}

export function resetCodexStreamTurn(state: CodexStreamState): void {
  state.textById.clear();
  state.thinkingById.clear();
  state.toolStarted.clear();
  state.toolEnded.clear();
}

function toolInputOf(item: CodexThreadItem): Record<string, unknown> {
  switch (item.type) {
    case 'command_execution':
      return { command: item.command };
    case 'file_change':
      return { changes: item.changes };
    case 'mcp_tool_call':
      return {
        server: item.server,
        tool: item.tool,
        ...(item.arguments && typeof item.arguments === 'object' && !Array.isArray(item.arguments)
          ? (item.arguments as Record<string, unknown>)
          : { arguments: item.arguments })
      };
    case 'web_search':
      return { query: item.query };
    case 'todo_list':
      return { items: item.items };
    default:
      return {};
  }
}

function toolOutputOf(item: CodexThreadItem): { ok: boolean; output: string } {
  switch (item.type) {
    case 'command_execution': {
      const out = item.aggregated_output ?? '';
      const ok = item.status !== 'failed' && (item.exit_code == null || item.exit_code === 0);
      return { ok, output: out };
    }
    case 'file_change': {
      const paths = item.changes.map((c) => `${c.kind} ${c.path}`).join('\n');
      return { ok: item.status !== 'failed', output: paths };
    }
    case 'mcp_tool_call': {
      if (item.status === 'failed') {
        return { ok: false, output: item.error?.message ?? 'MCP 调用失败' };
      }
      const texts =
        item.result?.content
          ?.map((b) => (b && typeof b === 'object' && 'text' in b ? String((b as { text?: unknown }).text ?? '') : ''))
          .filter(Boolean)
          .join('\n') ?? '';
      // MCP may return only structured data. Preserve it for downstream UI
      // projections instead of silently turning a successful result empty.
      const result = item.result;
      const structured = result?.structured_content ?? result?.structuredContent;
      return { ok: true, output: texts || (structured == null ? '' : JSON.stringify(structured)) };
    }
    case 'web_search':
      return { ok: true, output: item.query };
    case 'todo_list':
      return {
        ok: true,
        output: item.items.map((t) => `${t.completed ? '[x]' : '[ ]'} ${t.text}`).join('\n')
      };
    case 'error':
      return { ok: false, output: item.message };
    default:
      return { ok: true, output: '' };
  }
}

function isToolItem(item: CodexThreadItem): boolean {
  return (
    item.type === 'command_execution' ||
    item.type === 'file_change' ||
    item.type === 'mcp_tool_call' ||
    item.type === 'web_search' ||
    item.type === 'todo_list'
  );
}

function appendDelta(
  map: Map<string, string>,
  id: string,
  next: string,
  kind: 'text-delta' | 'thinking-delta'
): GuiDriverStreamEvent[] {
  const prev = map.get(id) ?? '';
  if (!next || next === prev) return [];
  let delta = next;
  if (next.startsWith(prev)) delta = next.slice(prev.length);
  else if (prev.includes(next)) return [];
  map.set(id, next);
  if (!delta) return [];
  return [{ type: kind, delta }];
}

export function mapCodexEvent(state: CodexStreamState, ev: CodexThreadEvent): GuiDriverStreamEvent[] {
  switch (ev.type) {
    case 'thread.started':
      return [];
    case 'turn.started':
      return [];
    case 'item.started':
    case 'item.updated':
    case 'item.completed':
      return mapItem(state, ev.item, ev.type === 'item.completed');
    default:
      return [];
  }
}

/** Project child events only into review, never into the parent chat transcript. */
export function mapCodexReviewEvent(state: CodexStreamState, ev: CodexThreadEvent): GuiDriverStreamEvent[] {
  return mapCodexEvent(state, ev).flatMap((event): GuiDriverStreamEvent[] => {
    if (event.type === 'tool-start' || event.type === 'tool-update') {
      return [{ ...event, type: event.type === 'tool-start' ? 'review-tool-start' : 'review-tool-update' }];
    }
    if (event.type === 'tool-result') {
      return [{ type: 'review-tool-result', toolCallId: event.toolCallId, ok: event.ok,
        ...(event.patch ? { patch: event.patch } : {}), ...(event.reviewChanges ? { reviewChanges: event.reviewChanges } : {}) }];
    }
    return [];
  });
}

function mapItem(state: CodexStreamState, item: CodexThreadItem, completed: boolean): GuiDriverStreamEvent[] {
  const out: GuiDriverStreamEvent[] = [];
  if (item.type === 'agent_message') {
    out.push(...appendDelta(state.textById, item.id, item.text ?? '', 'text-delta'));
    return out;
  }
  if (item.type === 'reasoning') {
    out.push(...appendDelta(state.thinkingById, item.id, item.text ?? '', 'thinking-delta'));
    return out;
  }
  if (item.type === 'error') {
    if (completed) {
      out.push({ type: 'text-delta', delta: item.message });
    }
    return out;
  }
  if (!isToolItem(item)) return out;
  if (state.toolEnded.has(item.id)) return out;
  if (!state.toolStarted.has(item.id)) {
    state.toolStarted.add(item.id);
    out.push({
      type: 'tool-start',
      toolCallId: item.id,
      toolName: item.type,
      input: toolInputOf(item),
      ...(completed ? { reviewLate: true } : {})
    });
  } else if (!completed && item.type === 'file_change') {
    out.push({ type: 'tool-update', toolCallId: item.id, toolName: item.type, input: toolInputOf(item) });
  }
  if (completed) {
    state.toolEnded.add(item.id);
    const { ok, output } = toolOutputOf(item);
    const changes = item.type === 'file_change' ? item.changes.flatMap(change => {
      if (change.diffOmitted) return [{ path: change.path, kind: change.kind, diff: '', diffOmitted: true }];
      return typeof change.diff === 'string' && change.diff ? [{ path: change.path, kind: change.kind, diff: change.diff }] : [];
    }) : [];
    out.push({
      type: 'tool-result',
      toolCallId: item.id,
      toolName: item.type,
      ok,
      output,
      ...(changes.length ? { reviewChanges: changes } : {})
    });
  }
  return out;
}

export function describeCodexTurnError(ev: CodexThreadEvent): string | undefined {
  if (ev.type === 'turn.failed') return ev.error?.message || 'Codex 回合失败';
  if (ev.type === 'error') return ev.message || 'Codex 事件流错误';
  return undefined;
}
