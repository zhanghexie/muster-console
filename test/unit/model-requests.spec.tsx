import { dismissTip, getTipSnapshot } from '../../src/renderer/src/tips';
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { ModelRequestsDialog } from '../../src/renderer/src/agentChat/ModelRequestsDialog';
import { useModelRequestViewer } from '../../src/renderer/src/agentChat/ModelRequestRecording';
import { AgentChatView } from '../../src/renderer/src/agentChat/AgentChatView';
import { SchedulerConversation } from '../../src/renderer/src/panels/SchedulerConversation';
import { getOrchestratorSurface, resetOrchestratorListenersForTest } from '../../src/renderer/src/chatSurface/orchestratorSurface';
import { StoreProvider } from '../../src/renderer/src/store';
import { currentApiMock } from './helpers/api-mock';

beforeEach(() => {
  dismissTip();
  resetOrchestratorListenersForTest();
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
});

function RequestsDialog(props: Omit<React.ComponentProps<typeof ModelRequestsDialog>, 'recording'>) {
  const { recording } = useModelRequestViewer(props.sessionId);
  return <ModelRequestsDialog {...props} recording={recording} />;
}

function typeCommand(text: string): HTMLElement {
  const editor = screen.getByRole('textbox');
  editor.focus();
  editor.textContent = text;
  window.getSelection()!.collapse(editor, editor.childNodes.length);
  fireEvent.input(editor);
  return editor;
}

it.each(['worker', 'extension', 'scheduler'] as const)('runs the same local recording command in %s', async scope => {
  const api = currentApiMock();
  const sessionId = scope === 'scheduler' ? 'scheduler:ws-recording' : scope;
  api.mockOf('agent.listSkills').mockResolvedValue({ skills: [] });
  api.mockOf('agentSession.modelRequestRecording').mockResolvedValue(false);
  api.mockOf('agentSession.setModelRequestRecording').mockImplementation(async (_id, enabled) => enabled);
  api.mockOf('agentSession.modelRequests').mockResolvedValue([]);
  render(<StoreProvider>{scope === 'scheduler'
    ? <SchedulerConversation surface={getOrchestratorSurface('ws-recording')} />
    : <AgentChatView sessionId={sessionId} visible runtimeId="pi" runtimeLabel="Pi" compactHeader
        variant={scope === 'extension' ? 'extension' : 'full'} />}</StoreProvider>);

  const shortcut = () => screen.queryByRole('button', { name: '录制中，打开模型请求' });
  const toggle = () => screen.getByRole('switch', { name: '记录本会话请求' }) as HTMLInputElement;
  expect(shortcut()).toBeNull();
  const editor = typeCommand('/rec');
  const option = await screen.findByRole('option', { name: /\/record-requests/ });
  expect(option.getAttribute('aria-selected')).toBe('true');
  fireEvent.keyDown(editor, { key: 'Enter' });
  await waitFor(() => expect(toggle().checked).toBe(true));
  expect(api.mockOf('agentSession.setModelRequestRecording')).toHaveBeenCalledExactlyOnceWith(sessionId, true);
  expect(editor.textContent).toBe('');
  expect(api.mockOf('agentSession.send')).not.toHaveBeenCalled();
  expect(api.mockOf('chat.send')).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole('button', { name: '关闭' }));
  expect(document.activeElement).toBe(editor);
  const button = shortcut()!;
  expect(button.getAttribute('aria-haspopup')).toBe('dialog');
  button.focus();
  fireEvent.click(button);
  expect(toggle().checked).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '关闭' }));
  expect(document.activeElement).toBe(button);
  fireEvent.click(button);

  fireEvent.click(toggle());
  await waitFor(() => expect(toggle().checked).toBe(false));
  expect(api.mockOf('agentSession.setModelRequestRecording')).toHaveBeenLastCalledWith(sessionId, false);
  fireEvent.click(screen.getByRole('button', { name: '关闭' }));
  expect(shortcut()).toBeNull();
  expect(document.activeElement).toBe(editor);

  fireEvent.keyDown(typeCommand('/record-requests view'), { key: 'Enter' });
  expect((await screen.findByRole('switch') as HTMLInputElement).checked).toBe(false);
  expect(api.mockOf('agentSession.setModelRequestRecording')).toHaveBeenCalledTimes(2);
});

it('uses host events for the current conversation and ignores a stale initial read', async () => {
  const api = currentApiMock();
  let finishRead!: (enabled: boolean) => void;
  api.mockOf('agentSession.modelRequestRecording').mockImplementationOnce(() => new Promise(resolve => { finishRead = resolve; }));
  render(<StoreProvider><AgentChatView sessionId="visible" visible runtimeId="pi" runtimeLabel="Pi" compactHeader /></StoreProvider>);
  const shortcut = () => screen.queryByRole('button', { name: '录制中，打开模型请求' });
  act(() => api.emit('modelRequests:recordingChanged', { sessionId: 'other', enabled: true }));
  expect(shortcut()).toBeNull();
  act(() => api.emit('modelRequests:recordingChanged', { sessionId: 'visible', enabled: true }));
  expect(shortcut()).not.toBeNull();
  await act(async () => finishRead(false));
  expect(shortcut()).not.toBeNull();
  act(() => api.emit('modelRequests:recordingChanged', { sessionId: 'visible', enabled: false }));
  expect(shortcut()).toBeNull();
});

it('exports the selected call or all session calls, guards duplicates and handles cancel and failure', async () => {
  const api = currentApiMock();
  api.mockOf('agentSession.modelRequests').mockResolvedValue([2, 1].map(id => ({
    id, at: id, model: 'fixture', protocol: 'test', bytes: 2, complete: true
  })));
  api.mockOf('agentSession.modelRequestRecording').mockResolvedValue(false);
  api.mockOf('agentSession.modelRequestBody').mockResolvedValue('{}');
  let finish!: (result: unknown) => void;
  const exportApi = api.mockOf('agentSession.exportModelRequests').mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
    .mockResolvedValueOnce({ ok: false, canceled: true })
    .mockResolvedValueOnce({ ok: false, error: 'disk full' })
    .mockResolvedValueOnce({ ok: true, path: '/export.zip', count: 63, omitted: 1 })
    .mockRejectedValueOnce(new Error('connection lost'));
  render(<RequestsDialog open sessionId="s" onClose={vi.fn()}/>);
  const current = await screen.findByRole('button', { name: '导出当前调用' }) as HTMLButtonElement;
  const all = screen.getByRole('button', { name: '导出全部调用' }) as HTMLButtonElement;
  await waitFor(() => expect(current.disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: /#1/ }));
  fireEvent.click(current);
  expect(exportApi).toHaveBeenLastCalledWith('s', 1);
  expect(current.disabled).toBe(true);
  expect(all.disabled).toBe(true);
  fireEvent.click(all);
  expect(exportApi).toHaveBeenCalledTimes(1);
  await act(async () => finish({ ok: true, path: '/one.zip', count: 1, omitted: 0 }));
  await screen.findByText('已导出 1 次调用');
  fireEvent.click(all);
  expect(exportApi).toHaveBeenLastCalledWith('s', undefined);
  await waitFor(() => expect(all.disabled).toBe(false));
  expect(screen.queryByText('已导出 1 次调用')).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
  fireEvent.click(all);
  await waitFor(() => expect(getTipSnapshot()?.text).toContain('disk full'));
  fireEvent.click(all);
  await screen.findByText('已导出 63 次调用（1 条正文未保存）');
  fireEvent.click(current);
  await waitFor(() => expect(getTipSnapshot()?.text).toContain('connection lost'));
  expect(api.mockOf('agentSession.setModelRequestRecording')).not.toHaveBeenCalled();
});

it('disables exporting when the session has no retained calls', async () => {
  const api = currentApiMock();
  api.mockOf('agentSession.modelRequests').mockResolvedValue([]);
  api.mockOf('agentSession.modelRequestRecording').mockResolvedValue(false);
  render(<RequestsDialog open sessionId="empty" onClose={vi.fn()}/>);
  await screen.findByText('暂无模型请求记录');
  expect((screen.getByRole('button', { name: '导出当前调用' }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole('button', { name: '导出全部调用' }) as HTMLButtonElement).disabled).toBe(true);
});

it('compacts the current session independently of recording and shows a busy rejection', async () => {
  const api = currentApiMock();
  api.mockOf('agentSession.modelRequests').mockResolvedValue([]);
  api.mockOf('agentSession.modelRequestRecording').mockResolvedValue(false);
  const compact = vi.fn().mockResolvedValueOnce({ ok: false, error: '当前回合正在输出' }).mockResolvedValueOnce({ ok: true });
  render(<RequestsDialog open sessionId="s" onClose={vi.fn()} compact={compact}/>);
  const button = await screen.findByRole('button', { name: '压缩当前会话' });
  fireEvent.click(button);
  await screen.findByText('当前回合正在输出');
  fireEvent.click(button);
  await screen.findByText('当前会话已压缩');
  expect(compact).toHaveBeenCalledTimes(2);
  expect(api.mockOf('agentSession.setModelRequestRecording')).not.toHaveBeenCalled();
});

it('shows the sent field for a checkpoint, loads its source on demand and resets when switching calls', async () => {
  const api = currentApiMock();
  const sent = 'The conversation history before this point was compacted into the following summary:\n\n<summary>\n[Core L2 · evidence: core_context status/search/read]\nphase two\n</summary>';
  api.mockOf('agentSession.modelRequests').mockResolvedValue([2, 1].map(id => ({ id, at: id, bytes: 200, protocol: 'openai-responses', model: 'unit', complete: true,
    ...(id === 2 ? { compressionCount: 1 } : {}) })));
  api.mockOf('agentSession.modelRequestRecording').mockResolvedValue(false);
  api.mockOf('agentSession.modelRequestBody').mockResolvedValue(JSON.stringify({ input: [{ role: 'user', content: [{ type: 'input_text', text: sent }] }] }));
  api.mockOf('agentSession.modelRequestCompression').mockResolvedValue([{ path: 'input[0].content[0].text', kind: 'checkpoint', level: 2,
    id: 'new', previous: 'old', sources: [{ role: 'compaction', id: 'old', chars: 20 }] }]);
  api.mockOf('agentSession.modelRequestSource').mockResolvedValue({ text: 'original checkpoint', next: null });
  render(<RequestsDialog open sessionId="s" onClose={vi.fn()}/>);
  fireEvent.click(await screen.findByRole('button', { name: /^压缩$/ }));
  await screen.findByText('阶段检查点');
  expect(document.querySelector('.request-compression-card section > pre')?.textContent).toBe(sent);
  expect(api.mockOf('agentSession.modelRequestSource')).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('上代检查点'));
  await screen.findByText('original checkpoint');
  expect(api.mockOf('agentSession.modelRequestSource')).toHaveBeenCalledWith('s', 2, 'old', 0);
  fireEvent.click(screen.getByRole('button', { name: /#1/ }));
  fireEvent.click(await screen.findByRole('button', { name: /^压缩$/ }));
  await screen.findByText('这条记录没有可核对的压缩来源');
  expect(screen.queryByText('original checkpoint')).toBeNull();
});

it('opens independently, switches actual calls and ignores a late body from the previous selection', async () => {
  const api = currentApiMock();
  api.mockOf('agentSession.modelRequests').mockResolvedValue([2, 1].map(id => ({
    id, at: id, bytes: 104, model: 'unit-model', protocol: 'openai-responses', complete: true
  })));
  api.mockOf('agentSession.modelRequestRecording').mockResolvedValue(false);
  api.mockOf('agentSession.setModelRequestRecording').mockImplementation((_id, enabled) => Promise.resolve(enabled));
  let resolveOld!: (value: string) => void;
  const body = '{ "input": [{"role":"user","content":"the actual input"}],"previous_response_id":"resp_1" }';
  api.mockOf('agentSession.modelRequestBody').mockImplementation((_session, id) =>
    id === 2 ? new Promise(resolve => { resolveOld = resolve; }) : Promise.resolve(body));
  const close = vi.fn();
  const view = render(<RequestsDialog open={false} sessionId="unit" onClose={close}/>);
  expect(api.mockOf('agentSession.modelRequests')).not.toHaveBeenCalled();
  view.rerender(<RequestsDialog open sessionId="unit" onClose={close}/>);
  await waitFor(() => expect(api.mockOf('agentSession.modelRequestBody')).toHaveBeenCalledWith('unit', 2));
  fireEvent.click(screen.getByRole('button', { name: /#1/ }));
  await screen.findByText('the actual input');
  fireEvent.click(screen.getByRole('button', { name: '原始请求体' }));
  fireEvent.click(screen.getByRole('checkbox', { name: '格式化 JSON' }));
  await act(async () => resolveOld('stale'));
  expect(view.baseElement.querySelector('.request-source pre')?.textContent).toBe(body);
  const toggle = screen.getByRole('switch', { name: '记录本会话请求' }) as HTMLInputElement;
  expect(toggle.checked).toBe(false);
  expect(api.mockOf('agentSession.setModelRequestRecording')).not.toHaveBeenCalled();
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle.checked).toBe(true));
  expect(api.mockOf('agentSession.setModelRequestRecording')).toHaveBeenLastCalledWith('unit', true);
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle.checked).toBe(false));
  expect(api.mockOf('agentSession.setModelRequestRecording')).toHaveBeenLastCalledWith('unit', false);
  fireEvent.click(screen.getByRole('button', { name: '关闭' }));
  expect(close).toHaveBeenCalledOnce();
});

it.each([
  ['{ "n":9007199254740993, "n":1.00e+3,"q":"\\u0041" }', '{\n  "n": 9007199254740993,\n  "n": 1.00e+3,\n  "q": "\\u0041"\n}'],
  ['null', 'null'],
  ['{"unfinished":', undefined]
])('formats valid JSON without changing its literals and preserves the sent text: %s', async (body, formatted) => {
  const api = currentApiMock();
  api.mockOf('agentSession.modelRequests').mockResolvedValue([{ id: 1, model: 'fixture', at: 1, protocol: 'test', bytes: body!.length, complete: true }]);
  api.mockOf('agentSession.modelRequestBody').mockResolvedValue(body);
  api.mockOf('agentSession.modelRequestRecording').mockResolvedValue(false);
  const view = render(<RequestsDialog open sessionId="unit" onClose={vi.fn()}/>);
  fireEvent.click(await screen.findByRole('button', { name: '原始请求体' }));
  if (formatted !== undefined) {
    const json = await screen.findByRole('textbox', { name: '格式化 JSON' });
    expect(Array.from(json.querySelectorAll('.cm-line'), line => line.textContent).join('\n')).toBe(formatted);
    fireEvent.click(screen.getByRole('checkbox', { name: '格式化 JSON' }));
  } else {
    expect(screen.queryByRole('checkbox', { name: '格式化 JSON' })).toBeNull();
  }
  expect(view.baseElement.querySelector('.request-source pre')?.textContent).toBe(body);
});
