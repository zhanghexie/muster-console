import { createDesktopEngineDeliverySelector } from './desktopEngineDelivery';
import { createLocalDesktopDeliverySelector } from './localDesktopDeliverySelector';
import type { createDesktopDeliverySelector } from './desktopDeliverySelector';
import type { GlobalDesktopComposition } from './globalDesktopComposition';
import { PtyDesktopTurns } from './ptyDesktopTurns';
import type { Win32TargetRegistry } from './win32TargetRegistry';
import { Win32VisibleRuntime } from './win32VisibleRuntime';

type RuntimeOptions = ConstructorParameters<typeof Win32VisibleRuntime>[0];
type Selector = ReturnType<typeof createDesktopDeliverySelector>;
type Composition = Pick<GlobalDesktopComposition, 'dispatcher' | 'close'> & Partial<Pick<GlobalDesktopComposition, 'desktopEngineDelivery'>>;

export interface Win32DesktopHostOptions extends Omit<RuntimeOptions, 'dispatcher' | 'selector' | 'targets'> {
  composition: Composition;
  createTargets(): Win32TargetRegistry;
  /** Tests can provide an isolated engine delivery scope. */
  selector?: Selector;
}

/**
 * One host-owned Windows seat and one durable receipt owner. Construction
 * does not expose a legacy desktop writer; the caller supplies the receipt
 * composition and installs all returned bindings together. Independent engine
 * delivery evidence is optional and is never invented by this host.
 */
export function createWin32DesktopHost(options: Win32DesktopHostOptions) {
  if (!options || typeof options.createTargets !== 'function' || typeof options.composition?.dispatcher?.run !== 'function' ||
      (options.composition.desktopEngineDelivery !== undefined && typeof options.composition.desktopEngineDelivery !== 'function') ||
      typeof options.composition.close !== 'function') {
    throw new Error('Windows desktop host dependencies are unavailable');
  }
  const { composition, createTargets, selector, ...runtimeOptions } = options;
  let closed = false;
  let targets: Win32TargetRegistry | undefined;
  let closing: Promise<void> | undefined;
  const assertOpen = (): void => { if (closed) throw new Error('Windows desktop host is closed'); };
  const getTargets = (): Win32TargetRegistry => {
    assertOpen();
    return targets ??= createTargets();
  };
  const runtime = new Win32VisibleRuntime({ ...runtimeOptions, dispatcher: composition.dispatcher,
    selector: selector ?? (composition.desktopEngineDelivery ? createDesktopEngineDeliverySelector() : createLocalDesktopDeliverySelector()), targets: getTargets });
  const ptyTurns = new PtyDesktopTurns(runtime.activity.turns);
  return Object.freeze({
    desktopTurns: () => { assertOpen(); return runtime.activity.turns; },
    desktopPtyTurns: () => { assertOpen(); return ptyTurns; },
    desktopTargets: getTargets,
    desktopVisibleControl: () => { assertOpen(); return runtime.windowsControl(); },
    desktopSemanticControl: () => { assertOpen(); return runtime.semanticControl(); },
    desktopAppDiscovery: () => { assertOpen(); return runtime.appDiscovery(); },
    desktopWindowList: () => { assertOpen(); return runtime.windowList(); },
    ...(composition.desktopEngineDelivery ? { desktopEngineDelivery: () => { assertOpen(); return composition.desktopEngineDelivery!(); } } : {}),
    visibilityEpoch: () => closed ? undefined : runtime.activity.visibilityEpoch(),
    close(): Promise<void> {
      if (closing) return closing;
      closed = true;
      closing = (async () => {
        const errors: unknown[] = [];
        // Stop input and reap drivers while the indicator remains available;
        // only then retire target markers and close persistent receipts.
        // If runtime cleanup is unconfirmed, neither target identity nor the
        // durable authority may be discarded underneath a possible executor.
        try { await runtime.dispose(); }
        catch (error) { throw new Error('Windows desktop runtime cleanup is unconfirmed; target and delivery authority remain open', { cause: error }); }
        try { targets?.close(); } catch (error) { errors.push(error); }
        try { await composition.close(); } catch (error) { errors.push(error); }
        if (errors.length) throw new AggregateError(errors, 'Windows desktop host cleanup failed');
      })();
      return closing;
    }
  });
}
