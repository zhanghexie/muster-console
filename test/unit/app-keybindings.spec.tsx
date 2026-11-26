import React from 'react';
import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const registered = new Map<string, () => void>();

vi.mock('../../src/renderer/src/keybindings/KeybindingHost', () => ({
  useKeybinding: (id: string, handler: () => void) => {
    registered.set(id, handler);
  }
}));

import { useAppKeybindings } from '../../src/renderer/src/hooks/useAppKeybindings';

const ACTIONS = [
  'openSettings', 'findChat', 'toggleGlobalBoard', 'toggleProcessMonitor', 'toggleCenterSplit',
  'toggleVirtualScreen', 'goBack', 'goForward', 'releaseTerminalFocus',
  'openQuickFiles', 'findFiles', 'gotoPalette', 'openCommands'
] as const;

function Harness({ onAction }: { onAction: (name: string) => void }): null {
  useAppKeybindings(Object.fromEntries(ACTIONS.map(name => [name, () => onAction(name)])) as never);
  return null;
}

describe('app global keybinding registration', () => {
  beforeEach(() => registered.clear());

  it('registers every desktop shell action and keeps handlers callable', () => {
    const calls: string[] = [];
    render(<Harness onAction={name => calls.push(name)} />);

    expect([...registered.keys()]).toEqual([
      'settings.open', 'chat.find', 'globalBoard.toggle', 'processMonitor.toggle', 'center.split',
      'virtualScreen.toggle', 'panel.back', 'panel.forward', 'terminal.releaseFocus',
      'files.quickOpen', 'files.findInFiles', 'palette.goto', 'palette.commands'
    ]);

    act(() => {
      registered.get('settings.open')?.();
      registered.get('palette.commands')?.();
    });
    expect(calls).toEqual(['openSettings', 'openCommands']);
  });
});
