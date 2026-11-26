/**
 * B2 权限选项门（ConfirmDialog 组件级）：四态按钮、作用域 always、freeText 回灌、文件变更预览。
 * Run: npx vitest run test/unit/permission-option.spec.tsx
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StoreProvider, useUiStore } from '../../src/renderer/src/store';
import { ConfirmDialog } from '../../src/renderer/src/components/ConfirmDialog';
import { MOTION } from '../../src/renderer/src/components/motion';
import { currentApiMock } from './helpers/api-mock';
import type { ConfirmRequest } from '../../src/shared/types';

const PERM_REQ: ConfirmRequest = {
  requestId: 'req-perm-1',
  title: 'Agent 请求执行：files.write',
  detail: '{"path":"src/index.ts"}',
  dangerous: true,
  permission: {
    preview: {
      scope: 'file',
      filePaths: ['src/index.ts', 'src/shared/permissionOption.ts'],
      fileChange: 'add'
    },
    defaultScope: 'session',
    projectKey: 'ws-a',
    sessionKey: 'sess-1',
    fingerprint: 'fp-files-write'
  }
} as ConfirmRequest;

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

function lastCall() {
  return currentApiMock().mockOf('confirmRespond').mock.calls.at(-1) as unknown[];
}

describe('权限选项门（四态 kind / 作用域 / freeText / 预览）', () => {
  it('四态按钮 + 文件变更预览渲染；允许一次 → allowOnce', async () => {
    const user = userEvent.setup();
    renderApp();
    currentApiMock().emit('ui:confirm', PERM_REQ);

    await screen.findByRole('dialog');
    expect(screen.getByTestId('permission-allow-once')).toBeTruthy();
    expect(screen.getByTestId('permission-allow-always')).toBeTruthy();
    expect(screen.getByTestId('permission-deny')).toBeTruthy();
    expect(screen.getByTestId('permission-custom')).toBeTruthy();

    const preview = screen.getByTestId('permission-preview');
    expect(preview.getAttribute('data-preview-scope')).toBe('file');
    expect(screen.getByText('src/index.ts')).toBeTruthy();
    const changes = screen.getAllByTestId('permission-file-change');
    expect(changes[0].textContent).toBe('新增');

    await user.click(screen.getByTestId('permission-allow-once'));
    const call = lastCall();
    expect(call[0]).toBe('req-perm-1');
    expect(call[1]).toBe(true);
    expect(call[3]).toMatchObject({ kind: 'allowOnce' });
  });

  it('作用域 always：默认 session，点总是允许带 scope 回传', async () => {
    const user = userEvent.setup();
    renderApp();
    currentApiMock().emit('ui:confirm', PERM_REQ);
    await screen.findByRole('dialog');

    expect(screen.getByTestId('permission-scope-session').getAttribute('aria-pressed')).toBe('true');

    await user.click(screen.getByTestId('permission-allow-always'));
    expect(lastCall()[3]).toMatchObject({ kind: 'allowAlways', scope: 'session' });

    // 换作用域再点
    currentApiMock().emit('ui:confirm', { ...PERM_REQ, requestId: 'req-perm-2' });
    await screen.findByRole('dialog');
    await user.click(screen.getByTestId('permission-scope-project'));
    await user.click(screen.getByTestId('permission-allow-always'));
    expect(lastCall()[3]).toMatchObject({ kind: 'allowAlways', scope: 'project' });
  });

  it('freeText 回灌：请求带 freeText 预填；custom 应答带 freeText 且不确认', async () => {
    const user = userEvent.setup();
    renderApp();
    currentApiMock().emit('ui:confirm', {
      ...PERM_REQ,
      requestId: 'req-perm-ft',
      permission: { ...PERM_REQ.permission, freeText: '先跑 npm test' }
    } as ConfirmRequest);
    await screen.findByRole('dialog');

    const ta = screen.getByTestId('permission-freetext') as HTMLTextAreaElement;
    expect(ta.value).toBe('先跑 npm test');

    await user.clear(ta);
    await user.type(ta, '改用 vitest');
    await user.click(screen.getByTestId('permission-custom'));
    const call = lastCall();
    expect(call[1]).toBe(false);
    expect(call[3]).toMatchObject({ kind: 'custom', freeText: '改用 vitest' });
  });

  it('拒绝 → deny 且 confirmed=false；超 4096 自由文本被截断', async () => {
    const user = userEvent.setup();
    renderApp();
    currentApiMock().emit('ui:confirm', {
      ...PERM_REQ,
      requestId: 'req-perm-deny',
      permission: { ...PERM_REQ.permission, freeText: 'x'.repeat(4096) }
    } as ConfirmRequest);
    await screen.findByRole('dialog');

    const ta = screen.getByTestId('permission-freetext') as HTMLTextAreaElement;
    // 回灌被截到 4096
    expect(ta.value.length).toBeLessThanOrEqual(4096);

    await user.click(screen.getByTestId('permission-deny'));
    const call = lastCall();
    expect(call[1]).toBe(false);
    expect((call[3] as { kind: string }).kind).toBe('deny');
  });

  it('command 预览渲染命令串；kinds 裁剪只出部分按钮', async () => {
    renderApp();
    currentApiMock().emit('ui:confirm', {
      requestId: 'req-perm-cmd',
      title: 'Agent 请求执行：shell',
      detail: '{}',
      permission: {
        preview: { scope: 'command', command: 'rm -rf build' },
        kinds: ['allowOnce', 'deny']
      }
    } as ConfirmRequest);
    await screen.findByRole('dialog');
    expect(screen.getByText('rm -rf build')).toBeTruthy();
    expect(screen.getByTestId('permission-allow-once')).toBeTruthy();
    expect(screen.getByTestId('permission-deny')).toBeTruthy();
    expect(screen.queryByTestId('permission-allow-always')).toBeNull();
    expect(screen.queryByTestId('permission-custom')).toBeNull();
  });

  it('无 permission 的旧确认框仍是双按钮（不回归）', async () => {
    const user = userEvent.setup();
    renderApp();
    currentApiMock().emit('ui:confirm', {
      requestId: 'req-legacy',
      title: '旧确认',
      detail: 'plain'
    } as ConfirmRequest);
    await screen.findByRole('dialog');
    expect(screen.getByRole('button', { name: '确认执行' })).toBeTruthy();
    expect(screen.queryByTestId('permission-allow-once')).toBeNull();

    await user.click(screen.getByRole('button', { name: '确认执行' }));
    expect(lastCall()).toEqual(['req-legacy', true, undefined]);
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    }, { timeout: MOTION.exitMs + 2000 });
  });
});
