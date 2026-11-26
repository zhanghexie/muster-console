import { describe, expect, it, vi } from 'vitest';
import { countFormChanges } from '../../src/renderer/src/components/settings/SettingsModal';
import type { AppConfig } from '../../src/shared/types';

describe('settings change detection', () => {
  it('skips serialization for shared values and still compares independently copied values', () => {
    const shared = { providers: [{ id: 'p', models: [{ id: 'm' }] }] } as unknown as AppConfig['llm'];
    const baseline = { llm: shared, defaultRuntime: 'pi' } as unknown as AppConfig;
    const draft = { llm: shared, defaultRuntime: 'claude' } as unknown as AppConfig;
    const stringify = vi.spyOn(JSON, 'stringify');
    try {
      expect(countFormChanges(draft, baseline)).toBe(1);
      expect(stringify.mock.calls.some(([value]) => value === shared)).toBe(false);
      expect(countFormChanges({ ...draft, llm: structuredClone(shared) }, baseline)).toBe(1);
      expect(countFormChanges({ ...draft, llm: { providers: [] } } as unknown as AppConfig, baseline)).toBe(2);
    } finally { stringify.mockRestore(); }
  });
});
