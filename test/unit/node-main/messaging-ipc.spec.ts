import { afterEach, expect, it, vi } from 'vitest';
import type { AppContext } from '../../../src/main/context';

const fixture = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  disposers: [] as Array<() => void>,
  caller: { id: 'desktop:1', kind: 'desktop' }
}));
vi.mock('../../../src/main/ipc/handle', () => ({
  handle: (name: string, fn: (...args: any[]) => any) => fixture.handlers.set(name, fn),
  ipcCaller: () => fixture.caller,
  ownIpcResource: (fn: () => void) => fixture.disposers.push(fn)
}));
import { registerMessagingIpc } from '../../../src/main/ipc/messaging';
const frame = {}, event = { sender: { mainFrame: frame }, senderFrame: frame };
const call = (...args: any[]) => fixture.handlers.get('messaging:call')!(event, ...args);
afterEach(() => {
  for (const dispose of fixture.disposers) dispose();
  fixture.handlers.clear(); fixture.disposers.length = 0;
  fixture.caller = { id: 'desktop:1', kind: 'desktop' };
});

it('rejects remote callers and child frames before reading credentials or invoking channels', async () => {
  const invoke = vi.fn();
  registerMessagingIpc({ messaging: { invoke } } as unknown as AppContext);
  for (const caller of [{ id: 'web:1', kind: 'web' }, { id: 'desktop:1', kind: 'worker' }]) {
    fixture.caller = caller;
    await expect(call('slack', 'listBots', {})).rejects.toThrow('桌面设置');
  }
  fixture.caller = { id: 'desktop:1', kind: 'desktop' };
  await expect(fixture.handlers.get('messaging:call')!({ ...event, senderFrame: {} }, 'slack', 'listBots', {})).rejects.toThrow('桌面设置');
  expect(invoke).not.toHaveBeenCalled();
});

it('cancels the actual operation only for its owning renderer and drains on disposal', async () => {
  const signals: AbortSignal[] = [];
  const invoke = vi.fn((_channel, _method, _payload, signal: AbortSignal) => new Promise((_resolve, reject) => {
    signals.push(signal); signal.addEventListener('abort', () => reject(new Error('secret transport error')), { once: true });
  }));
  registerMessagingIpc({ messaging: { invoke } } as unknown as AppContext);
  const first = call('weixin', 'startLogin', {}, 'request-1');
  fixture.caller = { id: 'desktop:2', kind: 'desktop' };
  fixture.handlers.get('messaging:cancel')!(event, 'request-1');
  expect(signals[0].aborted).toBe(false);
  fixture.caller = { id: 'desktop:1', kind: 'desktop' };
  fixture.handlers.get('messaging:cancel')!(event, 'request-1');
  expect((await first).error.code).toBe('cancelled');
  const second = call('qq', 'startLogin', {}, 'request-2');
  fixture.disposers[0]();
  expect((await second).error.code).toBe('cancelled');
});

it('bounds arguments, deduplicates active request IDs and never leaks transport errors', async () => {
  let finish!: (value: unknown) => void;
  const invoke = vi.fn(() => new Promise(resolve => { finish = resolve; }));
  registerMessagingIpc({ messaging: { invoke } } as unknown as AppContext);
  await expect(call('../slack', 'listBots', {})).rejects.toThrow('参数');
  await expect(call('slack', 'listBots', 'x'.repeat(2 * 1024 * 1024))).rejects.toThrow('过大');
  const active = call('slack', 'listBots', {}, 'same');
  await expect(call('slack', 'listBots', {}, 'same')).rejects.toThrow('已在执行');
  finish({ ok: true, value: [] }); await active;
  invoke.mockImplementation(async () => { throw new Error('BOT_TOKEN=sensitive'); });
  const failure = await call('slack', 'listBots', {});
  expect(failure.error.code).toBe('operation-failed');
  expect(JSON.stringify(failure)).not.toContain('sensitive');
});
