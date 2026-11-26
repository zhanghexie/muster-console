/** Communication intent is shared; each connection owns its delivery mechanism. */
export interface RuntimeMessage {
  intent: 'normal' | 'interrupt';
  text: string;
  messageId: string;
  /** Host wake notices must not enter a queue behind an already running turn. */
  idleOnly?: boolean;
  /** Internal host event, never a user prompt or an authorization source. */
  hostNotification?: boolean;
}

export type RuntimeDeliveryMethod = 'sent' | 'steered' | 'queued' | 'stopped-and-sent' | 'written';
export type RuntimeDeliveryResult =
  | { status: 'accepted'; method: RuntimeDeliveryMethod }
  /** Not submitted; retry is safe after the reported condition changes. */
  | { status: 'deferred'; reason: string }
  /** Unsupported guarantees no input was submitted; only this permits fallback. */
  | { status: 'unsupported'; reason: string };

/** Invalid/uncertain acknowledgements must never silently trigger another transport. */
export function parseRuntimeDeliveryResult(value: unknown): RuntimeDeliveryResult {
  const r = value as Partial<RuntimeDeliveryResult> | null;
  if (r?.status === 'accepted' && ['sent', 'steered', 'queued', 'stopped-and-sent', 'written'].includes(r.method ?? ''))
    return { status: 'accepted', method: r.method! };
  if ((r?.status === 'unsupported' || r?.status === 'deferred') && typeof r.reason === 'string' && r.reason.trim())
    return { status: r.status, reason: r.reason.slice(0, 500) };
  throw new Error('通信接入返回了无效回执；投递状态未知，未自动切换通道');
}
