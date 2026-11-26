import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AgentComposer } from '../../src/renderer/src/components/AgentComposer';
import { TaskSessionFields } from '../../src/renderer/src/components/TaskSessionFields';
import { StoreProvider } from '../../src/renderer/src/store';
import type { ComposerPreset } from '../../src/renderer/src/components/agentComposer/composerTypes';

const launchPreset: ComposerPreset = {
  id: 'creator',
  locked: true,
  title: '选择模式',
  lockedTitle: '对话开始后模式锁定，不可中途切换',
  loadRoster: vi.fn(async () => []),
  onChange: vi.fn()
};

describe('会话模式入口', () => {
  it('GUI 会话输入框不显示只能启动时选择的模式胶囊', () => {
    const { container } = render(
      <StoreProvider>
        <AgentComposer
          workspaceId="session-preset"
          surfaceKind="gui-session"
          busy={false}
          onSend={async () => true}
          onClear={async () => undefined}
          preset={launchPreset}
        />
      </StoreProvider>
    );

    expect(container.querySelector('.agent-core-preset-chip')).toBeNull();
    expect(launchPreset.loadRoster).not.toHaveBeenCalled();
  });

  it('任务拉起表单仍保留 Pi 引擎模式选择', () => {
    render(
      <StoreProvider>
        <TaskSessionFields
          runtime="pi"
          disabled={false}
          guiMode=""
          onGuiMode={vi.fn()}
          piMode=""
          onPiMode={vi.fn()}
          modelKey=""
          onModelKey={vi.fn()}
          thinking=""
          onThinking={vi.fn()}
        />
      </StoreProvider>
    );

    expect(screen.getByLabelText('引擎模式')).toBeTruthy();
  });
});
