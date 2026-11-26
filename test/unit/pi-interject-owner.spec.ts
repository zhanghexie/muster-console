import { describe, expect, it, vi } from 'vitest';
import { interjectHostNotification } from '../../src/main/agentSession/piInterject';

type NativeMessage = { customType: string; details: { id: string } };
function engine() {
  let listener: ((event: unknown) => void) | undefined;
  let message: NativeMessage;
  const off = vi.fn(() => { listener = undefined; });
  const session = { isStreaming: true, subscribe(callback: (event: unknown) => void) { listener = callback; return off; },
    sendCustomMessage: vi.fn(async (value: NativeMessage) => { message = value; }),
    sessionManager: { getEntries: () => [{ type: 'custom_message', customType: message.customType, details: message.details }] } };
  return { session: session as unknown as Parameters<typeof interjectHostNotification>[0],
    listener: () => listener, message: () => message, sent: session.sendCustomMessage, off };
}

describe('native subscription owner cancellation', () => {
  it('unsubscribes an aborted admission and rejects late receipt callbacks', async () => {
    const f = engine(), controller = new AbortController(), accepted = vi.fn(), shown = vi.fn();
    const pending = interjectHostNotification(f.session, { signal: controller.signal,
      prepare: () => ({ ids: ['event'], summary: 'event', content: 'input' }), accepted }, () => true, shown);
    await vi.waitFor(() => expect(f.sent).toHaveBeenCalledOnce());
    const staleListener = f.listener()!;
    const rejected = expect(pending).rejects.toThrow('投递状态未知');
    controller.abort(); await rejected;
    expect(f.off).toHaveBeenCalledOnce(); expect(f.listener()).toBeUndefined();
    staleListener({ type: 'message_end', message: f.message() });
    await Promise.resolve(); await Promise.resolve();
    expect(accepted).not.toHaveBeenCalled(); expect(shown).not.toHaveBeenCalled();
  });

  it('drains a receipt write already started before abort without showing a late notification', async () => {
    const f = engine(), controller = new AbortController(), shown = vi.fn();
    let release!: () => void;
    const accepted = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
    const pending = interjectHostNotification(f.session, { signal: controller.signal,
      prepare: () => ({ ids: ['event'], summary: 'event', content: 'input' }), accepted }, () => true, shown);
    await vi.waitFor(() => expect(f.sent).toHaveBeenCalledOnce());
    f.listener()!({ type: 'message_end', message: f.message() });
    await vi.waitFor(() => expect(accepted).toHaveBeenCalledOnce());
    let settled = false; void pending.then(() => { settled = true; });
    controller.abort(); await Promise.resolve(); expect(settled).toBe(false);
    release(); expect(await pending).toBe(true);
    expect(f.off).toHaveBeenCalledOnce(); expect(shown).not.toHaveBeenCalled();
  });
});
