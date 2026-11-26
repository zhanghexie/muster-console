import { describe, expect, it } from 'vitest';
import { ProjectionManager } from '../../src/main/runtimeKernel/projectionManager';

function event(seq: number, value: number) {
  return { eventId: `event-${seq}`, sessionId: 'session', seq, type: 'counter', schemaVersion: 1, createdAt: seq, payload: value };
}

describe('ProjectionManager', () => {
  it('applies ordered events and ignores duplicate delivery', () => {
    const manager = new ProjectionManager();
    manager.register({ id: 'sum', initial: 0, apply: (value, item) => value + Number(item.payload) });
    expect(manager.apply(event(1, 2))).toEqual({ applied: true, lastAppliedSeq: 1 });
    expect(manager.apply(event(1, 2))).toEqual({ applied: false, lastAppliedSeq: 1 });
    expect(manager.apply(event(2, 3))).toEqual({ applied: true, lastAppliedSeq: 2 });
    expect(manager.snapshot<number>('sum')).toEqual({ value: 5, lastAppliedSeq: 2 });
  });

  it('rejects gaps and restores from a checkpoint', () => {
    const manager = new ProjectionManager();
    manager.register({ id: 'sum', initial: 0, apply: (value, item) => value + Number(item.payload) });
    expect(() => manager.apply(event(2, 2))).toThrow('expected seq 1');
    manager.checkpoint('sum', { value: 10, lastAppliedSeq: 4 });
    manager.apply(event(5, 3));
    expect(manager.snapshot<number>('sum')).toEqual({ value: 13, lastAppliedSeq: 5 });
  });

  it('rejects duplicate projection ids and unknown checkpoints', () => {
    const manager = new ProjectionManager();
    manager.register({ id: 'sum', initial: 0, apply: value => value });
    expect(() => manager.register({ id: 'sum', initial: 0, apply: value => value })).toThrow('already registered');
    expect(() => manager.snapshot('missing')).toThrow('not registered');
  });
});
