import type { Terminal } from '@xterm/xterm';

/** Selection must never consume the TUI's interrupt key. Modal overlays still own input. */
export function attachTerminalKeyHandler(
  term: Pick<Terminal, 'attachCustomKeyEventHandler' | 'hasSelection' | 'getSelection' | 'clearSelection'>,
  blocked: () => boolean,
  clearSelectionUi: () => void
): void {
  term.attachCustomKeyEventHandler((ev) => {
    if (ev.type !== 'keydown') return true;
    if (blocked()) return false;
    if (!term.hasSelection()) return true;
    const key = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key;
    if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && key === 'c') {
      const selection = term.getSelection();
      if (selection) void navigator.clipboard.writeText(selection).catch(() => undefined);
      term.clearSelection();
      clearSelectionUi();
      return false;
    }
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(ev.key)) return true;
    term.clearSelection();
    clearSelectionUi();
    return true;
  });
}
