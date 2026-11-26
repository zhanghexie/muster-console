import { render, act } from '@testing-library/react';
import { useScrollEdges } from '../../src/renderer/src/hooks/useScrollEdges';
import { vi, it, expect } from 'vitest';

it('fades only edges with hidden content and updates when content shrinks', () => {
  let resized = () => {};
  vi.stubGlobal('ResizeObserver', class {
    constructor(cb: () => void) { resized = cb; }
    observe() {} disconnect() {}
  });
  function Fixture() { return <div ref={useScrollEdges()}/>; }
  const { container, unmount } = render(<Fixture/>);
  const el = container.firstElementChild as HTMLDivElement;
  let height = 300;
  Object.defineProperties(el, {
    clientHeight: { value: 100 },
    scrollHeight: { get: () => height }
  });
  act(() => { resized(); });
  expect(el.dataset.fadeTop).toBe('false');
  expect(el.dataset.fadeBottom).toBe('true');
  act(() => { el.scrollTop = 80; el.dispatchEvent(new Event('scroll')); });
  expect(el.dataset.fadeTop).toBe('true');
  expect(el.dataset.fadeBottom).toBe('true');
  act(() => { el.scrollTop = 200; el.dispatchEvent(new Event('scroll')); });
  expect(el.dataset.fadeBottom).toBe('false');
  act(() => { height = 100; el.scrollTop = 0; resized(); });
  expect(el.dataset.fadeTop).toBe('false');
  expect(el.dataset.fadeBottom).toBe('false');
  unmount();
  vi.unstubAllGlobals();
});
