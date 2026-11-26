import { describe, expect, it } from 'vitest';
import { CapabilityRegistry } from '../../src/main/runtimeKernel/capabilityRegistry';

describe('CapabilityRegistry', () => {
  it('rejects duplicate or blank capability ids and exposes safe descriptors', () => {
    const registry = new CapabilityRegistry<() => void>();
    registry.register({ id: 'sessions.read', handler: () => {}, source: 'ipc', permission: 'sessions.read', auditTag: 'session-read' });
    expect(registry.list()).toEqual([{
      id: 'sessions.read',
      source: 'ipc',
      permission: 'sessions.read',
      auditTag: 'session-read'
    }]);
    expect(() => registry.register({ id: 'sessions.read', handler: () => {} })).toThrow('already registered');
    expect(() => registry.register({ id: '  ', handler: () => {} })).toThrow('id is required');
  });

  it('returns only registered handlers', () => {
    const registry = new CapabilityRegistry<(value: number) => number>();
    const handler = (value: number) => value + 1;
    registry.register({ id: 'math.increment', handler });
    expect(registry.get('math.increment')?.handler(4)).toBe(5);
    expect(registry.get('missing')).toBeUndefined();
    expect(registry.has('missing')).toBe(false);
  });
});
