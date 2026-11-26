import React from 'react';
import { fireEvent, render } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { useCanvasKeyboard } from '../../src/renderer/src/panels/freeCanvas/useCanvasKeyboard';

/**
 * 画布键盘手势回归（board-free-view F-01 / keybindings F-02）：
 * 解散组键位是 Ctrl+Shift+D——Ctrl+Shift+G 是 globalBoard.toggle 的 keybindings 目录
 * 默认键，KeybindingHost 在 window capture 阶段先吞事件并切走看板，画布 bubble 监听
 * 收不到。若把画布改回 Ctrl+Shift+G，本文件「G 不解散 / D 解散」两条应转红。
 */
function KeyboardHarness({
  active,
  handlers
}: {
  active: boolean;
  handlers: {
    groupSelection: () => void;
    ungroupSelection: () => void;
    deleteSelection: () => void;
    runAutoArrange: () => void;
  };
}): React.JSX.Element {
  useCanvasKeyboard({
    active,
    ...handlers,
    itemIds: [],
    stickyIds: [],
    setSelNodes: () => {},
    setSelEdges: () => {},
    setSelGroups: () => {}
  });
  return <div data-testid="harness" />;
}

function renderHarness(active = true) {
  const handlers = {
    groupSelection: vi.fn(),
    ungroupSelection: vi.fn(),
    deleteSelection: vi.fn(),
    runAutoArrange: vi.fn()
  };
  render(<KeyboardHarness active={active} handlers={handlers} />);
  return handlers;
}

it('Ctrl+Shift+D 解散选中组（F-01 换键后的目标键位）', () => {
  const h = renderHarness();
  fireEvent.keyDown(window, { key: 'D', ctrlKey: true, shiftKey: true });
  expect(h.ungroupSelection).toHaveBeenCalledTimes(1);
  expect(h.groupSelection).not.toHaveBeenCalled();
});

it('Ctrl+Shift+G 不再被画布接管——让给 globalBoard.toggle（目录默认键）', () => {
  const h = renderHarness();
  fireEvent.keyDown(window, { key: 'G', ctrlKey: true, shiftKey: true });
  expect(h.ungroupSelection).not.toHaveBeenCalled();
  expect(h.groupSelection).not.toHaveBeenCalled();
});

it('Ctrl+G 打组行为保持不变', () => {
  const h = renderHarness();
  fireEvent.keyDown(window, { key: 'g', ctrlKey: true });
  expect(h.groupSelection).toHaveBeenCalledTimes(1);
  expect(h.ungroupSelection).not.toHaveBeenCalled();
});

it('active=false（状态视图可见）时画布键盘全部停用', () => {
  const h = renderHarness(false);
  fireEvent.keyDown(window, { key: 'D', ctrlKey: true, shiftKey: true });
  fireEvent.keyDown(window, { key: 'g', ctrlKey: true });
  expect(h.ungroupSelection).not.toHaveBeenCalled();
  expect(h.groupSelection).not.toHaveBeenCalled();
});
