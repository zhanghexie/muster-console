import { dismissTip, getTipSnapshot } from '../../src/renderer/src/tips';
/**
 * 启动降级横幅 + 就绪重拉链路（X7-F01）组件级：
 * markBootDegraded → 顶部横幅可见（status 语义）；settleBoot(ok) → 广播
 * BOOT_REHYDRATE_EVENT 触发 StoreProvider 重拉初始快照、横幅经退场动画卸载；
 * settleBoot(!ok) → 弹出错误 tip；降级期初始拉取失败不再
 * catch{} 静默——至少 console 可见。还原修复（去掉降级标记/重拉监听）即红。
 */
import React from 'react';
import { beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { StoreProvider } from '../../src/renderer/src/store';
import { BootStatusBanner } from '../../src/renderer/src/components/BootStatusBanner';
import {
  markBootDegraded,
  resetBootStatusForTest,
  settleBoot
} from '../../src/renderer/src/bootStatus';
import { currentApiMock } from './helpers/api-mock';

beforeEach(() => dismissTip());

function Harness() {
  return (
    <StoreProvider>
      <BootStatusBanner />
    </StoreProvider>
  );
}

async function renderApp() {
  // StoreProvider 首挂会异步拉取工作区、运行时等数据；等 hydration 提交后再驱动 boot 状态
  await act(async () => {
    render(<Harness />);
  });
}

describe('BootStatusBanner 启动降级链路（X7-F01）', () => {
  beforeEach(() => {
    resetBootStatusForTest();
  });

  it('正常挂载无横幅；降级挂载后顶部出现「仍在初始化」提示（status 语义）', async () => {
    await renderApp();
    expect(screen.queryByText(/仍在初始化/)).toBeNull();
    await act(async () => {
      markBootDegraded();
    });
    const banner = screen.getByRole('status');
    expect(banner.textContent).toContain('仍在初始化，部分面板可能暂不可用');
  });

  it('主进程就绪（settleBoot ok）后：重拉初始快照补齐 + 横幅经退场动画卸载', async () => {
    await renderApp();
    await act(async () => {
      markBootDegraded();
    });
    expect(screen.getByRole('status')).toBeTruthy();
    const pullsBefore = currentApiMock().mockOf('sessions.list').mock.calls.length;
    await act(async () => {
      settleBoot({ ok: true });
    });
    // 降级期失败的初始拉取被 BOOT_REHYDRATE_EVENT 重放（会话/工作区/配置/运行时四路）
    await waitFor(() => {
      expect(currentApiMock().mockOf('sessions.list').mock.calls.length).toBeGreaterThan(pullsBefore);
    });
    await waitFor(() => expect(currentApiMock().mockOf('workspaces.list').mock.calls.length).toBeGreaterThan(0));
    // usePresence 退场（exitMs+80 兜底）后横幅卸载
    await waitFor(() => expect(screen.queryByText(/仍在初始化/)).toBeNull());
  });

  it('启动链最终失败时弹出 tip 并收起初始化进度横幅', async () => {
    await renderApp();
    await act(async () => {
      markBootDegraded();
    });
    await act(async () => {
      settleBoot({ ok: false, error: 'db locked' });
    });
    expect(getTipSnapshot()).toMatchObject({ text: '初始化失败：db locked', tone: 'error' });
    await waitFor(() => expect(screen.queryByText(/仍在初始化/)).toBeNull());
    expect(screen.queryByText('初始化失败：db locked')).toBeNull();
  });

  it('降级期初始拉取失败不再静默：至少 console 可见（X7-F01 合同）', async () => {
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    };
    currentApiMock().override('sessions.list', () => Promise.reject(new Error('No handler registered')));
    try {
      await act(async () => {
        render(<Harness />);
      });
      await waitFor(() =>
        expect(errors.some((line) => line.includes('initial data pull failed'))).toBe(true)
      );
    } finally {
      console.error = originalError;
    }
  });
});
