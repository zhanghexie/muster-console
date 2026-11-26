/**
 * 网关连接状态快照引用稳定：桌面壳（未装 shim）进手机表面时，ConnDot/MobileApp 用
 * useSyncExternalStore 读 getWebGatewayStatus——每次返回新对象会触发
 * 「Maximum update depth exceeded」整页崩溃（触屏窄窗 / force 标志进手机面时复现）。
 */
import React, { useSyncExternalStore } from 'react';
import { act, render, screen } from '@testing-library/react';
import { vi } from 'vitest';

vi.hoisted(() => {
  // 桌面壳：preload 已注入 window.api，shim 导入即自检跳过安装
  const w = window as unknown as Record<string, unknown>;
  if (!('api' in w)) w.api = {};
  if (typeof window.matchMedia !== 'function') {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false
    })) as unknown as typeof window.matchMedia;
  }
});

import { getWebGatewayStatus, subscribeWebGatewayStatus } from '../../src/renderer/src/webApiShim';
import { AppTipHost } from '../../src/renderer/src/components/AppTip';
import { markWebGatewayActive } from '../../src/renderer/src/webGatewayEnvironment';
import { setGatewayStatus } from '../../src/renderer/src/webGatewayStatus';
import { dismissTip, getTipSnapshot } from '../../src/renderer/src/tips';

function Probe(): React.JSX.Element {
  const s = useSyncExternalStore(subscribeWebGatewayStatus, getWebGatewayStatus);
  return <span data-testid="conn">{s.connected ? 'on' : 'off'}</span>;
}

describe('getWebGatewayStatus 快照', () => {
  it('桌面壳连续读取返回同一引用', () => {
    expect(getWebGatewayStatus()).toBe(getWebGatewayStatus());
    expect(getWebGatewayStatus().connected).toBe(true);
  });

  it('useSyncExternalStore 订阅不陷入无限重渲染', () => {
    const { getByTestId } = render(<Probe />);
    expect(getByTestId('conn').textContent).toBe('on');
  });

  it('reports a gateway failure through the window tip and leaves reconnection progress quiet', () => {
    markWebGatewayActive();
    render(<AppTipHost />);
    act(() => setGatewayStatus(false, 'Connecting…'));
    expect(getTipSnapshot()).toBeNull();
    act(() => setGatewayStatus(false, 'Token rejected', 'Open a fresh link'));
    expect(screen.getByRole('status').textContent).toBe('Open a fresh link');
    expect(getTipSnapshot()?.tone).toBe('error');
    act(() => { setGatewayStatus(true, ''); dismissTip(); });
  });
});
