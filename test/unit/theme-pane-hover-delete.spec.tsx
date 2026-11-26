/**
 * 设置 → 主题列表行内删除（不必先选中）：
 * - 内置 dark/light 不出现删除按钮；
 * - 自定义主题行有删除入口，点击不切换该主题，打开确认弹窗；
 * - 确认后 themes.remove(id)，列表原地刷新；删正在使用的主题走回落文案；
 * - 显隐过渡只用 --dur-micro / --ease-hover（禁字面量时长）。
 * window.api 由 setup.ts 的 api-mock 提供。
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemePane } from '../../src/renderer/src/components/settings/ThemePane';
import { builtinTheme, type ThemeListView, type WorkbenchTheme } from '../../src/shared/theme';
import { currentApiMock } from './helpers/api-mock';

const here = dirname(fileURLToPath(import.meta.url));
const dark = builtinTheme('dark')!;
const light = builtinTheme('light')!;
const custom: WorkbenchTheme = { ...dark, id: 'night-blue', name: '夜蓝', builtin: false };

function metaOf(theme: WorkbenchTheme): ThemeListView['themes'][number] {
  return {
    id: theme.id,
    name: theme.name,
    appearance: theme.appearance,
    builtin: !!theme.builtin,
    preview: { bg: theme.colors['bg-panel'], ink: theme.colors.ink, accent: theme.colors.blue }
  };
}

function installThemes(opts?: { activeId?: string; extra?: WorkbenchTheme[] }): void {
  let catalog: WorkbenchTheme[] = [dark, light, custom, ...(opts?.extra ?? [])];
  let activeId = opts?.activeId ?? 'dark';
  const mock = currentApiMock();

  const viewOf = (): ThemeListView => {
    const active = catalog.find((th) => th.id === activeId) ?? catalog[0]!;
    return {
      activeId: active.id,
      active,
      themes: catalog.map(metaOf),
      dir: 'C:/themes',
      globalThemeId: active.id
    };
  };

  mock.override('themes.list', () => Promise.resolve(viewOf()));
  mock.override('themes.get', (id) => {
    const theme = catalog.find((th) => th.id === String(id));
    return theme
      ? Promise.resolve({ ok: true, theme })
      : Promise.resolve({ ok: false, error: '主题不存在' });
  });
  mock.override('themes.activate', () => Promise.resolve({ ok: true }));
  mock.override('themes.remove', (id) => {
    const key = String(id);
    const hit = catalog.find((th) => th.id === key);
    if (!hit) return Promise.resolve({ ok: false, error: '主题不存在' });
    if (hit.builtin) return Promise.resolve({ ok: false, error: '内置主题不可删除' });
    catalog = catalog.filter((th) => th.id !== key);
    if (activeId === key) activeId = 'dark';
    return Promise.resolve({ ok: true });
  });
}

async function renderPane(): Promise<void> {
  render(<ThemePane />);
  await waitFor(() => {
    expect(document.querySelector('[data-theme-id="dark"]')).toBeTruthy();
  });
}

describe('ThemePane 主题列表行内删除', () => {
  it('内置 dark/light 无行内删除；自定义主题有删除入口', async () => {
    installThemes();
    await renderPane();

    expect(screen.queryByRole('button', { name: '删除主题「深色（默认）」' })).toBeNull();
    expect(screen.queryByRole('button', { name: '删除主题「浅色」' })).toBeNull();
    expect(document.querySelector('[data-theme-id="dark"] .theme-row-del')).toBeNull();
    expect(document.querySelector('[data-theme-id="light"] .theme-row-del')).toBeNull();
    expect(screen.getByRole('button', { name: '删除主题「夜蓝」' })).toBeTruthy();
  });

  it('点行内删除不先切换该主题，首次点击只打开确认弹窗', async () => {
    installThemes();
    await renderPane();
    const mock = currentApiMock();
    const getCallsBefore = mock.mockOf('themes.get').mock.calls.length;
    const activateBefore = mock.mockOf('themes.activate').mock.calls.length;

    await userEvent.click(screen.getByRole('button', { name: '删除主题「夜蓝」' }));

    const dialog = await screen.findByRole('dialog', { name: '确认删除主题「夜蓝」？' });
    expect(within(dialog).getByRole('button', { name: '确认删除' })).toBeTruthy();
    expect(document.querySelector('.theme-pane')?.contains(dialog)).toBe(false);
    expect(mock.mockOf('themes.remove')).not.toHaveBeenCalled();
    expect(
      mock.mockOf('themes.get').mock.calls.slice(getCallsBefore).some((c) => c[0] === 'night-blue')
    ).toBe(false);
    expect(
      mock
        .mockOf('themes.activate')
        .mock.calls.slice(activateBefore)
        .some((c) => c[0] === 'night-blue')
    ).toBe(false);
    // 右侧编辑器仍是默认选中的内置深色
    expect(document.querySelector('[data-theme-id="dark"]')?.className).toContain('is-selected');
    expect(screen.getByText('内置主题不可编辑')).toBeTruthy();
  });

  it('确认删除后调用 remove 且列表原地刷新，未选中项消失', async () => {
    installThemes();
    await renderPane();
    const mock = currentApiMock();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: '删除主题「夜蓝」' }));
    await user.click(within(await screen.findByRole('dialog', { name: '确认删除主题「夜蓝」？' })).getByRole('button', { name: '确认删除' }));

    await waitFor(() => {
      expect(mock.mockOf('themes.remove').mock.calls[0]?.[0]).toBe('night-blue');
    });
    await waitFor(() => {
      expect(screen.queryByText('夜蓝')).toBeNull();
    });
    expect(await screen.findByText('已删除')).toBeTruthy();
    expect(document.querySelector('[data-theme-id="dark"]')).toBeTruthy();
    expect(document.querySelector('[data-theme-id="light"]')).toBeTruthy();
    expect(document.querySelector('[data-theme-id="night-blue"]')).toBeNull();
  });

  it('删除正在使用的自定义主题 → 回落文案，列表切到新的生效主题', async () => {
    installThemes({ activeId: 'night-blue' });
    await renderPane();
    const user = userEvent.setup();

    expect(screen.getAllByText('夜蓝').length).toBeGreaterThan(0);
    await user.click(screen.getByRole('button', { name: '删除主题「夜蓝」' }));
    await user.click(within(await screen.findByRole('dialog', { name: '确认删除主题「夜蓝」？' })).getByRole('button', { name: '确认删除' }));

    expect(await screen.findByText('已删除，界面回落到「深色（默认）」')).toBeTruthy();
    expect(screen.queryByText('夜蓝')).toBeNull();
    expect(document.querySelector('[data-theme-id="dark"]')?.className).toMatch(/is-selected/);
  });

  it('行内删除显隐过渡只用 motion token，不写字面量时长', () => {
    const css = readFileSync(resolve(here, '../../src/renderer/src/styles/settings.css'), 'utf8');
    const block = css.match(/\.theme-row-del\s*\{[\s\S]*?\n\}/)?.[0];
    expect(block).toBeTruthy();
    expect(block).toContain('opacity var(--dur-micro) var(--ease-hover)');
    // 隐态不得用 visibility:hidden：Tab 焦点会跳过该按钮，键盘永不可达
    // （键盘可达性契约由 test/theme-del-keyboard-css.mjs 守）
    expect(block).not.toContain('visibility');
    expect(block).toContain('pointer-events: none');
    expect(block).not.toMatch(/\d+ms/);
    expect(block).not.toContain('cubic-bezier');
    expect(css).toContain('.theme-row:hover .theme-row-del');
    expect(css).toContain('.theme-row-del.is-armed');
  });
});
