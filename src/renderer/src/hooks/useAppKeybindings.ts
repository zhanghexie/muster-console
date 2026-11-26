import { useKeybinding } from '../keybindings/KeybindingHost';

export type AppKeybindingActions = {
  openSettings: () => void;
  findChat: () => void;
  toggleGlobalBoard: () => void;
  toggleProcessMonitor: () => void;
  toggleCenterSplit: () => void;
  toggleVirtualScreen: () => void;
  goBack: () => void;
  goForward: () => void;
  releaseTerminalFocus: () => void;
  openQuickFiles: () => void;
  findFiles: () => void;
  gotoPalette: () => void;
  openCommands: () => void;
};

/** Registers the desktop shell's global actions in one state-owned hook. */
export function useAppKeybindings(actions: AppKeybindingActions): void {
  useKeybinding('settings.open', actions.openSettings);
  useKeybinding('chat.find', actions.findChat);
  useKeybinding('globalBoard.toggle', actions.toggleGlobalBoard);
  useKeybinding('processMonitor.toggle', actions.toggleProcessMonitor);
  useKeybinding('center.split', actions.toggleCenterSplit);
  useKeybinding('virtualScreen.toggle', actions.toggleVirtualScreen);
  useKeybinding('panel.back', actions.goBack);
  useKeybinding('panel.forward', actions.goForward);
  useKeybinding('terminal.releaseFocus', actions.releaseTerminalFocus);
  useKeybinding('files.quickOpen', actions.openQuickFiles);
  useKeybinding('files.findInFiles', actions.findFiles);
  useKeybinding('palette.goto', actions.gotoPalette);
  useKeybinding('palette.commands', actions.openCommands);
}
