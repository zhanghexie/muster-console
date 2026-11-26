import type { IpcEventChannel, IpcEventMap } from '../shared/ipcEvents';

type NativeListener = (event: unknown, payload: unknown) => void;
interface EventSource {
  on(channel: string, listener: NativeListener): unknown;
  removeListener(channel: string, listener: NativeListener): unknown;
}

/** One native listener per channel, with independently disposable UI subscriptions. */
export function createIpcEventSubscriber(source: EventSource) {
  const channels = new Map<IpcEventChannel, {
    callbacks: Set<(payload: unknown) => void>;
    relay: NativeListener;
  }>();

  return <K extends IpcEventChannel>(channel: K, listener: (payload: IpcEventMap[K]) => void): (() => void) => {
    let entry = channels.get(channel);
    if (!entry) {
      const callbacks = new Set<(payload: unknown) => void>();
      const relay: NativeListener = (_event, payload) => {
        // Match EventEmitter: mutations during dispatch affect the next event only.
        for (const callback of [...callbacks]) callback(payload);
      };
      source.on(channel, relay);
      entry = { callbacks, relay };
      channels.set(channel, entry);
    }
    const subscription = entry;
    // A fresh wrapper preserves duplicate registrations of the same callback.
    const callback = (payload: unknown) => listener(payload as IpcEventMap[K]);
    subscription.callbacks.add(callback);
    return () => {
      if (!subscription.callbacks.delete(callback)) return;
      if (subscription.callbacks.size === 0) {
        source.removeListener(channel, subscription.relay);
        channels.delete(channel);
      }
    };
  };
}
