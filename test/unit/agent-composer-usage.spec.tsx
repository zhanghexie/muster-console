/**
 * Composer 上下文用量环：重启恢复的陈旧值详情菜单带「最后更新」。
 * 运行: npx vitest run test/unit/agent-composer-usage.spec.tsx
 */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { AgentComposer } from '../../src/renderer/src/components/AgentComposer';
import { StoreProvider } from '../../src/renderer/src/store';

function renderComposer(usage: {
  tokens: number | null;
  contextWindow: number;
  ts?: number;
  stale?: boolean;
}) {
  return render(
    <StoreProvider>
      <AgentComposer
        workspaceId="ws-1"
        busy={false}
        surfaceKind="gui-session"
        onSend={async () => true}
        onClear={async () => undefined}
        chatStatus={{
          modelLabel: 'GLM',
          usage
        }}
      />
    </StoreProvider>
  );
}

describe('AgentComposer 上下文用量', () => {
  it('陈旧用量点开菜单显示最后更新时间', () => {
    renderComposer({
      tokens: 88000,
      contextWindow: 200000,
      ts: Date.now() - 60_000,
      stale: true
    });
    fireEvent.click(screen.getByRole('button', { name: '上下文用量' }));
    expect(screen.getByText(/最后更新/)).toBeTruthy();
  });

  it('实时用量不显示最后更新', () => {
    renderComposer({
      tokens: 88000,
      contextWindow: 200000,
      ts: Date.now(),
      stale: false
    });
    fireEvent.click(screen.getByRole('button', { name: '上下文用量' }));
    expect(screen.queryByText(/最后更新/)).toBeNull();
  });
});
