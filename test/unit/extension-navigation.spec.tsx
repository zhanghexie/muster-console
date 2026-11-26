import React, { useState } from 'react';
import { act, createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ExtensionNavigationTree } from '../../src/renderer/src/components/ExtensionNavigationTree';
import { INITIAL_NAVIGATION, ExtensionSidebarStudy } from '../../docs/prototypes/extension-sidebar-study/extension-sidebar-study';
import { applyLocaleSetting } from '../../src/shared/i18n';
import { getTipSnapshot } from '../../src/renderer/src/tips';

function Harness(): React.JSX.Element {
  const [nodes, setNodes] = useState(INITIAL_NAVIGATION.map(node => ({ ...node })));
  const [selected, setSelected] = useState<string | null>('studio');
  return <ExtensionNavigationTree nodes={nodes} selectedId={selected} onChange={setNodes} onSelect={setSelected} />;
}
const row = (name: string): HTMLElement => screen.getByRole('treeitem', { name });
const transfer = (): DataTransfer => ({ setData: vi.fn(), getData: vi.fn(), effectAllowed: 'all', dropEffect: 'none' }) as unknown as DataTransfer;
function menu(name: string): void { fireEvent.click(screen.getByRole('button', { name: `${name}的更多操作` })); }
async function closeRetiringDialog(): Promise<void> { await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull()); }
function renderExpandedStudy(): ReturnType<typeof render> {
  const view = render(<ExtensionSidebarStudy />);
  const expand = screen.queryByRole('button', { name: '展开更多工具' });
  if (expand) fireEvent.click(expand);
  return view;
}

it('renders the extension manifest icon in the navigation tree', () => {
  const nodes = [{ id: 'bookshelf', kind: 'extension' as const, parentId: null, title: '书架', extensionId: 'bookshelf', viewId: 'main', icon: 'builtin-extension:book' }];
  const { container } = render(<ExtensionNavigationTree nodes={nodes} selectedId={null} onChange={() => {}} onSelect={() => {}} />);
  // 图标经 CSS mask 渲染：span 的 mask 引用内置 book.svg，颜色随容器前景色。
  const icon = container.querySelector('.ext-nav-node-icon .extension-nav-icon-image') as HTMLElement | null;
  expect(icon).toBeTruthy();
  const style = icon?.getAttribute('style') ?? '';
  expect(style).toContain('mask');
  expect(style).toContain('book.svg');
});

beforeEach(() => { localStorage.clear(); });
describe('tool / webpage navigation prototype', () => {
  it('扩展入口子菜单在来源虚拟屏滑走时退场', async () => {
    const layout = (peek: boolean) => <div className="h-strip" data-testid="navigation-strip">
      <div data-h-page="terminal" data-h-peek={peek ? '' : undefined}><Harness /></div>
    </div>;
    const view = render(layout(false));
    menu('参考图库');
    fireEvent.click(screen.getByRole('menuitem', { name: '移动到…' }));
    const popup = screen.getByRole('menu', { name: '移动到文件夹' });
    expect(popup.parentElement).toBe(screen.getByTestId('navigation-strip'));
    view.rerender(layout(true));
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(popup.getAttribute('data-mp-stage')).toBe('out');
    view.rerender(layout(false));
    menu('参考图库');
    expect(screen.getByRole('menu', { name: '入口操作' })).toBeTruthy();
  });
  it('常用扩展入口的操作菜单切屏时关闭', async () => {
    const layout = (peek: boolean) => <div data-h-page="terminal" data-h-peek={peek ? '' : undefined}>
      <ExtensionSidebarStudy />
    </div>;
    const view = render(layout(false));
    const trigger = screen.getByRole('button', { name: '素材库的常用操作' });
    fireEvent.click(trigger);
    expect(screen.getByRole('menu', { name: '常用入口操作' })).toBeTruthy();
    view.rerender(layout(true));
    await waitFor(() => expect(trigger.getAttribute('aria-expanded')).toBe('false'));
    expect(screen.queryByRole('menu', { name: '常用入口操作' })).toBeNull();
  });
  it('子菜单返回项随语言切换并返回上一级', () => {
    render(<Harness />); menu('参考图库');
    fireEvent.click(screen.getByRole('menuitem', { name: '移动到…' }));
    try {
      act(() => { applyLocaleSetting('en'); });
      fireEvent.click(screen.getByRole('menuitem', { name: '‹ Back' }));
      expect(screen.queryByRole('menuitem', { name: '‹ Back' })).toBeNull();
      expect(screen.getByRole('menu')).toBeTruthy();
    } finally { act(() => { applyLocaleSetting('zh-CN'); }); }
  });
  it('keeps folder destination selection without offering obsolete global visibility', () => {
    const onChange = vi.fn();
    const nodes = [{ id: 'parent', kind: 'folder' as const, parentId: null, title: '现有文件夹', expanded: true }];
    render(<ExtensionNavigationTree nodes={nodes} selectedId={null} onChange={onChange} onSelect={vi.fn()} advanced allowScope={false} />);
    fireEvent.click(screen.getByRole('button', { name: '新建文件夹' }));
    expect(screen.queryByRole('button', { name: '高级选项' })).toBeNull();
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '子文件夹' } });
    fireEvent.click(screen.getByRole('button', { name: '文件夹' }));
    fireEvent.click(screen.getByRole('option', { name: '现有文件夹' }));
    fireEvent.click(screen.getByRole('button', { name: '添加' }));
    expect(onChange.mock.calls.at(-1)?.[0]).toEqual(expect.arrayContaining([expect.objectContaining({ title: '子文件夹', parentId: 'parent' })]));
    expect(onChange.mock.calls.at(-1)?.[0].find((node: any) => node.title === '子文件夹').scope).toBeUndefined();
  });
  it('collapses folders without losing entries, and expands via keyboard', () => {
    render(<Harness />);
    fireEvent.click(row('创作工具'));
    expect(screen.queryByRole('treeitem', { name: '素材库' })).toBeNull();
    fireEvent.keyDown(row('创作工具'), { key: 'ArrowRight' });
    expect(row('素材库').getAttribute('data-parent-id')).toBe('studio');
  });

  it('creates a folder, trims the name and selects the created node', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: '新建文件夹' }));
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '  新项目  ' } });
    fireEvent.click(screen.getByRole('button', { name: '添加' }));
    await closeRetiringDialog();
    expect(row('新项目').getAttribute('aria-selected')).toBe('true');
    expect(row('新项目').getAttribute('data-parent-id')).toBe('');
  });

  it('creates a child folder and rejects blank names', async () => {
    render(<Harness />); menu('创作工具');
    fireEvent.click(screen.getByRole('menuitem', { name: '新建子文件夹' }));
    fireEvent.click(screen.getByRole('button', { name: '添加' }));
    expect(getTipSnapshot()).toMatchObject({ tone: 'error', text: '请输入名称' });
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '交付' } });
    fireEvent.click(screen.getByRole('button', { name: '添加' }));
    await closeRetiringDialog();
    expect(row('交付').getAttribute('data-parent-id')).toBe('studio');
  });

  it('renames using F2 and cancels edits with Escape', async () => {
    render(<Harness />);
    fireEvent.keyDown(row('日常工具'), { key: 'F2' });
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '常用' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await closeRetiringDialog();
    expect(row('常用')).toBeTruthy();
    fireEvent.keyDown(row('常用'), { key: 'F2' });
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '放弃的改名' } });
    fireEvent.keyDown(screen.getByLabelText('名称'), { key: 'Escape' });
    await closeRetiringDialog();
    expect(screen.queryByRole('treeitem', { name: '放弃的改名' })).toBeNull();
  });

  it('has no URL creation entry', () => {
    render(<Harness />);
    expect(screen.queryByRole('button', { name: '固定网页' })).toBeNull();
    expect(screen.getByRole('button', { name: '新建文件夹' })).toBeTruthy();
  });

  it('moves through the menu and excludes descendant folders as targets', async () => {
    render(<Harness />); menu('参考图库');
    fireEvent.click(screen.getByRole('menuitem', { name: '移动到…' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '创作工具 / 灵感参考' }));
    expect(row('参考图库').getAttribute('data-parent-id')).toBe('research');
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    menu('创作工具'); fireEvent.click(screen.getByRole('menuitem', { name: '移动到…' }));
    expect(screen.queryByRole('menuitem', { name: '创作工具 / 灵感参考' })).toBeNull();
  });

  it('reorders siblings with Alt + Arrow and preserves nested children', () => {
    render(<Harness />);
    fireEvent.keyDown(row('日常工具'), { key: 'ArrowUp', altKey: true });
    const roots = screen.getAllByRole('treeitem').filter(item => item.getAttribute('data-parent-id') === '');
    expect(roots.map(item => item.getAttribute('aria-label'))).toEqual(['日常工具', '创作工具', '参考图库']);
    expect(row('项目文档').getAttribute('data-parent-id')).toBe('research');
  });

  it('drags into folders and back to the root with actual component events', () => {
    render(<Harness />);
    const dt = transfer();
    vi.spyOn(row('日常工具'), 'getBoundingClientRect').mockReturnValue({ top: 100, height: 40 } as DOMRect);
    fireEvent.dragStart(row('参考图库'), { dataTransfer: dt });
    // JSDOM has no DragEvent constructor, so MouseEvent coordinates must be supplied explicitly.
    const over = createEvent.dragOver(row('日常工具'), { dataTransfer: dt });
    Object.defineProperty(over, 'clientY', { value: 120 });
    fireEvent(row('日常工具'), over);
    expect(row('日常工具').getAttribute('data-drop')).toBe('inside');
    fireEvent.drop(row('日常工具'), { dataTransfer: dt });
    expect(row('参考图库').getAttribute('data-parent-id')).toBe('daily');
    fireEvent.dragStart(row('参考图库'), { dataTransfer: dt });
    fireEvent.dragOver(screen.getByText('移到最外层'), { dataTransfer: dt });
    fireEvent.drop(screen.getByText('移到最外层'), { dataTransfer: dt });
    expect(row('参考图库').getAttribute('data-parent-id')).toBe('');
  });

  it('dissolves a folder while retaining children and supports undo in the preview', async () => {
    renderExpandedStudy(); menu('创作工具');
    fireEvent.click(screen.getByRole('menuitem', { name: '解散文件夹，保留内容' }));
    expect(screen.queryByRole('treeitem', { name: '创作工具' })).toBeNull();
    expect(row('素材库').getAttribute('data-parent-id')).toBe('');
    expect(row('项目文档').getAttribute('data-parent-id')).toBe('research');
    fireEvent.click(screen.getByRole('button', { name: '撤销' }));
    expect(row('创作工具')).toBeTruthy();
    expect(row('素材库').getAttribute('data-parent-id')).toBe('studio');
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  });

  it('keeps the note draft when changing views and restores saved navigation on remount', async () => {
    const view = renderExpandedStudy();
    fireEvent.click(row('工作笔记'));
    fireEvent.change(screen.getByRole('textbox', { name: '工作笔记' }), { target: { value: '保留我的草稿' } });
    fireEvent.click(row('任务队列'));
    fireEvent.click(row('工作笔记'));
    expect((screen.getByRole('textbox', { name: '工作笔记' }) as HTMLTextAreaElement).value).toBe('保留我的草稿');
    fireEvent.keyDown(row('日常工具'), { key: 'F2' });
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '长期工具' } });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '保存' }));
    await closeRetiringDialog();
    view.unmount(); render(<ExtensionSidebarStudy />);
    expect(row('长期工具')).toBeTruthy();
  });

  it('adds a list entry to the utility grid without moving or duplicating it', async () => {
    renderExpandedStudy();
    const common = within(screen.getByRole('group', { name: '常用工具' }));
    expect(common.getByRole('button', { name: '定时任务' })).toBeTruthy();
    expect(common.queryByRole('button', { name: '工作笔记' })).toBeNull();
    menu('工作笔记');
    fireEvent.click(screen.getByRole('menuitem', { name: '添加到常用' }));
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(row('工作笔记').getAttribute('data-parent-id')).toBe('daily');
    expect(common.getAllByRole('button', { name: '工作笔记' })).toHaveLength(1);
    fireEvent.click(common.getByRole('button', { name: '工作笔记' }));
    expect(row('工作笔记').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('textbox', { name: '工作笔记' })).toBeTruthy();
    menu('工作笔记');
    expect(screen.queryByRole('menuitem', { name: '添加到常用' })).toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: '从常用移除' }));
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(common.queryByRole('button', { name: '工作笔记' })).toBeNull();
    expect(row('工作笔记')).toBeTruthy();
  });

  it('renames the shared entry in both the list and favorites', async () => {
    renderExpandedStudy();
    fireEvent.keyDown(row('素材库'), { key: 'F2' });
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '项目素材' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await closeRetiringDialog();
    expect(row('项目素材').getAttribute('data-parent-id')).toBe('studio');
    const common = within(screen.getByRole('group', { name: '常用工具' }));
    expect(common.getByRole('button', { name: '项目素材' })).toBeTruthy();
    expect(common.queryByRole('button', { name: '素材库' })).toBeNull();
  });

  it('removes a shortcut from the upper menu, retains the list node, and undoes it', async () => {
    renderExpandedStudy();
    const common = within(screen.getByRole('group', { name: '常用工具' }));
    fireEvent.click(common.getByRole('button', { name: '素材库的常用操作' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '从常用移除' }));
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(common.queryByRole('button', { name: '素材库' })).toBeNull();
    expect(row('素材库').getAttribute('data-parent-id')).toBe('studio');
    fireEvent.click(screen.getByRole('button', { name: '撤销' }));
    expect(common.getByRole('button', { name: '素材库' })).toBeTruthy();
  });

  it('cleans up favorites when an entry is unpinned and restores both with undo', async () => {
    renderExpandedStudy();
    const common = within(screen.getByRole('group', { name: '常用工具' }));
    menu('项目文档'); fireEvent.click(screen.getByRole('menuitem', { name: '取消固定' }));
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(screen.queryByRole('treeitem', { name: '项目文档' })).toBeNull();
    expect(common.queryByRole('button', { name: '项目文档' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '撤销' }));
    expect(row('项目文档').getAttribute('data-parent-id')).toBe('research');
    expect(common.getByRole('button', { name: '项目文档' })).toBeTruthy();
  });

  it('persists favorite changes, and explicit reveal opens the same nested group', async () => {
    const view = renderExpandedStudy();
    menu('灵感参考'); fireEvent.click(screen.getByRole('menuitem', { name: '添加到常用' }));
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    fireEvent.click(row('创作工具'));
    const common = within(screen.getByRole('group', { name: '常用工具' }));
    fireEvent.click(common.getByRole('button', { name: '灵感参考' }));
    expect(screen.queryByRole('treeitem', { name: '项目文档' })).toBeNull();
    fireEvent.click(common.getByRole('button', { name: '灵感参考的常用操作' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '在列表中显示' }));
    expect(row('项目文档')).toBeTruthy();
    expect(row('灵感参考').getAttribute('aria-selected')).toBe('true');
    view.unmount(); render(<ExtensionSidebarStudy />);
    expect(within(screen.getByRole('group', { name: '常用工具' })).getByRole('button', { name: '灵感参考' })).toBeTruthy();
  });

  it('defaults to a compact grid with the disclosure tile last and no redundant headings', () => {
    render(<ExtensionSidebarStudy />);
    const toggle = screen.getByRole('button', { name: '展开更多工具' });
    expect(toggle).toBe(toggle.parentElement?.lastElementChild);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('tree')).toBeNull();
    expect(screen.queryByText('常用', { exact: true })).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByRole('tree', { name: '扩展' })).toBeTruthy();
    expect(toggle.closest('.utility-navigation-section')?.querySelector('.ext-nav-heading')).toBeFalsy();
    expect(screen.queryByRole('button', { name: '固定网页' })).toBeNull();
    expect(screen.getByRole('button', { name: '新建文件夹' })).toBeTruthy();
  });

  it('fully folds the library with presence, preserves content, and remembers the choice', async () => {
    const view = renderExpandedStudy();
    fireEvent.click(row('工作笔记'));
    fireEvent.change(screen.getByRole('textbox', { name: '工作笔记' }), { target: { value: '不随折叠丢失' } });
    fireEvent.click(row('创作工具'));
    fireEvent.click(row('工作笔记'));
    const savedNodes = localStorage.getItem('muster.extension-sidebar-prototype.v1');
    const toggle = screen.getByRole('button', { name: '收起更多工具' });
    const library = document.getElementById(toggle.getAttribute('aria-controls')!)!;
    fireEvent.click(toggle);
    expect(library.getAttribute('data-mp-stage')).toBe('out');
    expect(library.getAttribute('aria-hidden')).toBe('true');
    expect(library.hasAttribute('inert')).toBe(true);
    await waitFor(() => expect(library.querySelector('[role="tree"]')).toBeNull());
    expect(localStorage.getItem('muster.extension-sidebar-prototype.v1')).toBe(savedNodes);
    expect((screen.getByRole('textbox', { name: '工作笔记' }) as HTMLTextAreaElement).value).toBe('不随折叠丢失');
    fireEvent.click(screen.getByRole('button', { name: '展开更多工具' }));
    expect(row('创作工具').getAttribute('aria-expanded')).toBe('false');
    expect(row('工作笔记').getAttribute('aria-selected')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: '收起更多工具' }));
    view.unmount(); render(<ExtensionSidebarStudy />);
    expect(screen.getByRole('button', { name: '展开更多工具' }).getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('tree')).toBeNull();
  });

  it('opens favorites without expanding the library and reveals a requested entry with focus', async () => {
    render(<ExtensionSidebarStudy />);
    const common = within(screen.getByRole('group', { name: '常用工具' }));
    fireEvent.click(common.getByRole('button', { name: '素材库' }));
    expect(screen.getByRole('heading', { name: '素材库' })).toBeTruthy();
    expect(screen.queryByRole('tree')).toBeNull();
    fireEvent.click(common.getByRole('button', { name: '项目文档的常用操作' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '在列表中显示' }));
    expect(screen.getByRole('button', { name: '收起更多工具' })).toBeTruthy();
    expect(row('项目文档').getAttribute('aria-selected')).toBe('true');
    await waitFor(() => expect(document.activeElement).toBe(row('项目文档')));
  });

  it('keeps keyboard focus usable when removing a favorite while the library is hidden', async () => {
    render(<ExtensionSidebarStudy />);
    fireEvent.click(screen.getByRole('button', { name: '素材库的常用操作' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '从常用移除' }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: '展开更多工具' })));
    expect(screen.queryByRole('tree')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '展开更多工具' }));
    expect(row('素材库').getAttribute('data-parent-id')).toBe('studio');
  });

  it('reverses a fold in progress without remounting the tree or losing folder state', () => {
    renderExpandedStudy();
    fireEvent.click(row('创作工具'));
    const tree = screen.getByRole('tree');
    fireEvent.click(screen.getByRole('button', { name: '收起更多工具' }));
    fireEvent.click(screen.getByRole('button', { name: '展开更多工具' }));
    expect(screen.getByRole('tree')).toBe(tree);
    expect(row('创作工具').getAttribute('aria-expanded')).toBe('false');
    expect(tree.closest('[data-mp-stage]')?.getAttribute('data-mp-stage')).toBe('in');
  });
});
