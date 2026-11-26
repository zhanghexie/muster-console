import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getInteractionPreferences,
  initInteractionPreferences,
  prefersReducedMotionPreference,
  setInteractionPreferences,
  subscribeInteractionPreferences,
  useInteractionPreferences
} from '../../src/renderer/src/interactionPreferences';
import { GeneralPane } from '../../src/renderer/src/components/settings/GeneralPane';
import type { AppConfig } from '../../src/shared/types';
import { currentApiMock } from './helpers/api-mock';

const key = 'muster.interaction.v1';
const defaults = { scrollFeel: 'native', scrollDistance: 1, motion: 'system' };
let stop: () => void;
let systemReduced = false;
let onMediaChange: (() => void) | undefined;

beforeEach(() => {
  // Stop the prior singleton before replacing its media query (also handles another component's lazy init).
  initInteractionPreferences()();
  localStorage.removeItem(key);
  systemReduced = false;
  onMediaChange = undefined;
  vi.stubGlobal('matchMedia', vi.fn(() => ({
    get matches() { return systemReduced; },
    addEventListener: (_: string, listener: () => void) => { onMediaChange = listener; },
    removeEventListener: () => { onMediaChange = undefined; }
  })));
  stop = initInteractionPreferences();
});

afterEach(() => {
  cleanup();
  stop();
  localStorage.removeItem(key);
  delete document.documentElement.dataset.uiMotion;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function restart(raw: string): void {
  stop();
  localStorage.setItem(key, raw);
  stop = initInteractionPreferences();
}

function PrefProbe() {
  const value = useInteractionPreferences();
  return <output data-testid="prefs">{JSON.stringify(value)}</output>;
}

describe('interaction preferences', () => {
  it('defaults to native/1/system, restores valid local state before React, and bounds distance', () => {
    expect(getInteractionPreferences()).toEqual(defaults);
    expect(document.documentElement.dataset.uiMotion).toBe('system');
    restart(JSON.stringify({ scrollFeel: 'soft', scrollDistance: 9, motion: 'subtle', extra: true }));
    expect(getInteractionPreferences()).toEqual({ scrollFeel: 'soft', scrollDistance: 2, motion: 'subtle' });
    expect(document.documentElement.dataset.uiMotion).toBe('subtle');
    setInteractionPreferences({ scrollDistance: -4 });
    expect(getInteractionPreferences().scrollDistance).toBe(0.5);
  });

  it('ignores corrupt/unsupported storage and invalid patches without corrupting other preferences', () => {
    for (const raw of ['{', 'null', '[]', '{"scrollFeel":"mystery","motion":"fast","scrollDistance":"2"}']) {
      restart(raw);
      expect(getInteractionPreferences()).toEqual(defaults);
    }
    setInteractionPreferences({ scrollFeel: 'crisp', motion: 'subtle' });
    setInteractionPreferences({ scrollDistance: Number.NaN, motion: 'bad' as 'system' });
    expect(getInteractionPreferences()).toEqual({ scrollFeel: 'crisp', scrollDistance: 1, motion: 'subtle' });
  });

  it('persists same-window updates, shares stable snapshots and stops notifying disposed subscribers', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeInteractionPreferences(listener);
    const before = getInteractionPreferences();
    setInteractionPreferences({});
    expect(getInteractionPreferences()).toBe(before);
    expect(listener).not.toHaveBeenCalled();
    setInteractionPreferences({ scrollFeel: 'crisp', scrollDistance: 1.25 });
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual({ ...defaults, scrollFeel: 'crisp', scrollDistance: 1.25 });
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    setInteractionPreferences({ motion: 'reduced' });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(prefersReducedMotionPreference()).toBe(true);
  });

  it('updates mounted consumers on storage changes/clear, while ignoring unrelated or session storage', () => {
    render(<PrefProbe />);
    const emitStorage = (event: StorageEventInit) => act(() => {
      window.dispatchEvent(new StorageEvent('storage', event));
    });
    emitStorage({ key: 'other', newValue: '{"motion":"reduced"}' });
    emitStorage({ key, newValue: '{"motion":"reduced"}', storageArea: sessionStorage });
    expect(getInteractionPreferences()).toEqual(defaults);
    emitStorage({ key, newValue: '{"motion":"reduced","scrollFeel":"soft"}', storageArea: localStorage });
    expect(screen.getByTestId('prefs').textContent).toContain('"scrollFeel":"soft"');
    expect(document.documentElement.dataset.uiMotion).toBe('reduced');
    emitStorage({ key: null, storageArea: localStorage });
    expect(screen.getByTestId('prefs').textContent).toBe(JSON.stringify(defaults));
  });

  it('notifies live OS changes even when the preference snapshot stays identical; system reduction wins', () => {
    setInteractionPreferences({ motion: 'subtle' });
    const before = getInteractionPreferences();
    const listener = vi.fn();
    const unsubscribe = subscribeInteractionPreferences(listener);
    systemReduced = true;
    act(() => onMediaChange?.());
    expect(getInteractionPreferences()).toBe(before);
    expect(prefersReducedMotionPreference()).toBe(true);
    expect(document.documentElement.dataset.uiMotion).toBe('reduced');
    systemReduced = false;
    act(() => onMediaChange?.());
    expect(prefersReducedMotionPreference()).toBe(false);
    expect(document.documentElement.dataset.uiMotion).toBe('subtle');
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it('keeps the immediate local setting if storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage disabled'); });
    expect(() => setInteractionPreferences({ motion: 'reduced' })).not.toThrow();
    expect(prefersReducedMotionPreference()).toBe(true);
    expect(document.documentElement.dataset.uiMotion).toBe('reduced');
  });
});

describe('GeneralPane interaction preferences', () => {
  it('applies/persists controls immediately, enables distance only for enhancement and restores defaults without AppConfig drafts', async () => {
    const setDraft = vi.fn();
    render(<GeneralPane cfg={{} as AppConfig} set={setDraft} />);
    const distance = () => screen.getByRole('button', { name: '每格滚动距离' }) as HTMLButtonElement;
    expect(distance().disabled).toBe(true);
    fireEvent.click(within(screen.getByRole('group', { name: '滚动手感' })).getByRole('button', { name: '利落' }));
    expect(distance().disabled).toBe(false);
    fireEvent.click(distance());
    fireEvent.click(screen.getByRole('option', { name: '1.5×' }));
    fireEvent.click(within(screen.getByRole('group', { name: '界面动效' })).getByRole('button', { name: '减少' }));
    expect(getInteractionPreferences()).toEqual({ scrollFeel: 'crisp', scrollDistance: 1.5, motion: 'reduced' });
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual(getInteractionPreferences());
    expect(document.documentElement.dataset.uiMotion).toBe('reduced');
    fireEvent.click(screen.getByRole('button', { name: '恢复交互默认值' }));
    expect(getInteractionPreferences()).toEqual(defaults);
    expect(distance().disabled).toBe(true);
    expect(setDraft).not.toHaveBeenCalled();
    expect(currentApiMock().mockOf('config.update')).not.toHaveBeenCalled();
    await act(async () => {});
  });
});
