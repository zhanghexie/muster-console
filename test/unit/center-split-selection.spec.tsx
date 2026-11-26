import React, { useEffect, useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useCenterSplitSelection } from '../../src/renderer/src/hooks/useCenterSplitSelection';
import { currentApiMock } from './helpers/api-mock';

type Controller = ReturnType<typeof useCenterSplitSelection<string>>;
function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function SelectionHarness({ workspaceId, ready, reveal, report, ensure }: {
  workspaceId: string;
  ready: (controller: Controller) => void;
  reveal: () => void;
  report: (error: unknown) => void;
  ensure: () => void;
}): React.JSX.Element {
  const [tool, setTool] = useState<string | null>('tasks');
  const controller = useCenterSplitSelection({ workspaceId, setUtilityPanel: setTool,
    ensureWorkspaceVisible: ensure, revealSession: reveal, reportError: report });
  useEffect(() => ready(controller), [ready, controller]);
  return <><output data-testid="current-tool">{tool ?? 'closed'}</output>
    <button onClick={() => controller.setUtilityPanel('usage')}>切到统计</button></>;
}

async function mount(workspaceId = 'a') {
  let controller!: Controller;
  const reveal = vi.fn(), report = vi.fn(), ensure = vi.fn();
  const ready = (value: Controller): void => { controller = value; };
  const element = (scope: string) => <SelectionHarness workspaceId={scope} ready={ready} reveal={reveal} report={report} ensure={ensure} />;
  let view!: ReturnType<typeof render>;
  await act(async () => { view = render(element(workspaceId)); });
  return { get controller() { return controller; }, view, reveal, report, ensure,
    scope: (id: string) => { view.rerender(element(id)); } };
}
const tool = () => screen.getByTestId('current-tool').textContent;

describe('App 共用的真实分屏选择与 IPC reveal 控制器', () => {
  it('defers axis reveal for an agent selection until its layout is approved', async () => {
    const api = currentApiMock(), pending = deferred();
    api.override('sessions.select', () => pending.promise);
    const harness = await mount();
    let selection!: void | Promise<void>;
    act(() => { selection = harness.controller.selectRef({ kind: 'session', sessionId: 'b' }, { deferReveal: true }); });
    expect(harness.ensure).not.toHaveBeenCalled();
    act(() => { api.emit('sessions:reveal', { sessionId: 'b' }); });
    expect(tool()).toBe('closed');
    expect(harness.reveal).not.toHaveBeenCalled();
    await act(async () => { pending.resolve(); await selection; });
    expect(harness.ensure).not.toHaveBeenCalled();
  });

  it('成功 reveal 收板，真实 sessions.select Promise 完成后保持收起', async () => {
    const api = currentApiMock(), pending = deferred();
    api.override('sessions.select', () => pending.promise);
    const harness = await mount();
    let selection!: void | Promise<void>;
    act(() => { selection = harness.controller.selectRef({ kind: 'session', sessionId: 'b' }); });
    expect(api.mockOf('sessions.select')).toHaveBeenCalledExactlyOnceWith('b');
    expect(tool()).toBe('tasks');
    act(() => { api.emit('sessions:reveal', { sessionId: 'b' }); });
    expect(tool()).toBe('closed');
    expect(harness.reveal).toHaveBeenCalledTimes(1);
    await act(async () => { pending.resolve(); await selection; });
    expect(tool()).toBe('closed');
    expect(harness.report).not.toHaveBeenCalled();
  });

  it('没有 reveal 时由成功 Promise 兜底收板', async () => {
    const api = currentApiMock(), pending = deferred();
    api.override('sessions.select', () => pending.promise);
    const harness = await mount();
    let selection!: void | Promise<void>;
    act(() => { selection = harness.controller.selectRef({ kind: 'session', sessionId: 'b' }); });
    await act(async () => { pending.resolve(); await selection; });
    expect(tool()).toBe('closed');
    expect(harness.reveal).not.toHaveBeenCalled();
  });

  it('同工作区主动选择新工具后，旧 reveal 与 Promise 不覆盖新选择', async () => {
    const api = currentApiMock(), pending = deferred();
    api.override('sessions.select', () => pending.promise);
    const harness = await mount();
    let selection!: void | Promise<void>;
    act(() => { selection = harness.controller.selectRef({ kind: 'session', sessionId: 'b' }); });
    fireEvent.click(screen.getByRole('button', { name: '切到统计' }));
    act(() => { api.emit('sessions:reveal', { sessionId: 'b' }); });
    expect(tool()).toBe('usage');
    await act(async () => { pending.resolve(); await selection; });
    expect(tool()).toBe('usage');
    expect(harness.reveal).not.toHaveBeenCalled();
  });

  it('reveal 已收板后用户打开新工具，迟到 Promise 不会再次收板', async () => {
    const api = currentApiMock(), pending = deferred();
    api.override('sessions.select', () => pending.promise);
    const harness = await mount();
    let selection!: void | Promise<void>;
    act(() => {
      selection = harness.controller.selectRef({ kind: 'session', sessionId: 'b' });
      api.emit('sessions:reveal', { sessionId: 'b' });
    });
    expect(tool()).toBe('closed');
    fireEvent.click(screen.getByRole('button', { name: '切到统计' }));
    await act(async () => { pending.resolve(); await selection; });
    expect(tool()).toBe('usage');
    expect(harness.reveal).toHaveBeenCalledTimes(1);
  });

  it('切区后迟到的 reveal 与 Promise 不收起新工作区工具', async () => {
    const api = currentApiMock(), pending = deferred();
    api.override('sessions.select', () => pending.promise);
    const harness = await mount();
    let selection!: void | Promise<void>;
    act(() => { selection = harness.controller.selectRef({ kind: 'session', sessionId: 'b' }); });
    harness.scope('workspace-b');
    fireEvent.click(screen.getByRole('button', { name: '切到统计' }));
    act(() => { api.emit('sessions:reveal', { sessionId: 'b' }); });
    await act(async () => { pending.resolve(); await selection; });
    expect(tool()).toBe('usage');
    expect(harness.reveal).not.toHaveBeenCalled();
  });

  it('切离再返回同一工作区，不重新启用旧在途请求', async () => {
    const api = currentApiMock(), pending = deferred();
    api.override('sessions.select', () => pending.promise);
    const harness = await mount();
    let selection!: void | Promise<void>;
    act(() => { selection = harness.controller.selectRef({ kind: 'session', sessionId: 'b' }); });
    harness.scope('workspace-b'); harness.scope('a');
    act(() => { api.emit('sessions:reveal', { sessionId: 'b' }); });
    await act(async () => { pending.resolve(); await selection; });
    expect(tool()).toBe('tasks');
    expect(harness.reveal).not.toHaveBeenCalled();
  });

  it('连续选择逆序回执时，仅最新选择的 reveal 收板', async () => {
    const api = currentApiMock(), first = deferred(), latest = deferred();
    api.override('sessions.select', id => id === 'b' ? first.promise : latest.promise);
    const harness = await mount();
    let b!: void | Promise<void>, c!: void | Promise<void>;
    act(() => {
      b = harness.controller.selectRef({ kind: 'session', sessionId: 'b' });
      c = harness.controller.selectRef({ kind: 'session', sessionId: 'c' });
      api.emit('sessions:reveal', { sessionId: 'b' });
    });
    expect(tool()).toBe('tasks');
    await act(async () => { first.resolve(); await b; });
    expect(tool()).toBe('tasks');
    act(() => { api.emit('sessions:reveal', { sessionId: 'c' }); });
    await act(async () => { latest.resolve(); await c; });
    expect(tool()).toBe('closed');
    expect(harness.reveal).toHaveBeenCalledTimes(1);
  });

  it('最新请求先完成后，旧请求迟到也不能收起后来打开的工具', async () => {
    const api = currentApiMock(), first = deferred(), latest = deferred();
    api.override('sessions.select', id => id === 'b' ? first.promise : latest.promise);
    const harness = await mount();
    let b!: void | Promise<void>, c!: void | Promise<void>;
    act(() => {
      b = harness.controller.selectRef({ kind: 'session', sessionId: 'b' });
      c = harness.controller.selectRef({ kind: 'session', sessionId: 'c' });
      api.emit('sessions:reveal', { sessionId: 'c' });
    });
    await act(async () => { latest.resolve(); await c; });
    fireEvent.click(screen.getByRole('button', { name: '切到统计' }));
    act(() => { api.emit('sessions:reveal', { sessionId: 'b' }); });
    await act(async () => { first.resolve(); await b; });
    expect(tool()).toBe('usage');
    expect(harness.reveal).toHaveBeenCalledTimes(1);
  });

  it('选择失败保留原工具并报告错误给 App', async () => {
    const api = currentApiMock(), pending = deferred(), failure = new Error('selection failed');
    api.override('sessions.select', () => pending.promise);
    const harness = await mount();
    let caught!: Promise<unknown>;
    act(() => {
      caught = Promise.resolve(harness.controller.selectRef({ kind: 'session', sessionId: 'b' })).catch(error => error);
    });
    await act(async () => { pending.reject(failure); await caught; });
    expect(await caught).toBe(failure);
    expect(tool()).toBe('tasks');
    expect(harness.report).toHaveBeenCalledExactlyOnceWith(failure);
  });

  it('非分屏请求的正常外部 reveal 仍显示会话，卸载会移除监听', async () => {
    const api = currentApiMock();
    const harness = await mount();
    act(() => { api.emit('sessions:reveal', { sessionId: 'external' }); });
    expect(tool()).toBe('closed');
    expect(harness.reveal).toHaveBeenCalledTimes(1);
    harness.view.unmount();
    act(() => { api.emit('sessions:reveal', { sessionId: 'external' }); });
    expect(harness.reveal).toHaveBeenCalledTimes(1);
  });
});
