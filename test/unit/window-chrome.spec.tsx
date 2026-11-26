import { act, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { syncWindowChrome } from '../../src/renderer/src/windowChrome';
import { applyTheme } from '../../src/renderer/src/theme';
import { builtinTheme } from '../../src/shared/theme';
import { currentApiMock } from './helpers/api-mock';
import { isWebGateway } from '../../src/renderer/src/webGatewayEnvironment';

vi.mock('../../src/renderer/src/webGatewayEnvironment', () => ({ isWebGateway: vi.fn(() => false) }));
const colors = { panel: '#202023', ink: '#ededee', appearance: 'dark' as const };
beforeEach(() => { vi.mocked(isWebGateway).mockReturnValue(false); });
afterEach(() => { delete document.documentElement.dataset.nativeMaterial; });

describe('native window chrome confirmation', () => {
  it('keeps surfaces opaque while pending, then reveals Mica only after host confirmation', async () => {
    let complete!: (value: { ok: boolean; material: string }) => void;
    currentApiMock().mockOf('app.setChromeTheme').mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    const pending = syncWindowChrome(colors);
    expect(document.documentElement.dataset.nativeMaterial).not.toBe('mica');
    complete({ ok: true, material: 'mica' });
    await pending;
    expect(document.documentElement.dataset.nativeMaterial).toBe('mica');
  });

  it('passes actual theme appearance and keeps Mica through dark/light switches', async () => {
    const chrome = currentApiMock().mockOf('app.setChromeTheme').mockResolvedValue({ ok: true, material: 'mica' });
    act(() => applyTheme(builtinTheme('light')!));
    await waitFor(() => expect(document.documentElement.dataset.nativeMaterial).toBe('mica'));
    expect(chrome).toHaveBeenLastCalledWith(expect.objectContaining({ appearance: 'light' }));
    act(() => applyTheme(builtinTheme('dark')!));
    await waitFor(() => expect(chrome).toHaveBeenLastCalledWith(expect.objectContaining({ appearance: 'dark' })));
    expect(document.documentElement.dataset.nativeMaterial).toBe('mica');
  });

  it('retains solid rendering on unsupported hosts and legacy replies', async () => {
    const chrome = currentApiMock().mockOf('app.setChromeTheme');
    for (const reply of [{ ok: true, material: 'solid' }, { ok: true }, { ok: false }, undefined]) {
      document.documentElement.dataset.nativeMaterial = 'mica';
      chrome.mockResolvedValue(reply);
      await syncWindowChrome(colors);
      expect(document.documentElement.dataset.nativeMaterial).toBe('solid');
    }
  });

  it('reveals macOS Vibrancy when the host confirms it', async () => {
    currentApiMock().mockOf('app.setChromeTheme').mockResolvedValue({ ok: true, material: 'vibrancy' });
    await syncWindowChrome(colors);
    expect(document.documentElement.dataset.nativeMaterial).toBe('vibrancy');
  });

  it('never exposes native transparency in a browser gateway client', async () => {
    vi.mocked(isWebGateway).mockReturnValue(true);
    currentApiMock().mockOf('app.setChromeTheme').mockResolvedValue({ ok: true, material: 'mica' });
    await syncWindowChrome(colors);
    expect(document.documentElement.dataset.nativeMaterial).toBe('solid');
  });

  it('ignores an older Mica reply after a newer solid reply', async () => {
    let complete!: (value: { ok: boolean; material: string }) => void;
    const chrome = currentApiMock().mockOf('app.setChromeTheme');
    chrome.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const old = syncWindowChrome(colors);
    chrome.mockResolvedValueOnce({ ok: true, material: 'solid' });
    await syncWindowChrome(colors);
    complete({ ok: true, material: 'mica' });
    await old;
    expect(document.documentElement.dataset.nativeMaterial).toBe('solid');
  });

  it('reports a rejected bridge call and restores an opaque renderer', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    currentApiMock().mockOf('app.setChromeTheme').mockRejectedValue(new Error('bridge unavailable'));
    document.documentElement.dataset.nativeMaterial = 'mica';
    await syncWindowChrome(colors);
    expect(document.documentElement.dataset.nativeMaterial).toBe('solid');
    expect(warning).toHaveBeenCalled();
    warning.mockRestore();
  });
});
