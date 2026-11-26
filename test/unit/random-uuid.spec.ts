import { describe, expect, it, vi } from 'vitest';
import { randomUuid } from '../../src/shared/randomUuid';

const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('randomUuid', () => {
  it('uses native randomUUID when available', () => {
    const native = vi.spyOn(crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000000');
    try {
      expect(randomUuid()).toBe('00000000-0000-4000-8000-000000000000');
      expect(native).toHaveBeenCalledOnce();
    } finally {
      native.mockRestore();
    }
  });

  it('generates distinct UUIDv4 values using getRandomValues in plain HTTP', () => {
    const previous = Object.getOwnPropertyDescriptor(crypto, 'randomUUID');
    Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: undefined });
    const getRandomValues = vi.spyOn(crypto, 'getRandomValues');
    try {
      const ids = Array.from({ length: 32 }, () => randomUuid());
      expect(ids.every(id => uuidV4.test(id))).toBe(true);
      expect(new Set(ids).size).toBe(ids.length);
      expect(getRandomValues).toHaveBeenCalledTimes(ids.length);
    } finally {
      getRandomValues.mockRestore();
      if (previous) Object.defineProperty(crypto, 'randomUUID', previous);
      else Reflect.deleteProperty(crypto, 'randomUUID');
    }
  });

  it('fails explicitly instead of using weak randomness when Web Crypto is unavailable', () => {
    vi.stubGlobal('crypto', undefined);
    try {
      expect(() => randomUuid()).toThrow('Secure random number generation is unavailable');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
