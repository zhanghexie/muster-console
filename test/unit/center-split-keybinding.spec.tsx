import React from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { KeybindingProvider, useKeybinding } from '../../src/renderer/src/keybindings/KeybindingHost';
import {
  __resetCenterSplitForTest, attachCenterSplitBridge, centerSplitToggleShortcut,
  getCenterSplitState, useCenterSplit
} from '../../src/renderer/src/centerSplitStore';

function SplitShortcutHarness(): React.JSX.Element {
  useKeybinding('center.split', centerSplitToggleShortcut);
  const split = useCenterSplit();
  return <><output data-testid="split-open">{String(split.open)}</output><textarea aria-label="草稿" /></>;
}

describe('分屏默认快捷键的生产 Host 分发', () => {
  beforeEach(() => {
    __resetCenterSplitForTest();
    attachCenterSplitBridge({
      getPrimary: () => ({ kind: 'session', sessionId: 'terminal-a' }),
      selectRef: () => {}, getPrefs: () => ({ dir: 'row', ratio: 0.5 }), savePrefs: () => {}
    });
  });

  it('真实反斜线按键经 KeybindingProvider 打开第二侧选择器', async () => {
    await act(async () => { render(<KeybindingProvider><SplitShortcutHarness /></KeybindingProvider>); });
    fireEvent.keyDown(document.body, { key: '\\', code: 'Backslash', ctrlKey: true });
    expect(screen.getByTestId('split-open').textContent).toBe('true');
    expect(getCenterSplitState()).toMatchObject({ secondary: { kind: 'empty' }, focused: 1 });
  });

  it('正文输入时沿用 notTyping 约定，不抢走反斜线输入', async () => {
    await act(async () => { render(<KeybindingProvider><SplitShortcutHarness /></KeybindingProvider>); });
    fireEvent.keyDown(screen.getByRole('textbox', { name: '草稿' }), { key: '\\', code: 'Backslash', ctrlKey: true });
    expect(screen.getByTestId('split-open').textContent).toBe('false');
  });
});
