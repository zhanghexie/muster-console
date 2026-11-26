import { renderWithAppTips as render } from './helpers/app-tips';
/**
 * 窗口背景（docs/features/frame-backdrop.md）：
 * - 设置缩略图点选即生效并落盘（去抖合并）；纯色浓度分段；毛玻璃关时整组禁用；
 * - 作用域：切「仅当前工作区」写 frameBackdropByWorkspace、不动全局，切回「全局默认」清掉独立设置；
 * - 自定义壁纸：选图成功落 custom、取消不变、失败报错；模糊/暗化滑块；
 * - 背景层：几何系带 SVG 高斯模糊；壁纸读不到回落角光并通知；
 * - 纯色联动：浅底挂 fb-light-surface + 窗口按钮区同步成纯色，切走复位为主题框色。
 */
import React from 'react';
import { act, fireEvent, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FrameBackdropPicker } from '../../src/renderer/src/components/settings/FrameBackdropPicker';
import { FrameBackdrop } from '../../src/renderer/src/components/FrameBackdrop';
import {
  flushFrameBackdropPersist,
  getFrameBackdropState,
  resetFrameBackdropForTest
} from '../../src/renderer/src/frameBackdrop';
import { useFrameBackdropChrome } from '../../src/renderer/src/frameBackdropChrome';
import { getTheme } from '../../src/renderer/src/theme';
import type { FrameBackdropChoice } from '../../src/shared/frameBackdrop';
import { currentApiMock } from './helpers/api-mock';

const tile = (id: string) => document.querySelector(`[data-backdrop-tile="${id}"]`) as HTMLButtonElement;
const update = () => currentApiMock().mockOf('config.update');

beforeEach(() => {
  resetFrameBackdropForTest();
  flushFrameBackdropPersist();
  update().mockClear();
});

describe('FrameBackdropPicker', () => {
  it('点缩略图立即生效，落盘去抖合并成一次', async () => {
    render(<FrameBackdropPicker />);
    expect(tile('corner').getAttribute('aria-checked')).toBe('true');
    await userEvent.click(tile('mesh'));
    await userEvent.click(tile('grid'));
    expect(tile('grid').getAttribute('aria-checked')).toBe('true');
    expect(getFrameBackdropState().global).toEqual({ id: 'grid' });
    expect(update()).not.toHaveBeenCalled();
    act(() => flushFrameBackdropPersist());
    expect(update()).toHaveBeenCalledTimes(1);
    expect(update()).toHaveBeenCalledWith({ frameBackdrop: { id: 'grid' } });
  });

  it('纯色：出现浓度分段，切原色档落 solidLevel', async () => {
    render(<FrameBackdropPicker />);
    expect(screen.queryByRole('group', { name: '纯色浓度' })).toBeNull();
    await userEvent.click(tile('solid'));
    expect(getFrameBackdropState().global).toEqual({ id: 'solid', solidLevel: 'deep' });
    await userEvent.click(screen.getByRole('button', { name: '原色 100%' }));
    act(() => flushFrameBackdropPersist());
    expect(update()).toHaveBeenCalledWith({ frameBackdrop: { id: 'solid', solidLevel: 'full' } });
    await userEvent.click(tile('albers'));
    expect(screen.queryByRole('group', { name: '纯色浓度' })).toBeNull();
  });

  it('毛玻璃关（disabled）：缩略图全部禁用，点击无效', async () => {
    render(<FrameBackdropPicker disabled />);
    expect(tile('mesh').disabled).toBe(true);
    await userEvent.click(tile('mesh'));
    expect(getFrameBackdropState().global).toEqual({ id: 'corner' });
  });

  it('作用域：仅当前工作区写 byWorkspace 不动全局；切回全局默认清掉', async () => {
    currentApiMock().override('config.get', () => Promise.resolve({ activeWorkspaceId: 'ws-a', workspaces: [] }));
    render(<FrameBackdropPicker />);
    const wsBtn = await screen.findByRole('button', { name: '仅当前工作区' });
    await userEvent.click(wsBtn);
    await userEvent.click(tile('velvet'));
    expect(getFrameBackdropState()).toEqual({ global: { id: 'corner' }, byWorkspace: { 'ws-a': { id: 'velvet' } } });
    act(() => flushFrameBackdropPersist());
    expect(update()).toHaveBeenLastCalledWith({ frameBackdropByWorkspace: { 'ws-a': { id: 'velvet' } } });

    await userEvent.click(screen.getByRole('button', { name: '全局默认' }));
    expect(getFrameBackdropState().byWorkspace).toEqual({});
    expect(tile('corner').getAttribute('aria-checked')).toBe('true');
  });

  it('自定义壁纸：取消不变；成功落 custom 并出滑块；失败报错', async () => {
    const mock = currentApiMock();
    mock.override('app.pickWallpaper', () => Promise.resolve({ ok: false, canceled: true }));
    render(<FrameBackdropPicker />);
    await userEvent.click(tile('custom'));
    expect(getFrameBackdropState().global).toEqual({ id: 'corner' });

    mock.override('app.pickWallpaper', () => Promise.resolve({ ok: true, path: 'C:/ud/backdrops/abc.png' }));
    await userEvent.click(tile('custom'));
    await waitFor(() =>
      expect(getFrameBackdropState().global).toEqual({ id: 'custom', image: 'C:/ud/backdrops/abc.png', blur: 24, dim: 45 })
    );
    const blur = screen.getByRole('slider', { name: '壁纸模糊' }) as HTMLInputElement;
    fireEvent.change(blur, { target: { value: '8' } });
    expect(getFrameBackdropState().global.blur).toBe(8);

    mock.override('app.pickWallpaper', () => Promise.resolve({ ok: false, error: '图片超过 20MB，请换一张小一点的' }));
    await userEvent.click(screen.getByRole('button', { name: '换一张' }));
    expect(await screen.findByText('图片超过 20MB，请换一张小一点的')).toBeTruthy();
    expect(getFrameBackdropState().global.image).toBe('C:/ud/backdrops/abc.png');
  });
});

describe('FrameBackdrop', () => {
  it('几何系渲染带高斯模糊滤镜的 SVG；渐变系没有 SVG', () => {
    const { container, rerender } = render(<FrameBackdrop choice={{ id: 'mondrian' }} />);
    const root = container.querySelector('.frame-backdrop')!;
    expect(root.classList.contains('fb-mondrian')).toBe(true);
    const filterId = container.querySelector('filter')!.id;
    expect(container.querySelector('feGaussianBlur')!.getAttribute('stdDeviation')).toBe('44');
    expect(container.querySelector('g[filter]')!.getAttribute('filter')).toBe(`url(#${filterId})`);
    rerender(<FrameBackdrop choice={{ id: 'velvet' }} variant="window" />);
    expect(container.querySelector('svg')).toBeNull();
    expect(container.querySelector('.frame-backdrop')!.className).toContain('is-window');
  });

  it('纯色写浓度变量；壁纸读不到回落角光并通知', async () => {
    const { container, rerender } = render(<FrameBackdrop choice={{ id: 'solid', solidLevel: 'mid' }} />);
    expect((container.querySelector('.frame-backdrop') as HTMLElement).style.getPropertyValue('--fb-solid-k')).toBe('55%');

    const Img = globalThis.Image;
    class BrokenImage {
      onerror: (() => void) | null = null;
      set src(_v: string) {
        setTimeout(() => this.onerror?.(), 0);
      }
    }
    vi.stubGlobal('Image', BrokenImage);
    try {
      const onErr = vi.fn();
      const wall: FrameBackdropChoice = { id: 'custom', image: 'C:/gone.png', blur: 10, dim: 30 };
      rerender(<FrameBackdrop choice={wall} onImageError={onErr} />);
      expect(container.querySelector('.frame-backdrop-img')).toBeTruthy();
      await waitFor(() => expect(onErr).toHaveBeenCalledTimes(1));
      expect(container.querySelector('.frame-backdrop')!.classList.contains('fb-corner')).toBe(true);
      expect(container.querySelector('.frame-backdrop-img')).toBeNull();
    } finally {
      vi.stubGlobal('Image', Img);
    }
  });
});

describe('useFrameBackdropChrome', () => {
  it('纯色浅底：挂 fb-light-surface、窗口按钮区同步纯色 + 深色符号；切走复位主题框色', () => {
    const spy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
      () =>
        ({
          fillStyle: '',
          fillRect: () => undefined,
          getImageData: () => ({ data: new Uint8ClampedArray([240, 162, 74, 255]) })
        }) as unknown as CanvasRenderingContext2D
    );
    const chrome = currentApiMock().mockOf('app.setChromeTheme');
    chrome.mockClear();
    try {
      const { rerender } = renderHook(
        ({ c, fx }: { c: FrameBackdropChoice; fx: boolean }) => useFrameBackdropChrome(c, '#f0a24a', fx),
        { initialProps: { c: { id: 'corner' } as FrameBackdropChoice, fx: true } }
      );
      expect(chrome).not.toHaveBeenCalled();

      rerender({ c: { id: 'solid', solidLevel: 'full' }, fx: true });
      expect(document.documentElement.classList.contains('fb-light-surface')).toBe(true);
      expect(chrome).toHaveBeenLastCalledWith({ panel: '#f0a24a', ink: '#111112', appearance: getTheme().appearance });

      rerender({ c: { id: 'solid', solidLevel: 'full' }, fx: false });
      expect(document.documentElement.classList.contains('fb-light-surface')).toBe(false);
      const theme = getTheme();
      expect(chrome).toHaveBeenLastCalledWith({ panel: theme.colors['bg-frame'], ink: theme.colors.ink, appearance: theme.appearance });
    } finally {
      spy.mockRestore();
      document.documentElement.classList.remove('fb-light-surface');
    }
  });
});
