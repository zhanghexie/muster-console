/**
 * T5.6 手机一键处置组件测试：
 * 1. ApprovalCard：允许/拒绝 → agentSession.respondApproval
 * 2. MobilePtyReply：发送 → sessions.sendMessage
 * 3. WorkspaceDetailPage：pty 行可点进会话（不再 toast 拦下）
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StoreProvider } from '../../src/renderer/src/store';
import { ApprovalCard } from '../../src/renderer/src/chatSurface/guiApprovalCards';
import { MobilePtyReply } from '../../src/renderer/src/mobile/MobilePtyReply';
import { WorkspaceDetailPage } from '../../src/renderer/src/mobile/pages/WorkspaceDetailPage';
import { currentApiMock } from './helpers/api-mock';
import type { SessionMeta } from '../../src/shared/types';

const WS = [{ id: 'ws-a', path: 'E:/demo/a', name: 'Alpha', openedAt: 1 }];

function ptySession(): SessionMeta {
  return {
    id: 'pty-1',
    type: 'terminal',
    name: 'CLI Worker',
    createdAt: 1,
    lastUsedAt: 1,
    launchKind: 'agent',
    runtime: 'claude-code',
    workspaceId: 'ws-a',
    status: 'running',
    lifecycle: 'idle',
    phase: { value: 'needs_you', source: 'model', ts: 1 }
  };
}

function seedStores(sessions: SessionMeta[]): void {
  const mock = currentApiMock();
  mock.override('workspaces.list', () =>
    Promise.resolve({ workspaces: WS, activeWorkspaceId: 'ws-a' })
  );
  mock.override('config.get', () =>
    Promise.resolve({ workspaces: WS, activeWorkspaceId: 'ws-a', locale: 'zh-CN' })
  );
  mock.override('sessions.list', () => Promise.resolve({ sessions, activeId: sessions[0]?.id ?? null }));
  mock.override('runtimes.list', () =>
    Promise.resolve([
      { id: 'claude-code', label: 'Claude Code', enabled: true, surface: 'pty' },
      { id: 'pi', label: 'Pi', enabled: true, surface: 'chat' }
    ])
  );
}

describe('ApprovalCard（GUI 审批 → respondApproval）', () => {
  it('点允许 → respondApproval(approved:true)', async () => {
    const user = userEvent.setup();
    currentApiMock().override('agentSession.respondApproval', () => Promise.resolve({ ok: true }));
    render(
      <ApprovalCard
        sessionId="gui-1"
        approval={{
          approvalId: 'ap-1',
          toolCallId: 'tc-1',
          toolName: 'Bash',
          input: { command: 'ls' }
        }}
      />
    );
    await user.click(screen.getByRole('button', { name: '允许' }));
    await waitFor(() => {
      expect(currentApiMock().mockOf('agentSession.respondApproval')).toHaveBeenCalledWith({
        sessionId: 'gui-1',
        approvalId: 'ap-1',
        approved: true
      });
    });
  });

  it('点拒绝 → respondApproval(approved:false)', async () => {
    const user = userEvent.setup();
    currentApiMock().override('agentSession.respondApproval', () => Promise.resolve({ ok: true }));
    render(
      <ApprovalCard
        sessionId="gui-1"
        approval={{
          approvalId: 'ap-2',
          toolCallId: 'tc-2',
          toolName: 'Write',
          input: { path: 'a.ts' }
        }}
      />
    );
    await user.click(screen.getByRole('button', { name: '拒绝' }));
    await waitFor(() => {
      expect(currentApiMock().mockOf('agentSession.respondApproval')).toHaveBeenCalledWith({
        sessionId: 'gui-1',
        approvalId: 'ap-2',
        approved: false
      });
    });
  });
});

describe('MobilePtyReply（pty 回复框 → 邮箱存信）', () => {
  it('填写并发送 → sessions.sendMessage', async () => {
    const user = userEvent.setup();
    currentApiMock().override('sessions.sendMessage', () =>
      Promise.resolve({ ok: true, stored: true, sessionId: 'pty-1' })
    );
    render(<MobilePtyReply sessionId="pty-1" />);
    await user.type(screen.getByPlaceholderText('回复 Worker…'), '继续修登录');
    await user.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => {
      expect(currentApiMock().mockOf('sessions.sendMessage')).toHaveBeenCalledWith({
        sessionId: 'pty-1',
        text: '继续修登录'
      });
    });
    expect((await screen.findByRole('status')).textContent).toBe('已保存到会话信箱，空闲后读取');
  });

  it('失败展示错误文案', async () => {
    const user = userEvent.setup();
    currentApiMock().override('sessions.sendMessage', () =>
      Promise.resolve({ ok: false, message: '终端未就绪' })
    );
    render(<MobilePtyReply sessionId="pty-1" />);
    await user.type(screen.getByPlaceholderText('回复 Worker…'), 'hi');
    await user.click(screen.getByRole('button', { name: '发送' }));
    expect((await screen.findByRole('status')).textContent).toBe('终端未就绪');
  });
});

describe('WorkspaceDetailPage pty 行可进 L3', () => {
  it('点 pty 会话行 → onOpenChat，不 toast', async () => {
    const user = userEvent.setup();
    seedStores([ptySession()]);
    const onOpenChat = vi.fn();
    const onTip = vi.fn();
    render(
      <StoreProvider>
        <WorkspaceDetailPage
          wsId="ws-a"
          onBack={() => undefined}
          onOpenChat={onOpenChat}
          onTip={onTip}
        />
      </StoreProvider>
    );
    await waitFor(() => expect(screen.getByText(/CLI Worker/)).toBeTruthy());
    await user.click(screen.getByRole('button', { name: /CLI Worker/ }));
    expect(onOpenChat).toHaveBeenCalledWith('ws-a', { kind: 'session', sessionId: 'pty-1' });
    expect(onTip).not.toHaveBeenCalled();
  });
});
