import React from 'react';
import { render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { ComposerToolbarLeft } from '../../src/renderer/src/components/agentComposer/ComposerToolbarLeft';
import type { Presence } from '../../src/renderer/src/components/motion';
import type { GuiWorkerMode } from '../../src/shared/types';

const presence: Presence = { mounted: false, stage: 'out', spread: { 'data-mp-stage': 'out' } };

function renderToolbar(modeOrder?: GuiWorkerMode[]): ReturnType<typeof render> {
  return render(
    <ComposerToolbarLeft
      plusMenu={false}
      allowImages={false}
      showPlusMenu={false}
      setShowPlusMenu={vi.fn()}
      plusMenuPresence={presence}
      plusMenuRef={{ current: null }}
      insertTriggerChar={vi.fn()}
      fileInputRef={{ current: null }}
      onModeChange={vi.fn()}
      mode="standard"
      modeLabel={(mode) => mode}
      {...(modeOrder === undefined ? {} : { modeOrder })}
      presetRoster={null}
      presetName=""
      showModeMenu={false}
      setShowModeMenu={vi.fn()}
      modeMenuPresence={presence}
      modeMenuRef={{ current: null }}
    />
  );
}

/** modeOrder 显式为空 = 会话无可切换档位（扩展侧栏固定 standard）：chip 整个不出，避免空菜单按钮误导点击 */
it('hides the mode chip when the session exposes no switchable modes', () => {
  const { container } = renderToolbar([]);
  expect(container.querySelector('.agent-mode-wrap')).toBeNull();
  expect(container.querySelector('.agent-mode-chip')).toBeNull();
});

it('keeps the mode chip for sessions with switchable modes', () => {
  renderToolbar(['standard', 'ask']);
  expect(screen.getByText('standard')).toBeTruthy();
});
