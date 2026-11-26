import { createDesktopDeliverySelector } from './desktopDeliverySelector';

/**
 * The common host invocation already binds actor, turn, target and visible
 * indicator. Engines lacking a native read receipt may still execute; this
 * selector deliberately records no claim of model consumption.
 */
export function createLocalDesktopDeliverySelector() {
  return createDesktopDeliverySelector([{
    hasScope: () => true,
    cua: (_request, context) => ({ ...context, stageDelivery() {} }),
    win32: (_actor, context) => ({ ...context, stageDelivery() {} })
  }]);
}
