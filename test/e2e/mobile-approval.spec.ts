/**
 * T5.6：GUI 会话挂审批卡并可点允许。
 * 手机 L3 与桌面共用 ApprovalCard；contextBridge 冻结 window.api，e2e 无法
 * 替换 respondApproval 做间谍。按钮→IPC 由 test/unit/mobile-one-tap.spec.tsx
 * 覆盖；本条验证真 app 收到 sync 后渲染卡，并走一遍 respondApproval 通道。
 */
import { test, expect } from './fixtures/electron';

test.describe.configure({ mode: 'serial' });

test('GUI 会话审批卡可见且 respondApproval 通道可用', async ({ appCtx }) => {
  const { app, win } = appCtx;

  const created = await win.evaluate(async () => {
    const meta = await (window as any).api.sessions.create({ runtime: 'pi', name: 'e2e手机审批' });
    await (window as any).api.sessions.select(meta.id);
    return { sessionId: meta.id as string };
  });
  expect(created.sessionId).toBeTruthy();

  await win.waitForSelector('.chat-surface-view', { timeout: 20_000 });
  await win.waitForTimeout(800);

  await app.evaluate(
    async ({ BrowserWindow }, payload) => {
      const w = BrowserWindow.getAllWindows()[0];
      if (!w) throw new Error('无窗口');
      w.webContents.send('agentSession:event', payload);
    },
    {
      kind: 'sync',
      sessionId: created.sessionId,
      messages: [
        {
          id: 'msg-appr',
          role: 'assistant',
          parts: [{ kind: 'text', text: '请求执行工具' }],
          approval: {
            approvalId: 'e2e-ap-1',
            toolCallId: 'e2e-tc-1',
            toolName: 'Bash',
            input: { command: 'echo e2e' }
          },
          ts: Date.now()
        }
      ]
    }
  );

  const allow = win.locator('.ac-approval-allow');
  await allow.waitFor({ state: 'visible', timeout: 15_000 });
  await expect(win.locator('.ac-approval code')).toHaveText('Bash');
  await allow.click();

  const ipc = await win.evaluate(async (sid) => {
    return (window as any).api.agentSession.respondApproval({
      sessionId: sid,
      approvalId: 'e2e-ap-1',
      approved: true
    });
  }, created.sessionId);
  expect(ipc).toEqual({ ok: false });

  await win.evaluate(async (sid) => {
    await (window as any).api.sessions.setArchived(sid, true);
  }, created.sessionId);
});
