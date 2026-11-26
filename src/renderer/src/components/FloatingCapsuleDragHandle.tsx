import React from 'react';
import { IconDragHandle } from './icons';
import type { useCliComposerPlacement } from './useCliComposerPlacement';

type DragHandlers = Pick<ReturnType<typeof useCliComposerPlacement>,
  'onPointerDown' | 'onPointerMove' | 'onPointerUp' | 'onPointerCancel' | 'onLostPointerCapture'>;

/** 独立的拖动把手，避免展开和识屏按钮误触拖动。 */
export function FloatingCapsuleDragHandle({ label, handlers }: { label: string; handlers: DragHandlers }): React.JSX.Element {
  return <button type="button" className="cli-composer-drag" aria-label={label} title={label}
    onPointerDown={handlers.onPointerDown} onPointerMove={handlers.onPointerMove}
    onPointerUp={handlers.onPointerUp} onPointerCancel={handlers.onPointerCancel}
    onLostPointerCapture={handlers.onLostPointerCapture}><IconDragHandle size={12}/></button>;
}
