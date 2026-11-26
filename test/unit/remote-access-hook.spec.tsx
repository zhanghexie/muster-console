/**
 * 设置 → 远程连接 → 「Webhook 触发」小节（T3.2）组件测试：
 * - 未启动/无 hook 路径时展示不可用提示；
 * - hook 地址渲染 + 推荐标记；
 * - 未配置密钥：点「生成密钥」→ setHookSecret(48 位 hex)；
 * - 已配置密钥：明文展示 + 「清除密钥」→ setHookSecret('')；
 * - 「重新生成 Hook 地址」→ rotateHook()；
 * - 公网风险提示常驻。
 * window.api 由 setup.ts 的 api-mock 提供。
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HookAccessSection, RemoteAccessSettings } from '../../src/renderer/src/components/settings/RemoteAccessSettings';
import { currentApiMock } from './helpers/api-mock';
import type { WebAccessStatusInfo } from '../../src/shared/webAccess';

function status(patch: Partial<WebAccessStatusInfo> = {}): WebAccessStatusInfo {
  return {
    running: true,
    port: 7950,
    token: 'web-token-ABC',
    urls: ['http://127.0.0.1:7950/?token=web-token-ABC'],
    qrDataUrl: '',
    disabledReason: '',
    hook: {
      path: '/hook/hookToken_ABCDEFGHIJKLMNOPQRSTUVWX',
      urls: ['http://192.168.1.5:7950/hook/hookToken_ABCDEFGHIJKLMNOPQRSTUVWX'],
      secret: '',
      signatureEnabled: false
    },
    ...patch
  };
}

function install(initial: WebAccessStatusInfo): void {
  currentApiMock().override('webAccess.status', () => Promise.resolve(initial));
}

it('offers Channel remote input without the retired Feishu connection section', async () => {
  const mock = currentApiMock();
  install(status());
  mock.override('messaging.call', async () => ({ ok: true, value: [] }));
  const openChannels = vi.fn();
  render(<RemoteAccessSettings onOpenChannels={openChannels} />);
  await screen.findByText('http://127.0.0.1:7950/?token=web-token-ABC');
  expect(screen.queryByText('旧版飞书连接')).toBeNull();
  expect(document.querySelector('[data-settings-item="feishu-main"]')).toBeNull();
  expect(mock.mockOf('feishu.get')).not.toHaveBeenCalled();
  expect(screen.getByRole('heading', { name: '远程输入' })).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Webhook' })).toBeTruthy();
  await userEvent.setup().click(screen.getByRole('button', { name: '管理 Channels' }));
  expect(openChannels).toHaveBeenCalledOnce();
});

describe('HookAccessSection Webhook 触发（T3.2）', () => {
  it('未启动（hook 无路径）展示不可用提示', async () => {
    install(status({ hook: { path: '', urls: [], secret: '', signatureEnabled: false } }));
    render(<HookAccessSection />);
    expect(await screen.findByText('网页访问未启动，hook 端点不可用')).toBeTruthy();
  });

  it('展示 hook 地址；未配密钥时「生成密钥」写入 48 位 hex', async () => {
    const user = userEvent.setup();
    const mock = currentApiMock();
    install(status());
    render(<HookAccessSection />);

    expect(await screen.findByText('http://192.168.1.5:7950/hook/hookToken_ABCDEFGHIJKLMNOPQRSTUVWX')).toBeTruthy();
    expect(screen.getByText('推荐')).toBeTruthy();
    expect(screen.getByText('未配置（GitLab 必须先配置密钥）')).toBeTruthy();

    mock.override('webAccess.setHookSecret', () => Promise.resolve({ ok: true, status: status() }));
    await user.click(screen.getByRole('button', { name: '生成密钥' }));

    await waitFor(() => expect(mock.mockOf('webAccess.setHookSecret')).toHaveBeenCalledTimes(1));
    const secret = mock.mockOf('webAccess.setHookSecret').mock.calls[0][0] as string;
    expect(secret).toMatch(/^[0-9a-f]{48}$/);
  });

  it('已配密钥：明文展示 + 清除密钥 → setHookSecret("")', async () => {
    const user = userEvent.setup();
    const mock = currentApiMock();
    install(
      status({
        hook: {
          path: '/hook/x',
          urls: ['http://127.0.0.1:7950/hook/x'],
          secret: 'deadbeef'.repeat(6),
          signatureEnabled: true
        }
      })
    );
    render(<HookAccessSection />);

    expect(await screen.findByText('deadbeef'.repeat(6))).toBeTruthy();
    expect(screen.getByText('GitHub 校验签名，GitLab 校验 Secret token；校验失败会拒绝请求。')).toBeTruthy();

    mock.override('webAccess.setHookSecret', () => Promise.resolve({ ok: true, status: status() }));
    await user.click(screen.getByRole('button', { name: '清除密钥' }));
    await waitFor(() =>
      expect(mock.mockOf('webAccess.setHookSecret')).toHaveBeenCalledWith('')
    );
  });

  it('「重新生成 Hook 地址」→ rotateHook；风险提示常驻', async () => {
    const user = userEvent.setup();
    const mock = currentApiMock();
    install(status());
    render(<HookAccessSection />);
    await screen.findByText('http://192.168.1.5:7950/hook/hookToken_ABCDEFGHIJKLMNOPQRSTUVWX');

    expect(
      screen.getByText(
        '风险提示：hook 地址即凭证。若把端口暴露到公网，任何人拿到该地址都能触发任务（任务提示词拥有本机权限）。请保持在内网 / Tailscale 内使用，并配置签名密钥。'
      )
    ).toBeTruthy();

    mock.override('webAccess.rotateHook', () => Promise.resolve({ ok: true, status: status() }));
    await user.click(screen.getByRole('button', { name: '重新生成 Hook 地址' }));
    await waitFor(() => expect(mock.mockOf('webAccess.rotateHook')).toHaveBeenCalledTimes(1));
  });
});
