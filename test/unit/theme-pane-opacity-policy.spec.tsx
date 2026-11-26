import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import { ThemePane } from '../../src/renderer/src/components/settings/ThemePane';
import { builtinTheme, type WorkbenchTheme, type ThemeListView } from '../../src/shared/theme';
import { currentApiMock } from './helpers/api-mock';

it('keeps surface opacity fixed, allows overlay opacity, and previews without overwriting the saved theme cache', async () => {
  const theme: WorkbenchTheme = { ...builtinTheme('dark')!, id: 'color-fixture', name: '测试配色', builtin: false };
  const view: ThemeListView = {
    activeId: theme.id, active: theme, globalThemeId: theme.id, dir: 'C:/themes',
    themes: [{ id: theme.id, name: theme.name, appearance: 'dark', builtin: false, preview: { bg: theme.colors['bg-panel'], ink: theme.colors.ink, accent: theme.colors.blue } }]
  };
  const mock = currentApiMock();
  mock.override('themes.list', () => Promise.resolve(view));
  mock.override('themes.get', () => Promise.resolve({ ok: true, theme }));
  mock.override('themes.activate', () => Promise.resolve({ ok: true, theme }));
  localStorage.setItem('muster.theme.cache.v1', 'saved-theme-cache');
  localStorage.setItem('muster.appearance.boot.v1', 'saved-boot-cache');
  render(<ThemePane />);
  const row = (key: string) => document.querySelector(`[data-settings-item="theme-color:${key}"]`)!;
  await waitFor(() => expect(row('bg-panel')).toBeTruthy());
  expect((row('bg-panel').querySelector('input[type="range"]') as HTMLInputElement).disabled).toBe(true);
  expect((row('background').querySelector('input[type="range"]') as HTMLInputElement).disabled).toBe(true);
  expect((row('hover-fill').querySelector('input[type="range"]') as HTMLInputElement).disabled).toBe(false);
  fireEvent.change(row('bg-panel').querySelector('input[type="text"]')!, { target: { value: '#181418' } });
  expect(localStorage.getItem('muster.theme.cache.v1')).toBe('saved-theme-cache');
  expect(localStorage.getItem('muster.appearance.boot.v1')).toBe('saved-boot-cache');
  fireEvent.change(row('bg-panel').querySelector('input[type="text"]')!, { target: { value: 'rgba(20,20,20,0.5)' } });
  expect(row('bg-panel').querySelector('input[type="text"]')!.classList.contains('is-bad')).toBe(true);
});
