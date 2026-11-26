import { renderWithAppTips as render, findAppTip, getAppTip } from './helpers/app-tips';
import React, { useMemo, useReducer, useState } from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserHome } from '../../src/renderer/src/components/BrowserHome';
import { BookmarksPanel } from '../../src/renderer/src/components/BookmarksPanel';
import { RightWorkspaceContext } from '../../src/renderer/src/rightWorkspace';
import { activeRightTab, initialRightWorkspace, reduceRightWorkspace, type BookmarkNode, type RightAction, type RightWorkspaceModel } from '../../src/shared/rightWorkspace';
import { applyLocaleSetting } from '../../src/shared/i18n';
import { currentApiMock } from './helpers/api-mock';
import * as appearanceStorage from '../../src/renderer/src/browserHomeAppearance';
import { HOME_SEARCH_PRESETS, readHomeSearchPreferences } from '../../src/renderer/src/browserHomePreferences';

const uiFlashTip = vi.hoisted(() => vi.fn());
vi.mock('../../src/renderer/src/store', () => ({ useUiStore: () => ({ flashTip: uiFlashTip }) }));
vi.mock('../../src/renderer/src/browserHomeAppearance', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/renderer/src/browserHomeAppearance')>(),
  readHomeWallpaper: vi.fn(), saveHomeWallpaper: vi.fn(), deleteHomeWallpaper: vi.fn(), validateHomeWallpaper: vi.fn()
}));

let model: RightWorkspaceModel;
let dispatch: React.Dispatch<RightAction>;
function Harness({ visible = true, secondHome = false, initialBookmarks }: { visible?: boolean; secondHome?: boolean; initialBookmarks?: BookmarkNode[] }): React.JSX.Element {
  const [state, send] = useReducer(reduceRightWorkspace, undefined, () => reduceRightWorkspace(
    reduceRightWorkspace(initialRightWorkspace('ws', 's1'), { type: 'hydrate', workspaceId: 'ws' }), {
    type: 'bookmarkSnapshot', workspaceId: 'ws', saved: { version: 1, bookmarkDefaultsVersion: 1, bookmarks: initialBookmarks ?? [
      { id: 'folder', label: '资料', children: [] }, { id: 'site', label: '文档', url: 'https://example.test/docs' }
    ] }
  }));
  model = state; dispatch = send;
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const bridge = useMemo(() => ({ model: state, current: activeRightTab(state), toolbar: null, resourceHosts: { files: null, git: null, browser: host }, dispatch: send, open: (content: RightWorkspaceModel['tabs'][number]['content'], source?: 'preview' | 'keep', scope: 'workspace' | 'session' = 'workspace') => send({ type: 'open', content, source, scope }), registerFile: () => {} }), [state, host]);
  return <RightWorkspaceContext.Provider value={bridge}><div ref={setHost}/><BookmarksPanel/><BrowserHome tabId="home" visible={visible} active={visible} workspaceId="ws" sessionId="s1"/>{secondHome ? <BrowserHome tabId="home-2" visible={visible} active={false} workspaceId="ws" sessionId="s1"/> : null}</RightWorkspaceContext.Provider>;
}

beforeEach(() => {
  localStorage.clear(); uiFlashTip.mockReset();
  vi.mocked(appearanceStorage.readHomeWallpaper).mockReset();
  vi.mocked(appearanceStorage.saveHomeWallpaper).mockReset();
  vi.mocked(appearanceStorage.deleteHomeWallpaper).mockReset();
  vi.mocked(appearanceStorage.validateHomeWallpaper).mockReset();
});

describe('new tab bookmarks', () => {
  it('opens links from a shared home in the workspace after switching sessions', async () => {
    const api = currentApiMock(); render(<Harness/>);
    act(() => {
      dispatch({ type: 'open', scope: 'workspace', content: { kind: 'web', browserId: 'home', url: 'muster-home://new/shared', title: '主页' } });
      dispatch({ type: 'scope', workspaceId: 'ws', sessionId: 's2' });
    });
    const navigation = screen.getByRole('toolbar', { name: '收藏导航操作' });
    fireEvent.click(within(navigation).getByRole('button', { name: '下一项' }));
    fireEvent.click(within(navigation).getByRole('button', { name: '打开选中收藏' }));
    await waitFor(() => expect(api.mockOf('browser.open')).toHaveBeenCalledWith({ url: 'https://example.test/docs', workspaceId: 'ws', sessionId: 's1', scope: 'workspace', openerId: 'home', background: false }));
  });
  it('localizes untouched defaults and searches their displayed names without rewriting user data', () => {
    const defaults: BookmarkNode[] = [
      { id: 'default-work', label: '工作', children: [{ id: 'default-doubao', label: '豆包', url: 'https://www.doubao.com/' }] },
      { id: 'custom', label: '工作', children: [] },
      { id: 'default-doubao-2', label: '豆包', url: 'https://mine.test/' }
    ];
    render(<Harness initialBookmarks={defaults}/>);
    const snapshot = JSON.stringify(model.bookmarks.ws);
    try {
      act(() => { applyLocaleSetting('en'); });
      const sidebar = document.querySelector('.right-bookmarks') as HTMLElement;
      expect(within(sidebar).getByRole('button', { name: 'Work' })).toBeTruthy();
      expect(within(sidebar).getByRole('button', { name: '工作' })).toBeTruthy();
      const search = screen.getByRole('textbox', { name: 'Search bookmarks or the web' });
      fireEvent.change(search, { target: { value: 'Doubao' } });
      const results = document.querySelector('.browser-home-search-results') as HTMLElement;
      expect(within(results).getByRole('button', { name: /Doubao.*Work/ })).toBeTruthy();
      expect(within(results).getByRole('button', { name: 'Bilibili' })).toBeTruthy();
      expect(within(results).getByRole('button', { name: 'Zhihu' })).toBeTruthy();
      expect(readHomeSearchPreferences().engines.find(engine => engine.id === 'bilibili')?.name).toBe('哔哩哔哩');
      expect(JSON.stringify(model.bookmarks.ws)).toBe(snapshot);
      fireEvent.contextMenu(within(sidebar).getByRole('button', { name: 'Work' }));
      fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Rename' }));
      const dialog = screen.getByRole('dialog', { name: 'Rename' });
      const input = within(dialog).getByLabelText('Name') as HTMLInputElement;
      expect(input.value).toBe('工作');
      fireEvent.change(input, { target: { value: '我的工作' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
      expect(model.bookmarks.ws[0].label).toBe('我的工作');
      expect(within(sidebar).getByRole('button', { name: '我的工作' })).toBeTruthy();
    } finally { act(() => { applyLocaleSetting('zh-CN'); }); }
  });
  it('synchronizes wallpaper and panel transparency without replacing the bookmark list', () => {
    render(<Harness secondHome/>);
    const homes = [...document.querySelectorAll<HTMLElement>('.browser-home')];
    const firstList = within(homes[0]).getByRole('region', { name: '收藏夹导航' });
    fireEvent.click(within(homes[0]).getByRole('button', { name: '壁纸与透明度' }));
    const dialog = screen.getByRole('dialog', { name: '壁纸与透明度' });
    const fileClick = vi.spyOn(within(dialog).getByLabelText('选择壁纸图片'), 'click').mockImplementation(() => {});
    fireEvent.click(within(dialog).getByRole('button', { name: '选择图片' }));
    expect(fileClick).toHaveBeenCalledOnce();
    const transparency = within(dialog).getByRole('slider', { name: '材质透明度' });
    const blur = within(dialog).getByRole('slider', { name: '材质模糊' }) as HTMLInputElement;
    expect(blur.value).toBe('0');
    fireEvent.change(transparency, { target: { value: '20' } });
    expect(appearanceStorage.readHomeAppearance().transparency).toBe(4);
    expect(transparency.getAttribute('aria-valuetext')).toBe('4%');
    expect(homes.map(home => home.style.getPropertyValue('--browser-home-panel-opacity'))).toEqual(['96%', '96%']);
    fireEvent.change(transparency, { target: { value: '100' } });
    expect(homes.map(home => home.style.getPropertyValue('--browser-home-panel-opacity'))).toEqual(['0%', '0%']);
    expect(homes[0].style.getPropertyValue('--browser-home-control-opacity')).toBe('45%');
    expect(homes[0].style.getPropertyValue('--browser-home-selection-opacity')).toBe('40%');
    expect(homes[0].style.getPropertyValue('--browser-home-border-opacity')).toBe('30%');
    fireEvent.change(blur, { target: { value: '16' } });
    expect(homes.map(home => home.style.getPropertyValue('--browser-home-material-blur'))).toEqual(['16px', '16px']);
    expect(homes.every(home => home.classList.contains('has-material-blur'))).toBe(true);
    expect(homes.every(home => !home.querySelector('.browser-home-wallpaper-image')?.classList.contains('is-blurred'))).toBe(true);
    expect(homes.every(home => !home.style.filter)).toBe(true);
    fireEvent.click(within(dialog).getByRole('button', { name: '无壁纸' }));
    expect(homes.every(home => !home.classList.contains('browser-home-wallpaper-default'))).toBe(true);
    expect(appearanceStorage.readHomeAppearance()).toEqual({ wallpaper: 'none', transparency: 100, blur: 16 });
    fireEvent.click(within(dialog).getByRole('button', { name: '默认壁纸' }));
    expect(homes.every(home => home.classList.contains('browser-home-wallpaper-default'))).toBe(true);
    expect(within(homes[0]).getByRole('region', { name: '收藏夹导航' })).toBe(firstList);
    fireEvent.click(within(dialog).getByRole('button', { name: '关闭' }));
    expect(dialog.closest('[data-overlay-root]')?.getAttribute('aria-hidden')).toBe('true');
  });
  it('preserves legacy transparency and defaults material blur to zero', () => {
    localStorage.setItem('muster.browser.home.appearance.v1', JSON.stringify({ wallpaper: 'none', transparency: 60 }));
    expect(appearanceStorage.readHomeAppearance()).toEqual({ wallpaper: 'none', transparency: 60, blur: 0 });
    render(<Harness/>);
    fireEvent.click(screen.getByRole('button', { name: '壁纸与透明度' }));
    const dialog = screen.getByRole('dialog', { name: '壁纸与透明度' });
    const transparency = within(dialog).getByRole('slider', { name: '材质透明度' }) as HTMLInputElement;
    expect(transparency.value).toBe('77');
    expect(transparency.getAttribute('aria-valuetext')).toBe('60%');
    expect((within(dialog).getByRole('slider', { name: '材质模糊' }) as HTMLInputElement).value).toBe('0');
  });
  it('maps every keyboard step to a distinct reversible transparency value', () => {
    for (let position = 0; position <= 100; position++) {
      const transparency = appearanceStorage.homeTransparencyFromSlider(position);
      expect(appearanceStorage.homeTransparencyToSlider(transparency)).toBe(position);
      if (position > 0) expect(transparency).toBeGreaterThan(appearanceStorage.homeTransparencyFromSlider(position - 1));
    }
  });
  it('saves a chosen image and reports invalid images without changing the current wallpaper', async () => {
    const images = new Map<string, Blob>();
    vi.mocked(appearanceStorage.validateHomeWallpaper).mockResolvedValue(undefined);
    vi.mocked(appearanceStorage.saveHomeWallpaper).mockImplementation(async (id, file) => { images.set(id, file); });
    vi.mocked(appearanceStorage.readHomeWallpaper).mockImplementation(async id => images.get(id)!);
    vi.mocked(appearanceStorage.deleteHomeWallpaper).mockImplementation(async id => { images.delete(id); });
    const originalCreate = URL.createObjectURL, originalRevoke = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn(() => 'blob:home-wallpaper'); URL.revokeObjectURL = vi.fn();
    let view: ReturnType<typeof render> | undefined;
    try {
      view = render(<Harness secondHome/>);
      const homes = [...document.querySelectorAll<HTMLElement>('.browser-home')];
      fireEvent.click(within(homes[0]).getByRole('button', { name: '壁纸与透明度' }));
      const dialog = screen.getByRole('dialog', { name: '壁纸与透明度' });
      fireEvent.change(within(dialog).getByRole('slider', { name: '材质模糊' }), { target: { value: '12' } });
      const input = within(dialog).getByLabelText('选择壁纸图片');
      fireEvent.change(input, { target: { files: [new File(['image'], 'wallpaper.png', { type: 'image/png' })] } });
      await waitFor(() => expect(appearanceStorage.readHomeAppearance().wallpaper).toBe('custom'));
      await waitFor(() => expect(homes.every(home => (home.querySelector('.browser-home-wallpaper-image') as HTMLElement).style.backgroundImage.includes('blob:home-wallpaper'))).toBe(true));
      const saved = appearanceStorage.readHomeAppearance();
      expect(saved.blur).toBe(12);
      expect(images.has(saved.wallpaperId!)).toBe(true);
      vi.mocked(appearanceStorage.validateHomeWallpaper).mockRejectedValueOnce(new Error('type'));
      fireEvent.change(input, { target: { files: [new File(['bad'], 'bad.txt', { type: 'text/plain' })] } });
      expect((await findAppTip()).textContent).toContain('请选择有效的图片文件');
      expect(appearanceStorage.readHomeAppearance()).toEqual(saved);
      fireEvent.click(within(dialog).getByRole('button', { name: '无壁纸' }));
      await waitFor(() => expect(images.has(saved.wallpaperId!)).toBe(false));
    } finally { view?.unmount(); URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke; }
  });
  it('keeps the old appearance and removes the new image when saving preferences fails', async () => {
    vi.mocked(appearanceStorage.validateHomeWallpaper).mockResolvedValue(undefined);
    vi.mocked(appearanceStorage.saveHomeWallpaper).mockResolvedValue(undefined);
    vi.mocked(appearanceStorage.deleteHomeWallpaper).mockResolvedValue(undefined);
    render(<Harness/>);
    fireEvent.click(screen.getByRole('button', { name: '壁纸与透明度' }));
    const dialog = screen.getByRole('dialog', { name: '壁纸与透明度' });
    const setItem = Storage.prototype.setItem;
    const failure = vi.spyOn(Storage.prototype, 'setItem').mockImplementation((key, value) => {
      if (key === 'muster.browser.home.appearance.v1') throw new Error('storage unavailable');
      setItem.call(localStorage, key, value);
    });
    try {
      fireEvent.change(within(dialog).getByLabelText('选择壁纸图片'), { target: { files: [new File(['image'], 'wallpaper.png', { type: 'image/png' })] } });
      expect((await findAppTip()).textContent).toContain('storage unavailable');
      expect(appearanceStorage.readHomeAppearance().wallpaper).toBe('default');
      expect(appearanceStorage.deleteHomeWallpaper).toHaveBeenCalledWith(vi.mocked(appearanceStorage.saveHomeWallpaper).mock.lastCall?.[0]);
    } finally { failure.mockRestore(); }
  });
  it('reports an unavailable saved wallpaper and a failure after closing the dialog', async () => {
    appearanceStorage.writeHomeAppearance({ wallpaper: 'custom', wallpaperId: 'missing', transparency: 25, blur: 0 });
    vi.mocked(appearanceStorage.readHomeWallpaper).mockRejectedValue(new Error('missing image'));
    render(<Harness/>);
    await waitFor(() => expect(uiFlashTip).toHaveBeenCalledWith(expect.stringContaining('missing image')));
    fireEvent.click(screen.getByRole('button', { name: '壁纸与透明度' }));
    const dialog = screen.getByRole('dialog', { name: '壁纸与透明度' });
    expect(getAppTip().textContent).toContain('missing image');
    vi.mocked(appearanceStorage.validateHomeWallpaper).mockResolvedValue(undefined);
    let rejectSave: (reason: Error) => void = () => {};
    vi.mocked(appearanceStorage.saveHomeWallpaper).mockImplementation(() => new Promise((_resolve, reject) => { rejectSave = reject; }));
    fireEvent.change(within(dialog).getByLabelText('选择壁纸图片'), { target: { files: [new File(['image'], 'wallpaper.png', { type: 'image/png' })] } });
    await waitFor(() => expect(appearanceStorage.saveHomeWallpaper).toHaveBeenCalled());
    fireEvent.click(within(dialog).getByRole('button', { name: '关闭' }));
    await act(async () => rejectSave(new Error('disk full')));
    await waitFor(() => expect(uiFlashTip).toHaveBeenCalledWith(expect.stringContaining('disk full')));
  });
  it('makes footer navigation, opening, selection and organize controls interactive', async () => {
    const api = currentApiMock();
    render(<Harness/>);
    const list = screen.getByRole('region', { name: '收藏夹导航' });
    const top = document.querySelector('.browser-home-toolbar') as HTMLElement;
    expect(within(top).queryByRole('button', { name: '整理' })).toBeNull();
    const navigation = screen.getByRole('toolbar', { name: '收藏导航操作' });
    const button = (name: string) => within(navigation).getByRole('button', { name }) as HTMLButtonElement;
    expect(button('返回上一级').disabled).toBe(true);
    expect(button('上一项').disabled).toBe(true);
    expect(button('打开选中收藏').disabled).toBe(true);
    fireEvent.click(button('下一项'));
    expect(within(list).getByRole('button', { name: /文档/ }).getAttribute('aria-pressed')).toBe('true');
    expect(document.activeElement).toBe(list);
    expect(button('下一项').disabled).toBe(true);
    fireEvent.click(button('选择当前项'));
    expect(button('选择当前项').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(button('打开选中收藏'));
    await waitFor(() => expect(api.mockOf('browser.open')).toHaveBeenCalledWith({ url: 'https://example.test/docs', workspaceId: 'ws', sessionId: 's1', scope: 'session', openerId: 'home', background: false }));
    fireEvent.click(button('选择当前项'));
    fireEvent.click(button('上一项'));
    fireEvent.click(button('进入文件夹'));
    expect(within(document.querySelector('.browser-home-path') as HTMLElement).getByRole('button', { name: '资料' })).toBeTruthy();
    expect(button('返回上一级').disabled).toBe(false);
    fireEvent.click(button('返回上一级'));
    fireEvent.click(button('进入整理模式'));
    expect(screen.getByRole('toolbar', { name: '收藏整理操作' })).toBeTruthy();
    fireEvent.click(button('退出整理模式'));
    expect(button('进入整理模式').getAttribute('aria-pressed')).toBe('false');
  });
  it('keeps pointer-focused bookmark navigation from painting the whole region', () => {
    render(<Harness/>);
    const page = document.querySelector('.browser-home') as HTMLElement;
    const list = within(page).getByRole('region', { name: '收藏夹导航' });
    fireEvent.click(within(list).getByRole('button', { name: /文档/ }));
    expect(document.activeElement).toBe(list);
    const css = readFileSync(path.resolve(process.cwd(), 'src/renderer/src/styles/browser-home.css'), 'utf8');
    expect(css).toMatch(/\.browser-home \.browser-home-columns\[tabindex\].*box-shadow:\s*none\s*!important/);
  });
  it('keeps organize actions in the existing footer and supports their icon buttons', async () => {
    render(<Harness/>);
    const page = document.querySelector('.browser-home') as HTMLElement;
    const list = within(page).getByRole('region', { name: '收藏夹导航' });
    const footer = page.querySelector('.browser-home-footer') as HTMLElement;
    expect(list.nextElementSibling).toBe(footer);
    expect(within(footer).queryByRole('toolbar', { name: '收藏整理操作' })).toBeNull();
    fireEvent.click(within(list).getByRole('button', { name: /文档/ }));
    const organize = within(footer).getByRole('button', { name: '进入整理模式' });
    fireEvent.click(organize);
    const actions = within(footer).getByRole('toolbar', { name: '收藏整理操作' });
    expect(list.nextElementSibling).toBe(footer);
    expect(within(actions).getAllByRole('button')).toHaveLength(7);
    const paste = within(actions).getByRole('button', { name: '粘贴' }) as HTMLButtonElement;
    expect(paste.disabled).toBe(true);
    fireEvent.click(within(actions).getByRole('button', { name: '剪切' }));
    expect(paste.disabled).toBe(false);
    fireEvent.keyDown(list, { key: 'ArrowUp' });
    fireEvent.keyDown(list, { key: 'ArrowRight' });
    fireEvent.click(paste);
    await waitFor(() => expect(model.bookmarks.ws[0].children?.map(node => node.id)).toEqual(['site']));
    fireEvent.click(organize);
    expect(actions.getAttribute('aria-hidden')).toBe('true');
    expect(actions.hasAttribute('inert')).toBe(true);
    expect(list.nextElementSibling).toBe(footer);
  });
  it('moves a bookmark into a folder with keyboard commands and updates the sidebar', async () => {
    render(<Harness/>);
    const list = screen.getByRole('region', { name: '收藏夹导航' });
    expect(within(list).getByRole('button', { name: '资料' }).getAttribute('aria-description')).toBe('0 项');
    fireEvent.click(within(list).getByRole('button', { name: /文档/ }));
    fireEvent.keyDown(list, { key: 'e' });
    fireEvent.keyDown(list, { key: 'x' });
    fireEvent.keyDown(list, { key: 'ArrowUp' });
    fireEvent.keyDown(list, { key: 'ArrowRight' });
    fireEvent.keyDown(list, { key: 'p' });
    await waitFor(() => expect(model.bookmarks.ws[0].children?.map(node => node.id)).toEqual(['site']));
    const sidebar = document.querySelector('.right-bookmarks')!;
    fireEvent.click(within(sidebar as HTMLElement).getByRole('button', { name: '资料' }));
    expect(within(sidebar as HTMLElement).getByRole('button', { name: '文档' })).toBeTruthy();
  });
  it('toggles the current item with v while remaining in organize mode', () => {
    render(<Harness/>);
    const list = screen.getByRole('region', { name: '收藏夹导航' });
    fireEvent.keyDown(list, { key: 'e' });
    fireEvent.keyDown(list, { key: 'v' });
    expect(within(list).getByLabelText('已选中')).toBeTruthy();
    fireEvent.keyDown(list, { key: 'v' });
    expect(within(list).queryByLabelText('已选中')).toBeNull();
    expect(screen.getByRole('button', { name: '退出整理模式' }).getAttribute('aria-pressed')).toBe('true');
  });
  it('creates folders, searches bookmarks, and opens search results with the owning scope', async () => {
    const api = currentApiMock();
    render(<Harness/>);
    const page = document.querySelector('.browser-home') as HTMLElement;
    fireEvent.click(within(page).getByRole('button', { name: '新建文件夹' }));
    const dialog = await screen.findByRole('dialog', { name: '新建文件夹' });
    fireEvent.change(within(dialog).getByLabelText('名称'), { target: { value: '新资料' } });
    fireEvent.submit(dialog.querySelector('form') ?? dialog);
    await waitFor(() => expect(model.bookmarks.ws.some(node => node.label === '新资料')).toBe(true));
    const search = screen.getByRole('textbox', { name: '搜索收藏或网页' });
    fireEvent.change(search, { target: { value: '文档' } });
    expect(await screen.findByRole('button', { name: /文档.*收藏夹/ })).toBeTruthy();
    fireEvent.keyDown(search, { key: 'Enter' });
    await waitFor(() => expect(api.mockOf('browser.open')).toHaveBeenCalledWith({ url: `https://www.bing.com/search?q=${encodeURIComponent('文档')}`, workspaceId: 'ws', sessionId: 's1', scope: 'session', openerId: 'home', background: false }));
  });
  it('uses the shared input style for bookmark and search engine editors', async () => {
    render(<Harness/>);
    fireEvent.click(screen.getByRole('button', { name: '新建收藏' }));
    const bookmark = screen.getByRole('dialog', { name: '新建收藏' });
    expect(within(bookmark).getByLabelText('名称').classList.contains('ui-input')).toBe(true);
    expect(within(bookmark).getByLabelText('网址').classList.contains('ui-input')).toBe(true);
    fireEvent.click(within(bookmark).getByRole('button', { name: '取消' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '新建收藏' })).toBeNull());
    fireEvent.click(within(document.querySelector('.browser-home') as HTMLElement).getByRole('button', { name: '新建文件夹' }));
    const folder = screen.getByRole('dialog', { name: '新建文件夹' });
    expect(within(folder).getByLabelText('名称').classList.contains('ui-input')).toBe(true);
    fireEvent.click(within(folder).getByRole('button', { name: '取消' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '新建文件夹' })).toBeNull());
    const list = screen.getByRole('region', { name: '收藏夹导航' });
    fireEvent.click(within(list).getByRole('button', { name: /文档/ }));
    fireEvent.click(screen.getByRole('button', { name: '进入整理模式' }));
    fireEvent.click(screen.getByRole('button', { name: '编辑描述' }));
    const description = screen.getByRole('dialog', { name: '编辑描述' });
    expect(within(description).getByLabelText('描述').classList.contains('ui-input')).toBe(true);
    fireEvent.click(within(description).getByRole('button', { name: '取消' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '编辑描述' })).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: '管理搜索引擎' }));
    const engines = screen.getByRole('dialog', { name: '管理搜索引擎' });
    expect(within(engines).getByLabelText('名称').classList.contains('ui-input')).toBe(true);
    expect(within(engines).getByLabelText('搜索网址').classList.contains('ui-input')).toBe(true);
  });
  it('keeps sidebar folder creation in a dialog without inserting an inline form', async () => {
    render(<Harness/>);
    const sidebar = document.querySelector('.right-bookmarks') as HTMLElement;
    expect(within(sidebar).queryByRole('button', { name: '新建文件夹' })).toBeNull();
    expect(within(sidebar).getByRole('button', { name: '打开主页' })).toBeTruthy();
    fireEvent.contextMenu(sidebar.querySelector('.right-bookmark-tree')!);
    fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: '新建文件夹' }));
    const dialog = await screen.findByRole('dialog', { name: '新建文件夹' });
    expect(within(sidebar).queryByRole('textbox', { name: '名称' })).toBeNull();
    const input = within(dialog).getByRole('textbox', { name: '名称' });
    expect(input.classList.contains('ui-input')).toBe(true);
    expect(within(dialog).getByRole('button', { name: '保存' }).classList.contains('btn')).toBe(true);
    fireEvent.change(input, { target: { value: '侧栏文件夹' } });
    fireEvent.submit(input.closest('form')!);
    await waitFor(() => expect(model.bookmarks.ws.some(node => node.label === '侧栏文件夹')).toBe(true));
  });
  it('returns to the most recently used home and does not duplicate it', () => {
    render(<Harness/>);
    act(() => {
      dispatch({ type: 'open', scope: 'workspace', content: { kind: 'web', browserId: 'home-1', url: 'muster-home://new/one', title: '新建标签页' } });
      dispatch({ type: 'open', scope: 'workspace', content: { kind: 'web', browserId: 'home-2', url: 'muster-home://new/two', title: '新建标签页' } });
      dispatch({ type: 'open', content: { kind: 'web', browserId: 'site', url: 'https://example.test/', title: '网站' } });
    });
    const sidebar = document.querySelector('.right-bookmarks') as HTMLElement;
    fireEvent.click(within(sidebar).getByRole('button', { name: '打开主页' }));
    expect(activeRightTab(model)?.content).toMatchObject({ browserId: 'home-2' });
    fireEvent.click(within(sidebar).getByRole('button', { name: '打开主页' }));
    expect(model.tabs).toHaveLength(3);
  });
  it('creates one workspace home when only another session has a session-scoped home', () => {
    render(<Harness/>);
    act(() => {
      dispatch({ type: 'scope', workspaceId: 'ws', sessionId: 's2' });
      dispatch({ type: 'open', content: { kind: 'web', browserId: 'other', url: 'muster-home://new/other', title: '新建标签页' } });
      dispatch({ type: 'scope', workspaceId: 'ws', sessionId: 's1' });
      dispatch({ type: 'open', content: { kind: 'web', browserId: 'site', url: 'https://example.test/', title: '网站' } });
    });
    const button = within(document.querySelector('.right-bookmarks') as HTMLElement).getByRole('button', { name: '打开主页' });
    act(() => { fireEvent.click(button); fireEvent.click(button); });
    expect(model.tabs).toHaveLength(3);
    expect(activeRightTab(model)).toMatchObject({ sessionId: 's1', scope: 'workspace', pinned: false, content: { kind: 'web', browserId: '', url: expect.stringMatching(/^muster-home:\/\/new\//) } });
    expect(model.tabs.find(tab => tab.content.kind === 'web' && tab.content.browserId === 'other')?.sessionId).toBe('s2');
  });
  it('reuses a workspace home opened from another session without pinning it', () => {
    render(<Harness/>);
    act(() => {
      dispatch({ type: 'scope', workspaceId: 'ws', sessionId: 's2' });
      dispatch({ type: 'open', scope: 'workspace', content: { kind: 'web', browserId: 'shared', url: 'muster-home://new/shared', title: '新建标签页' } });
    });
    const home = activeRightTab(model)!;
    act(() => {
      dispatch({ type: 'scope', workspaceId: 'ws', sessionId: 's1' });
      dispatch({ type: 'open', content: { kind: 'web', browserId: 'site', url: 'https://example.test/', title: '网站' } });
    });
    fireEvent.click(within(document.querySelector('.right-bookmarks') as HTMLElement).getByRole('button', { name: '打开主页' }));
    expect(activeRightTab(model)).toMatchObject({ id: home.id, scope: 'workspace', pinned: false });
    expect(model.tabs).toHaveLength(2);
  });
  it('shows the default engine as text and follows changes made in the manager', async () => {
    const api = currentApiMock();
    render(<Harness secondHome/>);
    const homes = [...document.querySelectorAll<HTMLElement>('.browser-home')];
    for (const home of homes) {
      const indicator = within(home).getByRole('status', { name: '默认搜索引擎：Bing' });
      expect(indicator.tagName).toBe('SPAN');
      expect(indicator.textContent).toBe('Bing');
      expect(within(home).queryByRole('button', { name: '搜索引擎' })).toBeNull();
    }
    fireEvent.click(within(homes[0]).getByRole('button', { name: '管理搜索引擎' }));
    const dialog = screen.getByRole('dialog', { name: '管理搜索引擎' });
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Google' }));
    for (const home of homes) expect(within(home).getByRole('status', { name: '默认搜索引擎：Google' }).textContent).toBe('Google');
    fireEvent.click(within(dialog).getByRole('button', { name: '关闭' }));
    const search = within(homes[0]).getByRole('textbox', { name: '搜索收藏或网页' });
    fireEvent.change(search, { target: { value: 'hello world' } });
    fireEvent.keyDown(search, { key: 'Enter' });
    await waitFor(() => expect(api.mockOf('browser.open')).toHaveBeenCalledWith({ url: 'https://www.google.com/search?q=hello%20world', workspaceId: 'ws', sessionId: 's1', scope: 'session', openerId: 'home', background: false }));
  });
  it('removes the old built-in Baidu preset from saved preferences and falls back to an available engine', async () => {
    const api = currentApiMock();
    const legacy = { id: 'baidu', name: 'Baidu', url: 'https://www.baidu.com/s?wd=%s' };
    const custom = { id: 'custom-baidu', name: '百度自定义', url: 'https://www.baidu.com/s?wd=%s' };
    expect(HOME_SEARCH_PRESETS.some(engine => engine.id === 'baidu')).toBe(false);
    localStorage.setItem('muster.browser.home.search.v1', JSON.stringify({ engines: [HOME_SEARCH_PRESETS[0], legacy, custom], defaultId: 'baidu' }));
    expect(readHomeSearchPreferences()).toEqual({ engines: [HOME_SEARCH_PRESETS[0], custom], defaultId: 'bing' });
    render(<Harness/>);
    expect(screen.getByRole('status', { name: '默认搜索引擎：Bing' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '管理搜索引擎' }));
    const dialog = screen.getByRole('dialog', { name: '管理搜索引擎' });
    expect(within(dialog).queryByRole('radio', { name: 'Baidu' })).toBeNull();
    expect(within(dialog).getByRole('radio', { name: '百度自定义' })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: '关闭' }));
    const search = screen.getByRole('textbox', { name: '搜索收藏或网页' });
    fireEvent.change(search, { target: { value: 'hello' } });
    expect(document.querySelector('.browser-home-search-engines')?.textContent).not.toContain('Baidu');
    fireEvent.keyDown(search, { key: 'Enter' });
    await waitFor(() => expect(api.mockOf('browser.open')).toHaveBeenCalledWith({ url: 'https://www.bing.com/search?q=hello', workspaceId: 'ws', sessionId: 's1', scope: 'session', openerId: 'home', background: false }));
  });
  it('keeps an edited legacy engine while removing an untouched preset', () => {
    const edited = { id: 'baidu', name: '百度工作版', url: 'https://www.baidu.com/s?wd=%s' };
    localStorage.setItem('muster.browser.home.search.v1', JSON.stringify({ engines: [edited], defaultId: edited.id }));
    expect(readHomeSearchPreferences()).toEqual({ engines: [edited], defaultId: edited.id });
  });
  it('dismisses and reopens the search popup without replacing the bookmark panel', () => {
    render(<Harness/>);
    const search = screen.getByRole('textbox', { name: '搜索收藏或网页' });
    const panel = document.querySelector('.browser-home-panel');
    const list = screen.getByRole('region', { name: '收藏夹导航' });
    fireEvent.change(search, { target: { value: '文档' } });
    const popup = document.querySelector('.browser-home-search-results') as HTMLElement;
    expect(within(popup).getByRole('button', { name: /文档.*收藏夹/ })).toBeTruthy();
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(popup.getAttribute('aria-hidden')).toBe('true');
    expect(popup.hasAttribute('inert')).toBe(true);
    fireEvent.change(search, { target: { value: '文档' } });
    expect(popup.getAttribute('aria-hidden')).toBe('false');
    expect(popup.hasAttribute('inert')).toBe(false);
    expect(document.querySelector('.browser-home-panel')).toBe(panel);
    expect(screen.getByRole('region', { name: '收藏夹导航' })).toBe(list);
  });
  it('keeps separate workspace trees and does not let hidden home pages edit another workspace', async () => {
    const view = render(<Harness/>);
    act(() => dispatch({ type: 'scope', workspaceId: 'other', sessionId: 's2' }));
    expect((screen.getByRole('button', { name: '新建收藏' }) as HTMLButtonElement).disabled).toBe(true);
    view.rerender(<Harness visible={false}/>);
    expect(document.querySelector('.browser-home')?.getAttribute('aria-hidden')).toBe('true');
  });
  it('opens only the first selected bookmark in the foreground', async () => {
    const api = currentApiMock();
    render(<Harness/>);
    act(() => dispatch({ type: 'bookmarkChange', workspaceId: 'ws', change: { kind: 'add', parentId: null, node: { id: 'second', label: '第二项', url: 'https://second.test/' } } }));
    const list = screen.getByRole('region', { name: '收藏夹导航' });
    fireEvent.click(within(list).getByRole('button', { name: /文档/ }));
    fireEvent.keyDown(list, { key: ' ' });
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    fireEvent.keyDown(list, { key: ' ' });
    fireEvent.keyDown(list, { key: 'Enter' });
    await waitFor(() => expect(api.mockOf('browser.open')).toHaveBeenCalledTimes(2));
    expect(api.mockOf('browser.open')).toHaveBeenNthCalledWith(1, { url: 'https://example.test/docs', workspaceId: 'ws', sessionId: 's1', scope: 'session', openerId: 'home', background: false });
    expect(api.mockOf('browser.open')).toHaveBeenNthCalledWith(2, { url: 'https://second.test/', workspaceId: 'ws', sessionId: 's1', scope: 'session', openerId: 'home', background: true });
  });
  it('supports keyboard selection of multiple search engines', async () => {
    const api = currentApiMock();
    render(<Harness/>);
    const search = screen.getByRole('textbox', { name: '搜索收藏或网页' });
    fireEvent.change(search, { target: { value: 'query' } });
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'ArrowRight' });
    fireEvent.keyDown(search, { key: ' ' });
    fireEvent.keyDown(search, { key: 'ArrowRight' });
    fireEvent.keyDown(search, { key: 'Enter' });
    await waitFor(() => expect(api.mockOf('browser.open')).toHaveBeenCalledTimes(2));
    expect(api.mockOf('browser.open')).toHaveBeenNthCalledWith(1, { url: 'https://www.google.com/search?q=query', workspaceId: 'ws', sessionId: 's1', scope: 'session', openerId: 'home', background: false });
    expect(api.mockOf('browser.open')).toHaveBeenNthCalledWith(2, { url: 'https://duckduckgo.com/?q=query', workspaceId: 'ws', sessionId: 's1', scope: 'session', openerId: 'home', background: true });
  });
  it('gives a space-selected search engine a distinct selected surface', () => {
    render(<Harness/>);
    const search = screen.getByRole('textbox', { name: '搜索收藏或网页' });
    fireEvent.change(search, { target: { value: 'query' } });
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: ' ' });
    const selected = screen.getByRole('button', { name: 'Bing' });
    const unselected = screen.getByRole('button', { name: 'Google' });
    expect(selected.getAttribute('aria-pressed')).toBe('true');
    expect(selected.classList.contains('is-selected')).toBe(true);
    expect(unselected.classList.contains('is-selected')).toBe(false);
    const css = readFileSync(path.resolve(process.cwd(), 'src/renderer/src/styles/browser-home.css'), 'utf8');
    expect(css).toMatch(/\.browser-home \.browser-home-search-engines \.btn\.is-selected\s*\{[^}]*background:[^}]*var\(--interaction-selected\)/s);
    expect(css).toMatch(/\.browser-home \.browser-home-search-engines \.btn\.is-selected\s*\{[^}]*border-color:\s*var\(--overlay-border-focus\)/s);
  });
  it('cycles and selects all search engines with Tab and Shift+Space', () => {
    render(<Harness/>);
    const search = screen.getByRole('textbox', { name: '搜索收藏或网页' });
    fireEvent.change(search, { target: { value: 'query' } });
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'Tab' });
    fireEvent.keyDown(search, { key: ' ' });
    expect(screen.getByRole('button', { name: 'Google' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.keyDown(search, { key: ' ', shiftKey: true });
    expect(document.querySelectorAll('.browser-home-search-engines button[aria-pressed="true"]')).toHaveLength(6);
    fireEvent.keyDown(search, { key: ' ', shiftKey: true });
    expect(document.querySelectorAll('.browser-home-search-engines button[aria-pressed="true"]')).toHaveLength(0);
  });
  it('saves a custom search engine and makes it the default', async () => {
    render(<Harness/>);
    fireEvent.click(screen.getByRole('button', { name: '管理搜索引擎' }));
    const dialog = await screen.findByRole('dialog', { name: '管理搜索引擎' });
    fireEvent.change(within(dialog).getByLabelText('名称'), { target: { value: 'Custom' } });
    fireEvent.change(within(dialog).getByLabelText('搜索网址'), { target: { value: 'https://search.test/?q=%s' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '添加' }));
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Custom' }));
    const saved = JSON.parse(localStorage.getItem('muster.browser.home.search.v1')!);
    expect(saved.engines.find((engine: { name: string }) => engine.name === 'Custom').url).toBe('https://search.test/?q=%s');
    expect(saved.defaultId).toBe(saved.engines.find((engine: { name: string }) => engine.name === 'Custom').id);
  });
});
