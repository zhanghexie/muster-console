import type { RefObject } from 'react';
import type { CenterPaneSlot } from '../../../shared/centerSplit';
import { usePaneFullscreen } from './usePaneFullscreen';

export function useCenterPaneFullscreen(identity: string, mainRef: RefObject<HTMLElement | null>) {
  const fullscreen = usePaneFullscreen<CenterPaneSlot>(identity, mainRef);
  return { slot: fullscreen.target, enter: fullscreen.enter, exit: fullscreen.exit };
}
