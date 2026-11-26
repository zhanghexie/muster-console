/** 外观页只提供色彩主题；旧背景配置仍可读取，但不再暴露效果入口。 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { ThemePane } from '../../src/renderer/src/components/settings/ThemePane';
import { builtinTheme, type ThemeListView } from '../../src/shared/theme';
import { currentApiMock } from './helpers/api-mock';

const dark = builtinTheme('dark')!;

it('外观页不再提供渐变、毛玻璃、窗口背景与灯带入口', async () => {
  const view: ThemeListView = {
    activeId: 'dark',
    active: dark,
    themes: [{
      id: dark.id,
      name: dark.name,
      appearance: dark.appearance,
      builtin: true,
      preview: { bg: dark.colors['bg-panel'], ink: dark.colors.ink, accent: dark.colors.blue }
    }],
    dir: 'C:/themes',
    globalThemeId: 'dark'
  };
  const mock = currentApiMock();
  mock.override('themes.list', () => Promise.resolve(view));
  mock.override('themes.get', () => Promise.resolve({ ok: true, theme: dark }));
  mock.override('themes.activate', () => Promise.resolve({ ok: true }));

  render(<ThemePane />);
  await waitFor(() => expect(document.querySelector('[data-theme-id="dark"]')).toBeTruthy());
  expect(screen.queryByRole('checkbox', { name: '渐变与毛玻璃' })).toBeNull();
  expect(screen.queryByRole('checkbox', { name: '全局面板周围灯带' })).toBeNull();
  expect(screen.queryByRole('radiogroup', { name: '窗口背景' })).toBeNull();
});
