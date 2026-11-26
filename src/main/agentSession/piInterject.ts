import { randomUUID } from 'node:crypto';
import { HOST_NOTIFICATION_CUSTOM_TYPE, type HostNotificationDelivery } from '../../shared/hostNotification';
import type { PiSessionHandle } from '../../shared/piEvents';

/** Generic Pi preemption channel: confirm the exact hidden message in native history. */
export async function interjectHostNotification(session: Pick<PiSessionHandle, 'sendCustomMessage' | 'isStreaming' | 'subscribe' | 'sessionManager'>, delivery: HostNotificationDelivery,
  stillBusy: () => boolean, show: (summary: string, id: string) => void): Promise<boolean> {
  if (delivery.signal?.aborted || !session.sendCustomMessage || session.isStreaming !== true || !stillBusy()) return false;
  const batch = await delivery.prepare();
  if (!batch || session.isStreaming !== true || !stillBusy()) return false;
  const id = `host-event-${randomUUID()}`;
  return new Promise<boolean>((resolve, reject) => {
    let settled = false, receiptStarted = false;
    let off = (): void => {};
    const onAbort = (): void => { if (!receiptStarted) { if (submitted) uncertain('宿主已停止接入'); else finish(false); } };
    const cleanup = (): void => { off(); delivery.signal?.removeEventListener('abort', onAbort); };
    const finish = (value: boolean) => { if (!settled) { settled = true; cleanup(); resolve(value); } };
    const uncertain = (cause: unknown) => {
      if (settled) return;
      settled = true; cleanup();
      reject(new Error(`Pi 插话回执缺失，投递状态未知：${cause instanceof Error ? cause.message : String(cause)}`));
    };
    let submitted = false;
    off = session.subscribe(event => {
      const e = event as { type?: string; message?: { customType?: string; details?: { id?: string } } };
      if (e.type === 'message_end' && e.message?.customType === HOST_NOTIFICATION_CUSTOM_TYPE && e.message.details?.id === id && !receiptStarted) {
        receiptStarted = true;
        void Promise.resolve().then(async () => {
          if (settled || delivery.signal?.aborted) { uncertain('宿主已停止接入'); return; }
          const entries = session.sessionManager?.getEntries?.();
          if (!entries) throw new Error('无法核验 PI 会话历史');
          if (!entries.some(entry => {
            const item = entry as { type?: string; customType?: string; details?: { id?: string } };
            return item.type === 'custom_message' && item.customType === HOST_NOTIFICATION_CUSTOM_TYPE && item.details?.id === id;
          })) throw new Error('插话未写入 PI 会话');
          await delivery.accepted(batch); if (!delivery.signal?.aborted && stillBusy()) show(batch.summary, id); finish(true);
        }).catch(error => { cleanup(); settled = true; reject(error); });
      } else if (e.type === 'agent_end' && !receiptStarted) {
        if (submitted) uncertain('回合已结束'); else finish(false);
      }
    });
    if (settled) { cleanup(); return; }
    delivery.signal?.addEventListener('abort', onAbort, { once: true });
    if (delivery.signal?.aborted || session.isStreaming !== true || !stillBusy()) { finish(false); return; }
    try {
      delivery.beforeSubmit?.();
      if (settled || delivery.signal?.aborted) return;
      submitted = true;
      Promise.resolve(session.sendCustomMessage!({ customType: HOST_NOTIFICATION_CUSTOM_TYPE, content: batch.content,
        display: false, details: { id, summary: batch.summary } }, { triggerTurn: true, deliverAs: 'steer' }))
        .catch(uncertain);
    } catch (error) { uncertain(error); }
  });
}
