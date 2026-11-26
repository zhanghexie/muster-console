import { randomUUID } from 'node:crypto';
import type { IpcMainInvokeEvent } from 'electron';
import type { AppContext } from '../context';
import { handle, ipcCaller, ownIpcResource } from './handle';

function desktopCaller(event: IpcMainInvokeEvent): string {
  const caller = ipcCaller(event);
  if (caller.kind && caller.kind !== 'desktop' || !caller.id.startsWith('desktop:') ||
      event.senderFrame && event.sender.mainFrame && event.senderFrame !== event.sender.mainFrame) {
    throw new Error('消息渠道账号管理仅允许在桌面设置中操作。');
  }
  return caller.id;
}

export function registerMessagingIpc(ctx: AppContext): void {
  const requests = new Map<string, AbortController>();
  ownIpcResource(() => { for (const request of requests.values()) request.abort(); });
  handle('messaging:status', event => {
    desktopCaller(event);
    return ctx.messaging?.status() ?? { state: 'initializing', channels: [] };
  });
  handle('messaging:call', async (event, channel: string, method: string, payload: unknown, requestId?: string) => {
    const caller = desktopCaller(event);
    if (typeof channel !== 'string' || !/^[a-z][a-z0-9-]{0,40}$/.test(channel) ||
        typeof method !== 'string' || !/^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(method) ||
        requestId !== undefined && (typeof requestId !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(requestId))) {
      throw new Error('消息渠道请求参数无效。');
    }
    let serialized: string;
    try { serialized = JSON.stringify(payload ?? null); }
    catch { throw new Error('消息渠道请求参数无效。'); }
    if (serialized.length > 2 * 1024 * 1024 || requests.size >= 64) throw new Error('消息渠道请求过大或繁忙，请稍后重试。');
    const service = channel === 'channels' ? ctx.messagingChannels : ctx.messaging;
    if (!service) return { ok: false, error: { code: 'initializing', message: '消息渠道正在初始化。' } };
    const key = `${caller}:${requestId ?? randomUUID()}`;
    if (requests.has(key)) throw new Error('消息渠道请求已在执行。');
    const controller = new AbortController();
    requests.set(key, controller);
    try {
      return channel === 'channels' ? await ctx.messagingChannels!.invoke(method, payload, controller.signal)
        : await ctx.messaging!.invoke(channel, method, payload, controller.signal);
    }
    catch { return { ok: false, error: { code: controller.signal.aborted ? 'cancelled' : 'operation-failed', message: controller.signal.aborted ? '操作已取消。' : '消息渠道操作失败，请查看渠道状态后重试。' } }; }
    finally { requests.delete(key); }
  });
  handle('messaging:cancel', (event, requestId: string) => {
    const caller = desktopCaller(event);
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(requestId)) throw new Error('消息渠道请求编号无效。');
    requests.get(`${caller}:${requestId}`)?.abort();
    return { ok: true };
  });
}
