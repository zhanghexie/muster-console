import { getCenterSplitPaneRefs, samePaneRef, type CenterPaneSlot, type SplitPaneRef } from '../../shared/centerSplit';
import { centerSplitSetFocused, getCenterSplitState } from './centerSplitStore';
import type { ExtensionNavigationSnapshot } from '../../shared/extension';

/** Do not focus a placeholder or hide a protected settings draft. */
export function canFocusCenterTarget(target: Exclude<SplitPaneRef, { kind: 'empty' }>, state: {
  docked: boolean; navigation: ExtensionNavigationSnapshot['nodes']; settingsModal: boolean;
  settingsDirty: boolean; settingsVisible: boolean; settingsDocked: boolean;
}): boolean {
  if (state.docked || state.settingsModal) return false;
  if (target.kind === 'utility' && target.sel.startsWith('nav:')) {
    const nodeId = target.sel.slice(4);
    if (state.navigation.some(node => node.id === nodeId && node.kind === 'extension' && (node.placement === 'tab' || node.placement === 'window'))) return false;
  }
  return !state.settingsDirty || !(state.settingsVisible || state.settingsDocked) || target.kind === 'utility' && target.sel === 'settings';
}

/** Focus a painted pane only while the host request and selected target are current. */
export function focusCenterPaneElement(slot: CenterPaneSlot, isCurrent: () => boolean): Promise<void> {
  const deadline = Date.now() + 3500;
  return new Promise((resolve, reject) => {
    const check = (): void => {
      try {
        if (!isCurrent()) throw new Error('Center target changed or request closed');
        const pane = document.querySelector<HTMLElement>(`.center-split-pane[data-pane="${slot}"]`);
        if (pane && pane.isConnected && pane.getAttribute('aria-hidden') !== 'true') {
          const rect = pane.getBoundingClientRect();
          const style = getComputedStyle(pane);
          if (rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0 &&
              rect.left < window.innerWidth && rect.top < window.innerHeight && style.display !== 'none' && style.visibility !== 'hidden') {
            pane.focus({ preventScroll: true });
            if (document.activeElement === pane) {
              if (!isCurrent()) throw new Error('Center target changed while focusing');
              resolve(); return;
            }
          }
        }
        if (Date.now() >= deadline) throw new Error('Center keyboard focus was not confirmed');
        requestAnimationFrame(check);
      } catch (error) { reject(error); }
    };
    requestAnimationFrame(check);
  });
}

/** Focus only a confirmed visible pane; never guess or create a missing session. */
export function focusVisibleCenterPane(primary: SplitPaneRef, target: SplitPaneRef): CenterPaneSlot {
  if (target.kind === 'empty') throw new Error('Cannot focus an empty pane');
  const state = getCenterSplitState();
  if (state.pendingLayout) throw new Error('Center layout is changing');
  const index = getCenterSplitPaneRefs(primary, state).findIndex(ref => samePaneRef(ref, target));
  if (index < 0 || index > 2) throw new Error('Requested center pane is not visible');
  centerSplitSetFocused(index as CenterPaneSlot);
  if (getCenterSplitState().focused !== index) throw new Error('Center focus outcome is unknown; inspect before retrying');
  return index as CenterPaneSlot;
}
