import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ChatSurface } from '../../src/shared/chatSurface';
import type { GuiChatMessage, GuiToolCallView } from '../../src/shared/guiWorker';
import { guiReplayMaterial } from '../../src/main/runtimeKernel/guiReplayMaterial';
import type { EventEnvelope } from '../../src/main/runtimeKernel/contracts';
import { sessionReplayFrames, type SessionReplayHandle } from '../../src/shared/sessionReplay';
import { replaySession, useSessionReplay } from '../../src/renderer/src/chatSurface/sessionReplay';
import { currentApiMock } from './helpers/api-mock';

const tool: GuiToolCallView = { id: 'read-1', name: 'read', input: { path: 'intro.txt' }, status: 'ok', output: '镜头' };
const messages: GuiChatMessage[] = [
  { id: 'u', role: 'user', ts: 1000, parts: [{ kind: 'text', text: '打开片头' }] },
  { id: 'a', role: 'assistant', ts: 1200, parts: [
    { kind: 'text', text: '现在开始' }, { kind: 'tool', tool }, { kind: 'text', text: '完成。' }
  ] }
];

it('用记录的分块和工具状态重放，旧快照及被修改的正文按最终消息分块', async () => {
  const payloads = [
    { kind: 'delta', deltaKind: 'text', delta: '现' },
    { kind: 'delta', deltaKind: 'text', delta: '在开始' },
    { kind: 'tool', part: { kind: 'tool', tool: { ...tool, status: 'running', output: undefined } } },
    { kind: 'tool', part: { kind: 'tool', tool } },
    { kind: 'delta', deltaKind: 'text', delta: '完成。' }
  ];
  const journal: EventEnvelope[] = payloads.map((payload, i) => ({ type: 'gui-session.' + payload.kind,
    seq: i + 1, sessionId: 's', eventId: String(i), schemaVersion: 1, createdAt: 1300 + i * 40, payload: { ...payload, messageId: 'a' } }));
  const material = await guiReplayMaterial(messages, 5, async () => journal);
  const frames = [...sessionReplayFrames(JSON.parse(JSON.stringify(material)))];
  expect(frames.map(frame => frame.delay)).toEqual([0, 100, 100, 40, 40, 40, 40, 0]);
  expect(frames[2].message.parts).toEqual([{ kind: 'text', text: '现' }]);
  expect(frames[4].message.parts[1]).toMatchObject({ tool: { status: 'running' } });
  expect(frames[4].message.parts[1]).not.toHaveProperty('tool.output');
  expect(frames[5].message.parts[1]).toMatchObject({ tool: { status: 'ok', output: '镜头' } });
  expect(frames.at(-1)?.message.parts).toEqual(messages[1].parts);

  const edited = structuredClone(messages);
  edited[1].parts[0] = { kind: 'text', text: '改过的文字和表情🎬' };
  const old = await guiReplayMaterial(edited, 5, async () => journal);
  expect(old.tracks).toEqual([]);
  const fallback = [...sessionReplayFrames(old)];
  expect(fallback[2].message.parts[0]).toEqual({ kind: 'text', text: '改过的文字' });
  expect(fallback.at(-1)?.message.parts).toEqual(edited[1].parts);
  expect(messages[1].parts[0]).toEqual({ kind: 'text', text: '现在开始' });
  const revisedTool = structuredClone(messages);
  revisedTool[1].parts[1] = { kind: 'tool', tool: { ...tool, output: '修订后的输出' } };
  expect((await guiReplayMaterial(revisedTool, 5, async () => journal)).tracks).toEqual([]);
});

afterEach(() => vi.useRealTimers());

const earlier: GuiChatMessage[] = [
  { id: 'first-q', role: 'user', ts: 100, parts: [{ kind: 'text', text: '先准备场景' }] },
  { id: 'first-a', role: 'assistant', ts: 200, parts: [{ kind: 'text', text: '场景已就绪' }] }
];
const later: GuiChatMessage = { id: 'later', role: 'user', ts: 5000, parts: [{ kind: 'text', text: '下一个镜头' }] };

it('回放选段时首帧保留上轮问答，只让选段流式出现，停止后恢复后续轮次', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const saved = [...earlier, ...messages, later];
  const readEvents = vi.fn(async () => [] as EventEnvelope[]);
  const api = currentApiMock();
  api.override('sessions.list', () => ({ activeId: 'same', sessions: [{ id: 'same', runtime: 'pi' }] }));
  api.override('agentSession.replayMaterial', (_id, beforeMessageIds) => guiReplayMaterial(saved, 2, readEvents, beforeMessageIds));
  const live = { sessionId: 'same', caps: {}, getSnapshot: () => ({ messages: saved, busy: false }) } as unknown as ChatSurface;
  const hook = renderHook(() => useSessionReplay(live));
  const rows = () => hook.result.current.surface.getSnapshot().messages;
  for (let i = 0; i < 2; i++) {
    let take!: SessionReplayHandle;
    await act(async () => { take = await replaySession(messages, 'same'); });
    expect(rows()).toMatchObject([...earlier, messages[0]]);
    await act(async () => { await vi.advanceTimersByTimeAsync(160); });
    expect(rows().slice(0, 2)).toMatchObject(earlier);
    expect(rows().at(-1)).toMatchObject({ id: 'a', parts: [{ text: '现在开始' }] });
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(await take.finished).toBe('finished');
    expect(rows()).toMatchObject([...earlier, ...messages]);
    act(() => take.stop());
    expect(rows()).toBe(saved);
  }
  expect(readEvents).not.toHaveBeenCalled();
  expect(api.mockOf('agentSession.clear')).not.toHaveBeenCalled();
});

it('同一目标可中途重拍、切走再回来并还原；旧句柄和延迟事件不会污染下一条', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const api = currentApiMock();
  api.override('sessions.list', () => ({ activeId: 'target', sessions: [{ id: 'target', runtime: 'pi' }] }));
  api.override('agentSession.replayMaterial', (id, beforeMessageIds) =>
    guiReplayMaterial(id === 'target' ? earlier : messages, 0, async () => [], beforeMessageIds));
  const live = { sessionId: 'target', caps: {}, getSnapshot: () => ({ messages: earlier, busy: false }) } as unknown as ChatSurface;
  const hook = renderHook(() => useSessionReplay(live));
  let first!: SessionReplayHandle, second!: SessionReplayHandle;
  await act(async () => { first = await replaySession('source', 'target'); });
  const snapshot = () => hook.result.current.surface.getSnapshot();
  expect(snapshot().messages).toMatchObject([...earlier, { id: 'u' }]);
  await act(async () => { await vi.advanceTimersByTimeAsync(160); });
  expect(snapshot().messages).toMatchObject([...earlier, { id: 'u' }, { id: 'a', parts: [{ text: '现在开始' }] }]);
  await act(async () => { second = await replaySession(messages, 'target'); });
  expect(await first.finished).toBe('stopped');
  act(() => first.stop());
  expect(snapshot().messages).toMatchObject([...earlier, { id: 'u' }]);
  hook.unmount();
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(await second.finished).toBe('finished');
  const remounted = renderHook(() => useSessionReplay(live));
  expect(remounted.result.current.surface.getSnapshot().messages).toMatchObject([...earlier, ...messages]);
  expect(await remounted.result.current.surface.actions.send('忽略')).toBe(false);
  act(() => second.stop());
  expect(remounted.result.current.surface).toBe(live);
  expect(api.mockOf('agentSession.send')).not.toHaveBeenCalled();
  expect(api.mockOf('agentSession.clear')).not.toHaveBeenCalled();
});

it('先发起的异步取材晚到时不会抢回已经还原的目标', async () => {
  const api = currentApiMock();
  const listing = { activeId: 'race', sessions: [{ id: 'race', runtime: 'pi' }] };
  api.override('agentSession.replayMaterial', () => ({ version: 1, messages: [] }));
  let release!: (value: typeof listing) => void;
  api.mockOf('sessions.list').mockImplementationOnce(() => new Promise(resolve => { release = resolve; }))
    .mockResolvedValue(listing);
  const earlier = replaySession(messages, 'race');
  const newer = await replaySession(messages, 'race');
  newer.stop();
  release(listing);
  await expect(earlier).rejects.toThrow('已被新请求替换');
});
