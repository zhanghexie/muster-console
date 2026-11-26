import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

const exists = vi.spyOn(fs, 'existsSync');
import { resolveRuntimeBuiltinsDir } from '../../src/main/runtime/host';

describe('runtime builtin directory resolution', () => {
  it('uses the source registry only for an un-packaged dev fallback', () => {
    exists.mockImplementation((target) => /src[\\/]registry\.json$/.test(String(target)));
    expect(resolveRuntimeBuiltinsDir('out/runtime', 'src', true)).toBe('src');
    expect(resolveRuntimeBuiltinsDir('out/runtime', 'src', false)).toBe('out/runtime');
  });

  it('prefers the bundled registry when it is present', () => {
    exists.mockImplementation((target) => /out[\\/]runtime[\\/]registry\.json$/.test(String(target)));
    expect(resolveRuntimeBuiltinsDir('out/runtime', 'src', true)).toBe('out/runtime');
  });
});
