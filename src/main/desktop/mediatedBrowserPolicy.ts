/**
 * Host-owned classification of the actual browser handler, after run routing.
 * This is a policy plan only: it does not grant access or identify a tab/recording.
 */
export interface BrowserMediationPlan {
  target: 'none' | 'tab' | 'new-page' | 'profile' | 'recording';
  contentRead: boolean;
  pixelRead: boolean;
  unknownEffect: boolean;
  /** Cleanup must remain possible even if disclosure of its resulting artifact is denied. */
  cleanup: boolean;
}

const plan = (target: BrowserMediationPlan['target'], fields: Partial<Omit<BrowserMediationPlan, 'target'>> = {}): BrowserMediationPlan =>
  ({ target, contentRead: false, pixelRead: false, unknownEffect: false, cleanup: false, ...fields });

export function classifyMediatedBrowserOperation(name: string, args: Readonly<Record<string, unknown>>): BrowserMediationPlan {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Invalid browser mediation arguments');
  switch (name) {
    case 'browser.tabs': return plan('none');
    case 'browser.snapshot': case 'browser.console': case 'browser.network': case 'browser.waitFor':
      return plan('tab', { contentRead: true });
    case 'browser.downloads': return plan('profile', { contentRead: true });
    case 'browser.screenshot':
      return plan('tab', { pixelRead: true, unknownEffect: args.fullPage === true || Boolean(args.selector) });
    // Arbitrary page JS can mutate state and read canvas pixels even when described as a read.
    case 'browser.evaluate': return plan('tab', { contentRead: true, pixelRead: true, unknownEffect: true });
    case 'browser.open': return plan('new-page', { unknownEffect: true });
    case 'browser.activate':
      if (args.foreground !== undefined && typeof args.foreground !== 'boolean') throw new Error('Invalid browser activation');
      return plan('tab', { unknownEffect: args.foreground === true });
    case 'browser.close': case 'browser.navigate': case 'browser.click': case 'browser.fill': case 'browser.selectOption':
    case 'browser.pressKey': case 'browser.hover': case 'browser.movePointer': case 'browser.scroll': case 'browser.upload': case 'browser.drag': case 'browser.setViewport':
      return plan('tab', { unknownEffect: true });
    case 'browser.dialog':
      if (args.action === 'list') return plan('tab', { contentRead: true });
      if (args.action === 'accept' || args.action === 'dismiss' || args.action === 'policy') return plan('tab', { unknownEffect: true });
      throw new Error('Invalid browser dialog action');
    case 'browser.cookies': {
      const action = args.action ?? 'get';
      if (action === 'get') return plan('profile', { contentRead: true });
      if (action === 'set' || action === 'clear') return plan('profile', { unknownEffect: true });
      throw new Error('Invalid browser cookies action');
    }
    case 'browser.storage': {
      const action = args.action ?? 'get';
      if (action === 'get') return plan('tab', { contentRead: true });
      if (action === 'set' || action === 'remove' || action === 'clear') return plan('tab', { unknownEffect: true });
      throw new Error('Invalid browser storage action');
    }
    case 'browser.recording':
      if (args.action === 'start') return plan('tab', { pixelRead: true, cleanup: true });
      if (args.action === 'stop') return plan('recording', { pixelRead: true, cleanup: true });
      if (args.action === 'cancel') return plan('recording', { cleanup: true });
      if (args.action === 'status') return plan('recording');
      throw new Error('Invalid browser recording action');
    default: throw new Error(`Unclassified browser operation: ${name}`);
  }
}

/** Fixed audit labels only; never copy model arguments, selectors, URLs or page text into the audit. */
export function browserAuditAction(name: string, args: Readonly<Record<string, unknown>>): import('./auditStore').DesktopAuditEntry['action'] {
  classifyMediatedBrowserOperation(name, args);
  switch (name) {
    case 'browser.tabs': return 'tabs';
    case 'browser.snapshot': return 'snapshot';
    case 'browser.console': return 'console';
    case 'browser.network': return 'network';
    case 'browser.waitFor': return 'wait';
    case 'browser.downloads': return 'downloads';
    case 'browser.screenshot': return 'screenshot';
    case 'browser.evaluate': return 'evaluate';
    case 'browser.open': return 'open';
    case 'browser.activate': return 'activate';
    case 'browser.close': return 'close';
    case 'browser.navigate': return 'navigate';
    case 'browser.click': return 'click';
    case 'browser.fill': return 'fill';
    case 'browser.selectOption': return 'select-option';
    case 'browser.pressKey': return 'press-key';
    case 'browser.hover': case 'browser.movePointer': return 'hover';
    case 'browser.scroll': return 'scroll';
    case 'browser.upload': return 'upload';
    case 'browser.drag': return 'drag';
    case 'browser.setViewport': return 'set-viewport';
    case 'browser.dialog': return args.action === 'list' ? 'dialog-read' : 'dialog-write';
    case 'browser.cookies': return (args.action ?? 'get') === 'get' ? 'cookies-read' : 'cookies-write';
    case 'browser.storage': return (args.action ?? 'get') === 'get' ? 'storage-read' : 'storage-write';
    case 'browser.recording':
      if (args.action === 'start') return 'recording-start';
      if (args.action === 'stop') return 'recording-stop';
      if (args.action === 'cancel') return 'recording-cancel';
      return 'recording-status';
    default: throw new Error(`Unclassified browser audit action: ${name}`);
  }
}
