import type { ReadMailPresentation } from './mailReadPresentation';

/** Host-owned presentation data. It is never a model message or tool result. */
export type DisplayItemPayload = { kind: 'mail'; pages: ReadMailPresentation[] };
export type DisplayItem = DisplayItemPayload & { id: string; anchorPartIndex: number };
export type DisplayItemSink = (payload: DisplayItemPayload) => boolean;
