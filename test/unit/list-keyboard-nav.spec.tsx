import React, { useState } from 'react';
import { render } from '@testing-library/react';
import { expect, it, vi, afterEach } from 'vitest';
import { useListKeyboardNav } from '../../src/renderer/src/hooks/useListKeyboardNav';

function Probe({ pauseReveal }: { pauseReveal: boolean }): React.JSX.Element {
  const [selected, setSelected] = useState('a');
  const nav = useListKeyboardNav({ items: ['a', 'b'], selectedId: selected, onSelect: setSelected, pauseReveal });
  return <div>{['a', 'b'].map(id => <button key={id} data-id={id} {...nav.getItemProps(id)}>{id}</button>)}</div>;
}

it('工作区过场暂停活动行自动滚动，解除后补一次 reveal', () => {
  const original = HTMLElement.prototype.scrollIntoView;
  const scroll = vi.fn();
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scroll });
  try {
    const view = render(<Probe pauseReveal />);
    expect(scroll).not.toHaveBeenCalled();
    view.rerender(<Probe pauseReveal={false} />);
    expect(scroll).toHaveBeenCalledTimes(1);
  } finally {
    if (original) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: original });
    else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
  }
});

afterEach(() => vi.restoreAllMocks());
