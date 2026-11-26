/** Model input and human transcript are separate projections of one durable event. */
export const HOST_NOTIFICATION_CUSTOM_TYPE = 'muster.host-notification';
export const HOST_NOTIFICATION_TRIGGER = '[muster:host-notification]';
export interface HostNotificationContent {
  summary: string;
  content: string;
}
export interface HostNotificationBatch extends HostNotificationContent {
  ids: string[];
}
/** Host-private desktop continuation evidence; never serialized into engine input. */
export interface HostDesktopContinuationOrigin {
  readonly owner: string;
  readonly workspaceId: string;
  readonly stopGeneration: number;
}
export interface HostDesktopContinuation {
  allows(origin: HostDesktopContinuationOrigin): boolean;
  /** Pending source persistence may delay desktop use, never the host message itself. */
  pending?(): boolean;
  ready?(): Promise<void>;
}
/** Internal-only callback, never accepted through renderer/tool send arguments. */
export interface HostNotificationDelivery {
  /** Host owner cancellation; never supplied by a model or renderer. */
  readonly signal?: AbortSignal;
  /** Optional private source guard for a continuation-triggered desktop turn. */
  readonly desktopContinuation?: HostDesktopContinuation;
  /** Synchronous host-only guard immediately before a native interjection. */
  beforeSubmit?(): void;
  prepare(): HostNotificationBatch | null | Promise<HostNotificationBatch | null>;
  /** Called after native context persistence is verified; this callback persists host receipts and may still fail. */
  accepted(batch: HostNotificationBatch): void | Promise<void>;
  /** Optional receipt for an actual new Pi turn; admission/context insertion is earlier. */
  started?(batch: HostNotificationBatch): void | Promise<void>;
  uncertain?(batch: HostNotificationBatch, error: unknown): void | Promise<void>;
  settled?(): void;
}
export interface HostNotificationRef {
  kind: 'app' | 'event';
  appId?: string;
  eventId?: string;
}
export function isHostNotification(m: { from?: string; to?: string; meta?: { hostNotification?: HostNotificationRef; notificationKey?: string; subscriptionIds?: string[]; eventId?: string } }): boolean {
  return m.from === 'host' && (!m.to || m.to === 'scheduler' || m.to.startsWith('orchestrator:')) &&
    (!!m.meta?.hostNotification || !!m.meta?.notificationKey?.startsWith('app:') || !!(m.meta?.eventId && m.meta.subscriptionIds));
}
