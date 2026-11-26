import type { EventEnvelope, SessionProjection } from './contracts';

export type ProjectionDefinition<T> = {
  id: string;
  initial: T;
  apply: (value: T, event: EventEnvelope) => T;
};

type ProjectionRecord<T> = {
  definition: ProjectionDefinition<T>;
  value: T;
  lastAppliedSeq: number;
};

/** Applies ordered session events to bounded, checkpointable derived state. */
export class ProjectionManager {
  private readonly projections = new Map<string, ProjectionRecord<unknown>>();

  register<T>(definition: ProjectionDefinition<T>): void {
    if (!definition.id.trim()) throw new Error('Projection id is required');
    if (this.projections.has(definition.id)) throw new Error(`Projection already registered: ${definition.id}`);
    this.projections.set(definition.id, {
      definition: definition as ProjectionDefinition<unknown>,
      value: definition.initial,
      lastAppliedSeq: 0
    });
  }

  apply(event: EventEnvelope): { applied: boolean; lastAppliedSeq: number } {
    let applied = false;
    let lastAppliedSeq = 0;
    for (const record of this.projections.values()) {
      if (event.seq <= record.lastAppliedSeq) {
        lastAppliedSeq = Math.max(lastAppliedSeq, record.lastAppliedSeq);
        continue;
      }
      if (event.seq !== record.lastAppliedSeq + 1) {
        throw new Error(`Projection ${record.definition.id} expected seq ${record.lastAppliedSeq + 1}, received ${event.seq}`);
      }
      record.value = record.definition.apply(record.value, event);
      record.lastAppliedSeq = event.seq;
      lastAppliedSeq = Math.max(lastAppliedSeq, record.lastAppliedSeq);
      applied = true;
    }
    return { applied, lastAppliedSeq };
  }

  checkpoint<T>(id: string, projection: SessionProjection<T>): void {
    const record = this.require<T>(id);
    if (!Number.isInteger(projection.lastAppliedSeq) || projection.lastAppliedSeq < 0) {
      throw new Error(`Projection ${id} checkpoint sequence is invalid`);
    }
    record.value = projection.value;
    record.lastAppliedSeq = projection.lastAppliedSeq;
  }

  snapshot<T>(id: string): SessionProjection<T> {
    const record = this.require<T>(id);
    return { value: record.value, lastAppliedSeq: record.lastAppliedSeq };
  }

  list(): Array<{ id: string; lastAppliedSeq: number }> {
    return [...this.projections.values()].map(record => ({ id: record.definition.id, lastAppliedSeq: record.lastAppliedSeq }));
  }

  private require<T>(id: string): ProjectionRecord<T> {
    const record = this.projections.get(id);
    if (!record) throw new Error(`Projection not registered: ${id}`);
    return record as ProjectionRecord<T>;
  }
}
