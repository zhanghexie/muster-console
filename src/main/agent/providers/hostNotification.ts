import { randomUUID } from 'node:crypto';
import { HOST_NOTIFICATION_CUSTOM_TYPE, HOST_NOTIFICATION_TRIGGER, type HostNotificationDelivery } from '../../../shared/hostNotification';
import type { PiSessionHandle } from '../../../shared/piEvents';

/** Native PI input, with a separate safe transcript projection. Never passes through prompt templates. */
export async function sendHostNotification(session: PiSessionHandle, delivery: HostNotificationDelivery,
  show: (summary: string, id: string) => void, triggerTurn: boolean, prefix = ''): Promise<boolean> {
  const batch = await delivery.prepare();
  if (!batch) return false;
  if (!session.sendCustomMessage) throw new Error('当前 PI 不支持宿主事件输入，请更新工作台');
  const id = `host-event-${randomUUID()}`;
  let receipt: Promise<void> | undefined;
  let consumed = false;
  let started = false;
  const off = session.subscribe(event => {
    const e = event as { type?: string; message?: { customType?: string; details?: { id?: string } } };
    if (triggerTurn && e.type === 'agent_start' && receipt && !started) {
      started = true;
      void Promise.resolve(receipt).then(() => delivery.started?.(batch))
        .catch(error => console.error('[host-notification] turn receipt failed', error));
    }
    if (e.type === 'message_end' && e.message?.customType === HOST_NOTIFICATION_CUSTOM_TYPE && e.message.details?.id === id && !receipt) {
      // SDK emits message_end immediately before its synchronous session-file append.
      receipt = Promise.resolve().then(() => {
        const entries = session.sessionManager?.getEntries?.();
        if (!entries) throw new Error('无法核验 PI 会话历史，未记录消费成功');
        if (!entries.some(entry => {
          const e = entry as { type?: string; customType?: string; details?: { id?: string } };
          return e.type === 'custom_message' && e.customType === HOST_NOTIFICATION_CUSTOM_TYPE && e.details?.id === id;
        })) throw new Error('宿主事件未写入 PI 会话，未记录消费成功');
        return delivery.accepted(batch);
      });
      // Attach a rejection handler immediately; the original is awaited below.
      void receipt.catch(error => console.error('[host-notification] context receipt failed', error));
    }
  });
  try {
    await session.sendCustomMessage({ customType: HOST_NOTIFICATION_CUSTOM_TYPE,
      content: batch.content, display: false,
      details: { id, summary: batch.summary } }, { triggerTurn: false });
    if (!receipt) throw new Error('PI 未确认宿主事件已进入上下文，未记录成功');
    await receipt;
    consumed = true;
    show(batch.summary, id);
    // prompt owns authentication, compaction and before_agent_start mode hooks.
    // sendCustomMessage(triggerTurn:true) bypasses those SDK preflight hooks.
    if (triggerTurn) await session.prompt(`${HOST_NOTIFICATION_TRIGGER}\n${prefix}\n处理本次宿主事件。`, { expandPromptTemplates: false });
    return true;
  } catch (error) {
    if (!consumed) await delivery.uncertain?.(batch, error);
    throw error;
  } finally { off(); }
}
