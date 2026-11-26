import React, { useRef } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { useSessionsPeekHover } from '../../src/renderer/src/components/useSessionsPeekHover';

it('速览详情 portal 进入时保活，内部移动不误收回，离开后恢复收回', () => {
  const enter = vi.fn(), leave = vi.fn();
  function Harness({ active = true }: { active?: boolean }) {
    const ref = useRef<HTMLDivElement>(null);
    useSessionsPeekHover(ref, active, enter, leave);
    return <><div ref={ref} data-testid="peek"/><div className="session-details-card" data-session-peek-owner="true" data-testid="card"><button>复制</button></div></>;
  }
  const { rerender } = render(<Harness />);
  const peek = screen.getByTestId('peek'), card = screen.getByTestId('card'), copy = screen.getByText('复制');
  fireEvent.pointerLeave(peek);
  expect(leave).toHaveBeenCalledTimes(1);
  fireEvent.pointerOver(card, { relatedTarget: peek });
  expect(enter).toHaveBeenCalledTimes(1);
  fireEvent.pointerOut(card, { relatedTarget: copy });
  expect(leave).toHaveBeenCalledTimes(1);
  fireEvent.pointerOut(copy, { relatedTarget: document.body });
  expect(leave).toHaveBeenCalledTimes(2);
  rerender(<Harness active={false}/>);
  fireEvent.pointerOver(card);
  expect(enter).toHaveBeenCalledTimes(1);
});
