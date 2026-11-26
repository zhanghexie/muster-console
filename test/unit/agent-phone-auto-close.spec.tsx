import { act, renderHook } from '@testing-library/react';
import { useAgentPhone, PHONE_AUTO_KEY } from '../../src/renderer/src/agentApps/useAgentPhone';
import type { AppOperation } from '../../src/shared/agentApps';
import { currentApiMock } from './helpers/api-mock';

const operation = (patch: Partial<AppOperation> = {}): AppOperation => ({
  workspaceId: 'one', agentId: 'orchestrator:one', actor: 'agent', runId: 'turn1',
  operationId: 'op1', sequence: 1, appId: 'tasks', commandId: 'list', title: '读取待办',
  phase: 'running', at: 1, viewId: 'main', ...patch
});
const emit = (patch: Partial<AppOperation> = {}) => act(() => currentApiMock().emit('agentApps:operation', operation(patch)));
const tick = async (ms = 3000) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

beforeEach(() => { localStorage.removeItem(PHONE_AUTO_KEY); vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

it.each(['succeeded', 'failed', 'cancelled'] as const)('自动打开等操作 %s 后收回，同轮新操作仍可再次打开', async phase => {
  const { result } = renderHook(() => useAgentPhone('one'));
  emit(); await tick();
  expect(result.current.state.open).toBe(true);
  expect(result.current.state.openedBy).toBe('agent');
  emit({ sequence: 2, phase }); await tick(600);
  expect(result.current.state.open).toBe(true); // Final result gets reading time.
  await tick(); expect(result.current.state.open).toBe(false);
  expect(result.current.state.openedBy).toBeNull();
  emit({ operationId: 'op2', sequence: 3 }); await tick();
  expect(result.current.state.open).toBe(true);
});

it('用户打开后跟随调度仍保留用户来源，关闭再自动打开重新记来源', async () => {
  const { result } = renderHook(() => useAgentPhone('one'));
  act(() => result.current.controller.open());
  emit({ phase: 'succeeded' }); await tick();
  expect(result.current.state.open).toBe(true);
  expect(result.current.state.openedBy).toBe('user');
  act(() => result.current.controller.close());
  emit({ operationId: 'op2', runId: 'turn2', sequence: 2, phase: 'succeeded' });
  await tick(200); expect(result.current.state.openedBy).toBe('agent');
  await tick(); expect(result.current.state.open).toBe(false);
});

it.each(['browse', 'edit'] as const)('自动展开后人工 %s 接管，旧收回计时器不能关闭手机', async action => {
  const { result } = renderHook(() => useAgentPhone('one'));
  emit({ phase: 'succeeded' }); await tick(200);
  act(() => action === 'browse' ? result.current.controller.manual({ appId: 'tasks' }) : result.current.controller.interact(true));
  await tick(); expect(result.current.state.open).toBe(true);
  expect(result.current.state.openedBy).toBe('user');
});

it('并发旧操作仍运行时不提前关闭，迟到完成不抢回页面但会释放收回条件', async () => {
  const { result } = renderHook(() => useAgentPhone('one'));
  emit(); await tick(200);
  emit({ operationId: 'op2', sequence: 2, appId: 'rss', phase: 'succeeded' }); await tick();
  expect(result.current.state.open).toBe(true);
  emit({ sequence: 3, phase: 'succeeded' }); await tick(600);
  expect(result.current.state.route.appId).toBe('rss');
  await tick(); expect(result.current.state.open).toBe(false);
});

it('收回等待期有新操作时取消旧计时，主动关闭仍抑制同轮重开', async () => {
  const { result } = renderHook(() => useAgentPhone('one'));
  emit({ phase: 'succeeded' }); await tick(800);
  emit({ operationId: 'op2', sequence: 2 }); await tick();
  expect(result.current.state.open).toBe(true);
  act(() => result.current.controller.close());
  emit({ operationId: 'op2', sequence: 3, phase: 'succeeded' });
  emit({ operationId: 'op3', sequence: 4 }); await tick();
  expect(result.current.state.open).toBe(false);
});

it('切换工作区期间收到完成回执，返回后仍能收回且不会串到别的工作区', async () => {
  const { result, rerender } = renderHook(({ id }) => useAgentPhone(id), { initialProps: { id: 'one' } });
  emit(); await tick(200);
  rerender({ id: 'two' });
  emit({ sequence: 2, phase: 'succeeded' }); await tick();
  expect(result.current.state.open).toBe(false);
  rerender({ id: 'one' }); await tick();
  expect(result.current.state.open).toBe(false);
});

it('关闭自动展示后仍处理既有操作的完成回执', async () => {
  const { result } = renderHook(() => useAgentPhone('one'));
  emit(); await tick(200);
  act(() => result.current.setAuto(false));
  await tick(); expect(result.current.state.open).toBe(true);
  emit({ sequence: 2, phase: 'succeeded' }); await tick();
  expect(result.current.state.open).toBe(false);
});
