import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { ChatMessageView } from '../../src/renderer/src/components/ChatMessageView';
import { readMailPresentations } from '../../src/shared/mailReadPresentation';
import { ReadMailCards } from '../../src/renderer/src/components/ReadMailCards';
import { applyLocaleSetting } from '../../src/shared/i18n';
import type { ToolCallRecord } from '../../src/shared/types';
import { createCodexStreamState, mapCodexEvent } from '../../src/main/agentSession/drivers/codex/streamMap';
import { CodexAppServerEventMapper } from '../../src/main/agentSession/drivers/codex/appServerEvents';
import { toDisplayToolCall } from '../../src/renderer/src/chatSurface/guiToolDisplay';
import type { CodexThreadEvent } from '../../src/main/agentSession/drivers/codex/protocol';
import { toDisplayMessage } from '../../src/renderer/src/chatSurface/guiMessageView';
import { guiMessageText } from '../../src/shared/guiWorker';
import { withoutDisplayThinking } from '../../src/shared/thinkingDisplay';
import { cloneOrchestratorForkMessage, toOrchestratorForkSeeds } from '../../src/shared/orchestratorFork';

const letter = { id: 'mail-one', mailboxWorkspaceId: 'ws', from: 'child', fromName: '星探', read: true,
  text: '已经核对三个文件。\n请查看第二项。', offset: 0, nextOffset: null,
  sourceAgent: { sessionId: 'child', name: '星探', characterId: 'scout' } };
const call = (data: unknown): ToolCallRecord => ({ id: 'read', name: 'sessions.readMessages', arguments: '{}', status: 'ok', result: JSON.stringify(data) });
describe('实际读信正文展示', () => {
  it('宿主附加的来信不依赖 Harness 工具名称或结果，历史折叠不重复', async () => {
    const page = readMailPresentations([call({ messages: [letter] })]);
    const gui = { id: 'gui', role: 'assistant' as const, ts: 1,
      parts: [{ kind: 'tool' as const, tool: { id: 'x', name: 'Read mail', input: {}, status: 'ok' as const, output: '' } },
        { kind: 'text' as const, text: '收到。' }],
      displayItems: [{ id: 'display-1', kind: 'mail' as const, anchorPartIndex: 1, pages: page }] };
    expect(guiMessageText(gui)).toBe('收到。');
    const { container } = render(<ChatMessageView message={toDisplayMessage(gui)} collapsedTurn quiet />);
    expect(container.querySelector('[data-mail-read]')?.textContent).toContain(letter.text);
    fireEvent.click(container.querySelector('button.turn-fold')!);
    await waitFor(() => expect(container.querySelectorAll('[data-mail-read]')).toHaveLength(1));
  });
  it('附加信件与已有工具结果按页去重，思考投影调整锚点但不改变模型正文', () => {
    const pages = readMailPresentations([call({ messages: [letter] })]);
    const gui = { id: 'gui', role: 'assistant' as const, ts: 1,
      parts: [{ kind: 'thinking' as const, text: '思考' }, { kind: 'tool' as const, tool: { id: 'x', name: 'sessions.readMessages', input: {}, status: 'ok' as const, output: JSON.stringify({ messages: [letter] }) } },
        { kind: 'text' as const, text: '收到。' }],
      displayItems: [{ id: 'display-1', kind: 'mail' as const, anchorPartIndex: 2, pages }] };
    const [restored] = withoutDisplayThinking([gui]);
    expect(restored.displayItems[0].anchorPartIndex).toBe(1);
    expect(gui.displayItems[0].anchorPartIndex).toBe(2);
    expect(guiMessageText(restored)).toBe('收到。');
    const { container } = render(<ChatMessageView message={toDisplayMessage(restored)} quiet />);
    expect(container.querySelectorAll('[data-mail-read]')).toHaveLength(1);
    const dispatch = toDisplayMessage(restored);
    const clone = cloneOrchestratorForkMessage(dispatch);
    expect(clone.displayItems).toEqual(dispatch.displayItems);
    expect(JSON.stringify(toOrchestratorForkSeeds([clone]))).not.toContain(letter.text);
  });
  it('Codex MCP 读信事件经过驱动映射后仍显示来信，折叠活动时保留', () => {
    const state = createCodexStreamState();
    const item = { id: 'codex-mail', type: 'mcp_tool_call', server: 'muster', tool: 'sessions_readMessages',
      arguments: { includeBody: true }, status: 'completed', result: { content: [{ type: 'text', text: JSON.stringify({ messages: [letter] }) }] } };
    const events = mapCodexEvent(state, { type: 'item.completed', item } as unknown as CodexThreadEvent);
    const start = events.find(event => event.type === 'tool-start');
    const result = events.find(event => event.type === 'tool-result');
    if (!start || start.type !== 'tool-start' || !result || result.type !== 'tool-result') throw new Error('Codex tool events missing');
    const tool = toDisplayToolCall({ id: start.toolCallId, name: start.toolName, input: start.input,
      status: result.ok ? 'ok' : 'error', output: result.output });
    const { container } = render(<ChatMessageView message={{ id: 'codex-reply', role: 'assistant', createdAt: Date.now(), content: '',
      parts: [{ kind: 'tool', toolCall: tool }, { kind: 'text', text: '收到。' }] }} collapsedTurn quiet />);
    expect(container.querySelector('[data-mail-read]')?.textContent).toContain(letter.text);
    expect(container.querySelector('.tool-card')).toBeNull();
    expect(readMailPresentations([{ ...tool, input: { ...tool.input, tool: 'sessions_list' } }])).toEqual([]);
    expect(readMailPresentations([{ ...tool, status: 'error' }])).toEqual([]);
    expect(readMailPresentations([{ ...tool, result: JSON.stringify({ messages: [{ ...letter, text: undefined, preview: '摘要' }] }) }])).toEqual([]);
  });
  it('Codex app-server 读信事件经过两层映射后保留正文', () => {
    const item = { id: 'app-server-mail', type: 'mcpToolCall', server: 'muster', tool: 'sessions_readMessages',
      arguments: { includeBody: true }, status: 'completed', result: { content: [{ type: 'text', text: JSON.stringify({ messages: [letter] }) }] } };
    const [event] = new CodexAppServerEventMapper().map('item/completed', { item });
    const events = mapCodexEvent(createCodexStreamState(), event as CodexThreadEvent);
    const start = events.find(value => value.type === 'tool-start');
    const result = events.find(value => value.type === 'tool-result');
    if (!start || start.type !== 'tool-start' || !result || result.type !== 'tool-result') throw new Error('Codex tool events missing');
    const tool = toDisplayToolCall({ id: start.toolCallId, name: start.toolName, input: start.input, status: result.ok ? 'ok' : 'error', output: result.output });
    expect(readMailPresentations([tool]).map(page => page.text)).toEqual([letter.text]);
  });
  it.each(['structured_content', 'structuredContent'])('Codex MCP %s 单独返回结构化信件时不丢失', key => {
    const item = { id: 'codex-structured', type: 'mcp_tool_call', server: 'muster', tool: 'sessions_readMessages',
      arguments: {}, status: 'completed', result: { content: [], [key]: { messages: [letter] } } };
    const events = mapCodexEvent(createCodexStreamState(), { type: 'item.completed', item } as unknown as CodexThreadEvent);
    const start = events.find(event => event.type === 'tool-start');
    const result = events.find(event => event.type === 'tool-result');
    if (!start || start.type !== 'tool-start' || !result || result.type !== 'tool-result') throw new Error('Codex tool events missing');
    const tool = toDisplayToolCall({ id: start.toolCallId, name: start.toolName, input: start.input, status: result.ok ? 'ok' : 'error', output: result.output });
    expect(readMailPresentations([tool]).map(page => page.text)).toEqual([letter.text]);
  });
  it('来信标签和正文区间随语言切换，原始内容不变', async () => {
    const page = readMailPresentations([call({ ...letter, offset: 40, nextOffset: 70 })]);
    const { container } = render(<ReadMailCards pages={page}/>);
    expect(screen.getByText('星探 · 来信')).toBeTruthy();
    try {
      act(() => { applyLocaleSetting('en'); });
      expect(await screen.findByText('星探 · Letter')).toBeTruthy();
      expect(screen.getByText(`Message excerpt · characters 41–${40 + letter.text.length}`)).toBeTruthy();
      expect(container.querySelector('.read-mail-letter-body')?.textContent).toBe(letter.text);
    } finally { act(() => { applyLocaleSetting('zh-CN'); }); }
  });
  it('translates a host event subject only for an identified event letter', async () => {
    const event = { ...letter, id: 'event', from: 'host', to: 'worker', subject: '事件通知：pipeline.verdict',
      text: '{"type":"event-notification","sourceEventId":"event-one"}' };
    const userLetter = { ...letter, id: 'user', subject: '事件通知：pipeline.verdict', text: '用户的正文' };
    const pages = readMailPresentations([call({ messages: [event, userLetter] })]);
    const originals = structuredClone(pages);
    render(<ReadMailCards pages={pages}/>);
    try {
      act(() => { applyLocaleSetting('en'); });
      expect(await screen.findByText('星探 · Letter · Event notification: pipeline.verdict')).toBeTruthy();
      expect(screen.getByText('星探 · Letter · 事件通知：pipeline.verdict')).toBeTruthy();
      expect(pages).toEqual(originals);
      act(() => { applyLocaleSetting('zh-CN'); });
      expect(screen.getAllByText('星探 · 来信 · 事件通知：pipeline.verdict')).toHaveLength(2);
    } finally { act(() => { applyLocaleSetting('zh-CN'); }); }
  });
  it('宿主应用事件与旧 JSON 通知不再恢复成正文信纸，普通代理信件保留', () => {
    const app = { ...letter, from: 'host', to: 'orchestrator:ws', meta: { notificationKey: 'app:event-id' } };
    const event = { ...letter, from: 'host', to: 'orchestrator:ws', meta: { eventId: 'fact-id', subscriptionIds: ['sub'] } };
    expect(readMailPresentations([call({ messages: [app, event, letter] })])).toHaveLength(1);
    expect(readMailPresentations([call({ messages: [app, event] })])).toEqual([]);
    expect(readMailPresentations([call({ ...letter, from: 'host', subject: '事件通知：pipeline.verdict', text: '{"type":"event-notification","sourceEventId":"raw-id"}' })])).toEqual([]);
    expect(readMailPresentations([call({ ...letter, from: 'host', text: '应用通知：阅读\nappId: rss\nrecordIds: ["id"]' })])).toEqual([]);
  });
  it('工具折叠和快速切换后正文与发送者头像仍可见且不重复', async () => {
    const tool = call({ messages: [letter] });
    const { container } = render(<ChatMessageView message={{ id: 'reply', role: 'assistant', createdAt: 1, content: '',
      parts: [{ kind: 'tool', toolCall: tool }, { kind: 'text', text: '收到。' }] }} collapsedTurn quiet />);
    expect(container.querySelector('[data-mail-read]')?.textContent).toContain(letter.text);
    expect(container.querySelector('[data-mail-read]')?.classList.contains('is-left-aligned')).toBe(true);
    expect(container.querySelector('[data-mail-read] img')?.getAttribute('src')).toContain('scout.webp');
    expect(screen.getByText('星探 · 来信')).toBeTruthy();
    expect(screen.getByText('星探 · 来信').closest('.read-mail-letter')).toBeTruthy();
    expect(container.querySelector('[data-mail-read] .mail-letter')).toBeNull();
    expect(container.querySelector('[data-mail-read] .chat-msg-col > .chat-role')).toBeNull();
    const toggle = container.querySelector('button.turn-fold')!;
    fireEvent.click(toggle);
    await waitFor(() => expect(container.querySelector('.turn-fold-body [data-mail-read]')).toBeTruthy());
    expect(container.querySelectorAll('[data-mail-read]')).toHaveLength(1);
    fireEvent.click(toggle);
    expect(container.querySelectorAll('[data-mail-read]')).toHaveLength(1);
    expect(container.querySelector('[data-mail-read]')?.textContent).toContain(letter.text);
    fireEvent.click(toggle);
    await waitFor(() => expect(container.querySelector('.turn-fold-body [data-mail-read]')).toBeTruthy());
    expect(container.querySelectorAll('[data-mail-read]')).toHaveLength(1);
  });
  it('keeps a tool-only archived letter visible outside the unmounted folded activity', () => {
    const tool = call({ messages: [letter] });
    const { container } = render(<ChatMessageView message={{ id: 'archived', role: 'assistant', createdAt: 1, content: '',
      parts: [{ kind: 'tool', toolCall: tool }] }} collapsedTurn staleTurn quiet />);
    expect(container.querySelectorAll('[data-mail-read]')).toHaveLength(1);
    expect(container.querySelector('[data-mail-read]')?.textContent).toContain(letter.text);
    expect(container.querySelector('.turn-fold-body')).toBeNull();
  });
  it('摘要与失败结果不冒充读信，MCP 正文回放去重', () => {
    expect(readMailPresentations([call({ messages: [{ ...letter, text: undefined, preview: '摘要' }] })])).toEqual([]);
    expect(readMailPresentations([{ ...call(letter), status: 'error' }])).toEqual([]);
    const wrapped = { ...call({ content: [{ type: 'text', text: JSON.stringify({ messages: [letter] }) }] }), name: 'mcp__muster__sessions_readMessages' };
    expect(readMailPresentations([wrapped, wrapped])).toHaveLength(1);
    expect(readMailPresentations([call({ ...letter, offset: 40, nextOffset: 70 })])[0].offset).toBe(40);
  });
});
