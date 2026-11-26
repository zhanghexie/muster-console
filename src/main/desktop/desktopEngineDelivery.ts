import { hasSchedulerPiDesktopDeliveryScope, captureSchedulerPiCuaDeliverySlot, captureSchedulerPiWin32DeliverySlot } from '../agent/schedulerPiDelivery';
import { hasCodexDesktopDeliveryScope, captureCodexCuaDeliverySlot, captureCodexWin32DeliverySlot } from '../agentSession/drivers/codex/desktopDelivery';
import { hasGuiPiDesktopDeliveryScope, captureGuiPiCuaDeliverySlot, captureGuiPiWin32DeliverySlot } from '../agentSession/drivers/pi/desktopDelivery';
import { createDesktopDeliverySelector } from './desktopDeliverySelector';

/** Only engines with a verified private delivery tracker may stage desktop writes. */
export function createDesktopEngineDeliverySelector() {
  return createDesktopDeliverySelector([
    { hasScope: hasCodexDesktopDeliveryScope, cua: captureCodexCuaDeliverySlot, win32: captureCodexWin32DeliverySlot },
    { hasScope: hasGuiPiDesktopDeliveryScope, cua: captureGuiPiCuaDeliverySlot, win32: captureGuiPiWin32DeliverySlot },
    { hasScope: hasSchedulerPiDesktopDeliveryScope, cua: captureSchedulerPiCuaDeliverySlot, win32: captureSchedulerPiWin32DeliverySlot }
  ]);
}
