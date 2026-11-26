import { afterEach, expect, it, vi } from 'vitest';
import { inspectBrowserSurface } from '../../src/renderer/src/browserSurfaceAncestors';

afterEach(() => { vi.restoreAllMocks(); document.body.innerHTML = ''; });

it('intersects the padding boxes of rectangular clipping ancestors', () => {
  const parent = document.createElement('div'), target = document.createElement('div');
  document.body.append(parent); parent.append(target);
  const rect = (x: number, y: number, width: number, height: number) => ({ x, y, width, height, top: y, left: x, right: x + width, bottom: y + height, toJSON: () => ({}) });
  vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 200, 100));
  vi.spyOn(parent, 'getBoundingClientRect').mockReturnValue(rect(20, 10, 100, 70));
  for (const [name, value] of Object.entries({ offsetWidth: 100, offsetHeight: 70, clientWidth: 100, clientHeight: 70, clientLeft: 0, clientTop: 0 })) {
    Object.defineProperty(parent, name, { configurable: true, value });
  }
  const original = window.getComputedStyle;
  vi.spyOn(window, 'getComputedStyle').mockImplementation(element => {
    const base = original.call(window, element);
    if (element !== parent) return base;
    return new Proxy(base, { get: (object, key) => ({ overflowX: 'hidden', overflowY: 'hidden',
      borderTopLeftRadius: '0px', borderTopRightRadius: '0px', borderBottomLeftRadius: '0px', borderBottomRightRadius: '0px' } as Record<PropertyKey, unknown>)[key] ?? Reflect.get(object, key) });
  });
  expect(inspectBrowserSurface(target)).toEqual({ kind: 'visible', inset: { top: 10, right: 80, bottom: 20, left: 20 } });
  vi.mocked(parent.getBoundingClientRect).mockReturnValue(rect(20, 10, 200, 140));
  vi.mocked(target.getBoundingClientRect).mockReturnValue(rect(0, 0, 300, 200));
  expect(inspectBrowserSurface(target)).toEqual({ kind: 'visible', inset: { top: 10, right: 80, bottom: 50, left: 20 } });
});

it('fails closed for rounded, masked and non-axis-aligned ancestors', () => {
  const parent = document.createElement('div'), target = document.createElement('div');
  document.body.append(parent); parent.append(target);
  let overrides: Record<string, string> = {};
  const original = window.getComputedStyle;
  vi.spyOn(window, 'getComputedStyle').mockImplementation(element => {
    const base = original.call(window, element);
    return element !== parent ? base : new Proxy(base, { get: (object, key) => overrides[String(key)] ?? Reflect.get(object, key) });
  });
  overrides = { overflowX: 'hidden', borderTopLeftRadius: '4px', borderTopRightRadius: '0px', borderBottomLeftRadius: '0px', borderBottomRightRadius: '0px' };
  expect(inspectBrowserSurface(target)).toEqual({ kind: 'unsupported' });
  overrides = { clipPath: 'circle(50%)' }; expect(inspectBrowserSurface(target)).toEqual({ kind: 'unsupported' });
  overrides = { transform: 'matrix(0, 1, -1, 0, 0, 0)' }; expect(inspectBrowserSurface(target)).toEqual({ kind: 'unsupported' });
  overrides = { opacity: '0' }; expect(inspectBrowserSurface(target)).toEqual({ kind: 'hidden' });
  target.remove(); expect(() => inspectBrowserSurface(target)).toThrow(/disconnected/);
});
