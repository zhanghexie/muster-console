/** Durable/live runtime contracts shared by scheduler, GUI workers and projections. */
export type EventEnvelope<T = unknown> = {
  eventId: string;
  sessionId: string;
  seq: number;
  type: string;
  schemaVersion: number;
  createdAt: number;
  causationId?: string;
  correlationId?: string;
  payload: T;
};

export type SessionRangeQuery = {
  fromSeq?: number;
  toSeq?: number;
  limit: number;
};

export type SessionProjection<T> = {
  value: T;
  lastAppliedSeq: number;
};

export type SessionHandleContract = {
  append(event: EventEnvelope): Promise<{ seq: number }>;
  readRange(query: SessionRangeQuery): Promise<EventEnvelope[]>;
  subscribeLive(listener: (event: EventEnvelope) => void): () => void;
  flush(reason: string): Promise<void>;
  fork(options?: { atSeq?: number }): Promise<{ sessionId: string }>;
};
