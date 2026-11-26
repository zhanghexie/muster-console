import React, { useRef } from 'react';
import { render, waitFor } from '@testing-library/react';
import { rememberQueuedHandover, useQueuedHandoverPlacement } from '../../src/renderer/src/panels/freeCanvas/useQueuedHandoverPlacement';
import type { FreeCanvasHandle } from '../../src/renderer/src/panels/freeCanvas/types';

it('排队交接出队后按原落点连线，重新挂载不会重复落位', async () => {
  localStorage.clear();
  const place = vi.fn();
  expect(rememberQueuedHandover({ id: 'new', from: 'source', port: 'e', world: { x: 80, y: 120 } })).toBe(true);
  function Fixture({ ids }: { ids: string[] }) {
    const canvas = useRef({ placeSession: place } as unknown as FreeCanvasHandle);
    useQueuedHandoverPlacement(ids.map(id => ({ id })), canvas);
    return null;
  }
  const view = render(<Fixture ids={['source']} />);
  expect(place).not.toHaveBeenCalled();
  view.rerender(<Fixture ids={['source', 'new']} />);
  await waitFor(() => expect(place).toHaveBeenCalledWith('new', { x: 80, y: 120 }, { id: 'source', port: 'e', kind: 'handover' }));
  view.unmount();
  render(<Fixture ids={['source', 'new']} />);
  expect(place).toHaveBeenCalledTimes(1);
});
