import React from 'react';
import { dispatchPeekPointer } from '../browserPointer';

export function PeekPointerShield({ className }: { className: string }): React.JSX.Element {
  return <div className={className} aria-hidden
    onPointerMove={event => dispatchPeekPointer('move', event.currentTarget)}
    onPointerDown={event => {
      if (event.button !== 0) return;
      event.preventDefault();
      dispatchPeekPointer('down', event.currentTarget);
    }}/>;
}
