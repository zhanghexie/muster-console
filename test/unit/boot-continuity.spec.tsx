import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { RootLayout } from '../../src/renderer/src/RootLayout';
import { BootReady, finishBoot } from '../../src/renderer/src/components/BootReady';
import { ErrorBoundary } from '../../src/renderer/src/components/ErrorBoundary';

const gate = vi.hoisted(() => ({ ready: false, promise: null as Promise<void> | null }));
vi.mock('../../src/renderer/src/App', () => ({ App: () => {
  if (!gate.ready) throw gate.promise;
  return <div>主界面已就绪</div>;
} }));
vi.mock('../../src/renderer/src/useWorkspaceAppearance', () => ({ useWorkspaceAppearance: () => {} }));
vi.mock('../../src/renderer/src/mobile/useMobileSurface', () => ({ useMobileSurface: () => false }));
vi.mock('../../src/renderer/src/panelHistory', () => ({ PanelHistoryProvider: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('../../src/renderer/src/keybindings/KeybindingHost', () => ({ KeybindingProvider: ({ children }: { children: React.ReactNode }) => children }));

function installBoot() {
  const doc = new DOMParser().parseFromString(readFileSync(resolve('src/renderer/index.html'), 'utf8'), 'text/html');
  const overlay = doc.querySelector('.boot-skel')!;
  expect(doc.getElementById('root')!.contains(overlay)).toBe(false);
  document.body.appendChild(overlay);
  return overlay;
}
afterEach(() => { finishBoot(); vi.restoreAllMocks(); });

it('HTML→React→懒分包：始终保留同一动画节点，真实页面提交才移除', async () => {
  const overlay = installBoot();
  const orbit = overlay.querySelector('.brand-loader-orbit');
  let release!: () => void;
  gate.ready = false; gate.promise = new Promise<void>(r => { release = r; });
  render(<RootLayout />);
  await act(async () => {});
  expect(document.querySelectorAll('.boot-skel')).toHaveLength(1);
  expect(document.querySelector('.boot-skel')).toBe(overlay);
  expect(document.querySelector('.brand-loader-orbit')).toBe(orbit);
  expect(screen.queryByText('主界面已就绪')).toBeNull();
  await act(async () => { gate.ready = true; release(); });
  await screen.findByText('主界面已就绪');
  expect(document.querySelector('.boot-skel')).toBeNull();
});

it('启动失败页提交后移除遮罩', () => {
  installBoot();
  render(<><BootReady /><p role="alert">后台初始化失败</p></>);
  expect(document.querySelector('.boot-skel')).toBeNull();
  expect(screen.getByRole('alert')).toBeTruthy();
});

it('主界面渲染失败也移除遮罩，不能遮住重试入口', async () => {
  installBoot();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  function Broken(): never { throw new Error('chunk failed'); }
  render(<ErrorBoundary onError={finishBoot}><Broken /></ErrorBoundary>);
  await waitFor(() => expect(document.querySelector('.boot-skel')).toBeNull());
  expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
});
