/**
 * T5.4：CLI 入站 MCP 写引擎配置的 TOFU 确认门（结构化审查）。
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StoreProvider, useUiStore } from '../../src/renderer/src/store';
import { ConfirmDialog } from '../../src/renderer/src/components/ConfirmDialog';
import { MOTION } from '../../src/renderer/src/components/motion';
import { currentApiMock } from './helpers/api-mock';
import type { ConfirmRequest } from '../../src/shared/types';

const REQ: ConfirmRequest = {
  requestId: 'req-inbound-mcp',
  title: '将宿主工具写入 CLI 引擎 MCP 配置',
  detail: 'update C:\\\\Users\\\\me\\\\.claude.json',
  inboundMcpReview: {
    fingerprint: 'v1:node\nserver.mjs',
    command: 'node',
    args: ['server.mjs'],
    files: [
      {
        id: 'claude',
        label: 'Claude Code',
        path: 'C:\\Users\\me\\.claude.json',
        action: 'update'
      }
    ]
  }
};

function Harness() {
  const { confirms } = useUiStore();
  return <ConfirmDialog request={confirms[confirms.length - 1] ?? null} />;
}

function renderApp() {
  return render(
    <StoreProvider>
      <Harness />
    </StoreProvider>
  );
}

describe('入站 MCP TOFU 确认门', () => {
  it('ui:confirm 带 inboundMcpReview → 渲染审查列表；取消不写入', async () => {
    const user = userEvent.setup();
    renderApp();
    currentApiMock().emit('ui:confirm', REQ);
    expect(await screen.findByRole('dialog')).toBeTruthy();
    expect(screen.getByTestId('inbound-mcp-review')).toBeTruthy();
    expect(screen.getByText(/Claude Code/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '确认写入' })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: '取消' }));
    expect(currentApiMock().mockOf('confirmRespond').mock.calls[0]).toEqual([
      'req-inbound-mcp',
      false,
      'button'
    ]);
    await waitFor(
      () => {
        expect(screen.queryByRole('dialog')).toBeNull();
      },
      { timeout: MOTION.exitMs + 2000 }
    );
  });

  it('确认写入 → confirmRespond(id,true)', async () => {
    const user = userEvent.setup();
    renderApp();
    currentApiMock().emit('ui:confirm', REQ);
    await screen.findByRole('dialog');
    await user.click(screen.getByRole('button', { name: '确认写入' }));
    expect(currentApiMock().mockOf('confirmRespond').mock.calls[0]).toEqual([
      'req-inbound-mcp',
      true,
      undefined
    ]);
  });
});
