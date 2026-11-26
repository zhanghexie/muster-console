// @vitest-environment node
import { expect, it, vi } from 'vitest';
import type { GuiChatMessage, GuiWorkerPush } from '../../../src/shared/guiWorker';
import { applyGuiMessagePart } from '../../../src/shared/guiWorker';
import { createAcpStreamState, mapAcpSessionUpdate } from '../../../src/main/agentSession/drivers/acp/streamMap';
import type { HostCore, SessionEntry } from '../../../src/main/agentSession/host/internal';

vi.mock('electron', () => ({ app: {} }));
vi.mock('../../../src/main/agent/providers/piProvider', () => ({ disposePiSessionResources: vi.fn() }));
vi.mock('../../../src/main/attachments/service', () => ({ clearAttachments: vi.fn() }));
vi.mock('../../../src/main/agentSession/host/fileChanges', () => ({ noteFileChangeStart: vi.fn(), noteFileChangeEnd: vi.fn() }));
vi.mock('../../../src/main/agentSession/host/turn', () => ({ finishTurn: vi.fn(), handleTurnFailure: vi.fn() }));

import { handleEvent } from '../../../src/main/agentSession/host/events';

vi.stubGlobal('window', globalThis);

it('publishes and records late Qwen arguments on the existing tool part', () => {
  const message: GuiChatMessage = { id: 'assistant', role: 'assistant', ts: 1, parts: [] };
  let rendered: GuiChatMessage[] | null = [structuredClone(message)];
  const recorded = vi.fn();
  const pushPart = (event: GuiWorkerPush) => {
    if (event.kind === 'part') {
      rendered = applyGuiMessagePart(rendered!, event.messageId, event.partIndex, structuredClone(event.part));
    }
  };
  const entry = { sessionId: 'session', assistant: message, messages: [message], cwd: '.', mode: 'default' } as SessionEntry;
  const host = {
    ctx: { getWindow: () => null },
    entries: new Map([[entry.sessionId, entry]]),
    pushSubs: new Set([pushPart]),
    store: { recordToolPart: (_session: string, _message: string, part: unknown) => recorded(structuredClone(part)) }
  } as unknown as HostCore;
  const state = createAcpStreamState('qwen');
  const accept = (fields: Record<string, unknown>) => {
    for (const event of mapAcpSessionUpdate(state, { toolCallId: 'call', ...fields })) handleEvent(host, entry, event);
  };

  accept({ sessionUpdate: 'tool_call', status: 'pending', title: 'ToolCall', rawInput: {}, locations: [] });
  accept({
    sessionUpdate: 'tool_call_update', status: 'in_progress', title: 'mcp_search (muster MCP Server)',
    rawInput: { query: 'tools' }, _meta: { toolName: 'mcp__muster__mcp_search' }
  });
  const expected = {
    kind: 'tool', tool: { id: 'call', name: 'mcp__muster__mcp_search', input: { query: 'tools' }, status: 'running' }
  };
  expect(rendered?.[0]?.parts).toEqual([expected]);
  expect(recorded).toHaveBeenLastCalledWith(expected);

  accept({ sessionUpdate: 'tool_call_update', status: 'completed', rawOutput: '{"ok":true}' });
  const completed = { ...expected, tool: { ...expected.tool, status: 'ok', output: '{"ok":true}' } };
  expect(rendered?.[0]?.parts).toEqual([completed]);
  expect(recorded).toHaveBeenLastCalledWith(completed);
  expect(recorded).toHaveBeenCalledTimes(3);
});
