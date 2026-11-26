/** Select the existing virtual-screen transition without hiding an unsaved active editor. */
export function planPanelAxisFocus(
  current: { page: 'terminal' | 'git'; virtualScreen: boolean; focusMode: boolean; activeEditorUnsaved: boolean },
  target: 'terminal' | 'git'
): 'noop' | 'show-terminal' | 'show-git' | 'enable-git' {
  if (current.page === target && (target === 'terminal' || current.virtualScreen || current.focusMode)) return 'noop';
  if (current.activeEditorUnsaved) throw new Error('Cannot switch pages while the active editor has unsaved changes');
  if (target === 'terminal') return 'show-terminal';
  return !current.virtualScreen && !current.focusMode ? 'enable-git' : 'show-git';
}
