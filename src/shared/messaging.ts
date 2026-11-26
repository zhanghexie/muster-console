export type MessagingChannelStatus = {
  key: string;
  label: string;
  supported: boolean;
  reason?: string;
};

export type MessagingStatus = {
  state: 'initializing' | 'ready' | 'failed';
  channels: MessagingChannelStatus[];
};

export type MessagingRpcResult =
  | { ok: true; value: unknown }
  | { ok: false; error: { code: string; message?: string; details?: Record<string, unknown> } };

/** Desktop settings only. Never exposed through the web or agent tool dispatchers. */
export interface MessagingService {
  start(): void;
  status(): MessagingStatus;
  invoke(channel: string, method: string, payload?: unknown, signal?: AbortSignal): Promise<unknown>;
  stopAdmission(): void;
  stopAndWait(): Promise<void>;
}
