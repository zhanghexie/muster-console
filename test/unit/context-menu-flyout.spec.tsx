/**
 * ContextMenu 二级子菜单（分屏显示 ▸ 左/右/上/下 的承载）：
 * 悬停展开、子项 id 直报（split-left 等）、点外/子项选择后关闭、
 * flyout 使用独立 portal 但不算「点外」。
 */
import React from 'react';
import { createPortal } from 'react-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import { ContextMenu } from '../../src/renderer/src/components/ContextMenu';
import { KeybindingProvider } from '../../src/renderer/src/keybindings/KeybindingHost';
import { splitMenuItems } from '../../src/renderer/src/panels/LeftPanel';

function Harness({ onSelect }: { onSelect: (id: string) => void }): React.JSX.Element {
  const [open, setOpen] = React.useState(true);
  return (
    <div>
      <button onClick={() => setOpen(v => !v)}>toggle</button>
      {open && (
        <ContextMenu
          x={40}
          y={40}
          items={[
            { id: 'rename', label: '重命名' },
            splitMenuItems((key) => key)
          ]}
          onSelect={id => { onSelect(id); setOpen(false); }}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

describe('ContextMenu 子菜单', () => {
  it('主菜单和子菜单随实际来源页滑走，并释放键盘焦点', async () => {
    function DockedMenu({ peek }: { peek: 'terminal' | 'git' }) {
      const [right, setRight] = React.useState<HTMLDivElement | null>(null);
      const [anchor, setAnchor] = React.useState<HTMLElement | null>(null);
      return <div className="h-strip" data-testid="menu-strip">
        <div data-h-page="terminal" data-h-peek={peek === 'terminal' ? '' : undefined}>
          {right && createPortal(<button onContextMenu={event => setAnchor(event.currentTarget)}>右栏来源</button>, right)}
          {anchor && <ContextMenu x={40} y={40} anchor={anchor} onClose={() => setAnchor(null)} onSelect={() => {}}
            items={[splitMenuItems(key => key)]} />}
        </div>
        <div ref={setRight} data-h-page="git" data-h-peek={peek === 'git' ? '' : undefined} />
      </div>;
    }
    const view = render(<DockedMenu peek="terminal" />);
    fireEvent.contextMenu(screen.getByRole('button', { name: '右栏来源' }));
    fireEvent.mouseEnter(screen.getByRole('menuitemcheckbox', { name: '分屏显示' }));
    expect(screen.getAllByRole('menu')).toHaveLength(2);
    const overlays = screen.getAllByRole('menu');
    expect(overlays.every(overlay => overlay.parentElement === screen.getByTestId('menu-strip'))).toBe(true);
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: '左侧' }));
    view.rerender(<DockedMenu peek="git" />);
    await waitFor(() => expect(screen.queryAllByRole('menu')).toHaveLength(0));
    expect(overlays.every(overlay => overlay.isConnected && overlay.getAttribute('data-mp-stage') === 'out')).toBe(true);
    await waitFor(() => expect(overlays.every(overlay => !overlay.isConnected)).toBe(true));
    expect(document.activeElement).toBe(document.body);
  });

  it('悬停父项展开 flyout，点子项直接上报 split-left 并整体关闭', async () => {
    const user = userEvent.setup();
    const selected: string[] = [];
    render(<Harness onSelect={id => selected.push(id)} />);
    fireEvent.mouseEnter(screen.getByRole('menuitemcheckbox', { name: '分屏显示' }));
    const flyout = await screen.findByRole('menu', { name: '分屏显示' });
    expect(flyout.querySelectorAll('button').length).toBe(4);
    expect(screen.getByRole('menuitem', { name: '左侧' })).toBeTruthy();
    await user.click(screen.getByRole('menuitem', { name: '左侧' }));
    expect(selected).toEqual(['split-left']);
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  });

  it('子菜单构建器四向齐全、id 稳定', () => {
    const items = splitMenuItems((key) => key);
    expect(items.id).toBe('split');
    expect(items.children.map(c => c.id)).toEqual(['split-left', 'split-right', 'split-top', 'split-bottom']);
    expect(items.children.map(c => c.label)).toEqual(['左侧', '右侧', '上方', '下方']);
  });

  it('flyout 内点击不算「点外」：悬停其它父项收起旧 flyout', async () => {
    const selected: string[] = [];
    render(<Harness onSelect={id => selected.push(id)} />);
    fireEvent.mouseEnter(screen.getByRole('menuitemcheckbox', { name: '分屏显示' }));
    await screen.findByRole('menu', { name: '分屏显示' });
    // 悬停到无子项的父项 → flyout 收起
    fireEvent.mouseEnter(screen.getByRole('menuitemcheckbox', { name: '重命名' }));
    await waitFor(() => expect(screen.queryByRole('menu', { name: '分屏显示' })).toBeNull());
    // 主菜单仍在
    expect(screen.getByRole('menuitemcheckbox', { name: '重命名' })).toBeTruthy();
  });

  it('悬停仅预览，键盘进入时跳过禁用项，Esc 返回父项', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onSelect = vi.fn();
    render(<KeybindingProvider>
      <button type="button">菜单入口</button>
      <ContextMenu x={40} y={40} onClose={onClose} onSelect={onSelect} items={[{
        id: 'parent', label: '移动到', children: [
          { id: 'disabled', label: '不可用', disabled: true },
          { id: 'first', label: '第一个' },
          { id: 'second', label: '第二个' }
        ]
      }]} />
    </KeybindingProvider>);
    const origin = screen.getByRole('button', { name: '菜单入口' });
    const parent = screen.getByRole('menuitemcheckbox', { name: '移动到' });
    origin.focus();
    await user.hover(parent);
    expect(document.activeElement).toBe(origin);
    expect(screen.getByRole('menu', { name: '移动到' })).toBeTruthy();
    fireEvent.keyDown(origin, { key: 'Enter', isComposing: true });
    expect(document.activeElement).toBe(origin);

    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: '第一个' }));
    await user.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: '第二个' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu', { name: '移动到' })).toBeNull();
    expect(document.activeElement).toBe(parent);
    expect(onClose).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('选中父项变为禁用后不能用右方向键打开子菜单', () => {
    const menu = (disabled: boolean) => <ContextMenu x={40} y={40} onClose={() => {}} onSelect={() => {}} items={[
      { id: 'parent', label: '移动到', disabled, children: [{ id: 'child', label: '归档工作区' }] },
      { id: 'rename', label: '重命名' }
    ]} />;
    const { rerender } = render(menu(false));
    expect(screen.getByRole('menu').getAttribute('aria-activedescendant')).toBe('ctx-item-parent');
    rerender(menu(true));
    fireEvent.keyDown(document.body, { key: 'ArrowRight' });
    expect(screen.queryByRole('menu', { name: '移动到' })).toBeNull();
  });

  it('键盘：ArrowRight 展开、焦点进子菜单、Enter 选中；ArrowLeft 收起', async () => {
    const user = userEvent.setup({ document });
    const selected: string[] = [];
    render(<Harness onSelect={id => selected.push(id)} />);
    fireEvent.mouseEnter(screen.getByRole('menuitemcheckbox', { name: '分屏显示' }));
    await user.keyboard('{ArrowRight}');
    const left = screen.getByRole('menuitem', { name: '左侧' });
    await waitFor(() => expect(document.activeElement).toBe(left));
    await user.keyboard('{Enter}');
    expect(selected).toEqual(['split-left']);
  });

  it('键盘（F-02）：flyout 内 ↑↓ 循环导航可达第二项及以后，Enter 选中；← 返回父级', async () => {
    const user = userEvent.setup({ document });
    const selected: string[] = [];
    render(<Harness onSelect={id => selected.push(id)} />);
    fireEvent.mouseEnter(screen.getByRole('menuitemcheckbox', { name: '分屏显示' }));
    await user.keyboard('{ArrowRight}');
    const left = screen.getByRole('menuitem', { name: '左侧' });
    await waitFor(() => expect(document.activeElement).toBe(left));

    // ↓ 走到第二项（此前无 flyout 键导航时不可达）
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: '右侧' }));
    // ↑ 回到首项
    await user.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(left);
    // 首项再 ↑ 循环绕到末项（循环导航对齐主菜单）
    await user.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: '下方' }));
    await user.keyboard('{Enter}');
    expect(selected).toEqual(['split-bottom']);

    // 重新打开：← 返回父级收起 flyout
    await user.click(screen.getByRole('button', { name: 'toggle' }));
    fireEvent.mouseEnter(screen.getByRole('menuitemcheckbox', { name: '分屏显示' }));
    await user.keyboard('{ArrowRight}');
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: '左侧' }))
    );
    await user.keyboard('{ArrowLeft}');
    await waitFor(() =>
      expect(screen.queryByRole('menu', { name: '分屏显示' })).toBeNull()
    );
    expect(document.activeElement).toBe(screen.getByRole('menuitemcheckbox', { name: '分屏显示' }));
  });

  it('定位（F-01）：flyout 挂载后按实测宽二次定位，宽子菜单贴右缘改放左侧不溢出', async () => {
    const vw = 400;
    const innerWidthSpy = vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(vw);
    // 主菜单项矩形：右缘 380、左缘 280（贴近视口右缘）
    const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 280, y: 40, top: 40, left: 280, right: 380, bottom: 80, width: 100, height: 40,
      toJSON: () => ({})
    } as DOMRect);
    // flyout 实测宽 200（> 180 估宽回退：估位会停在 100px，实测定位应收进 80px）
    const widthSpy = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(
      function (this: HTMLElement) {
        return this.classList.contains('ctx-flyout') ? 200 : 0;
      }
    );
    try {
      render(<Harness onSelect={() => undefined} />);
      fireEvent.mouseEnter(screen.getByRole('menuitemcheckbox', { name: '分屏显示' }));
      const flyout = await screen.findByRole('menu', { name: '分屏显示' });
      // useLayoutEffect 依实测宽 200 重定位：hostRect.left(280) - 200 = 80
      //（无二次定位的实现会停留在估宽 180 的 100px）
      await waitFor(() => expect(flyout.style.left).toBe('80px'));
      expect(Number.parseFloat(flyout.style.left) + 200).toBeLessThanOrEqual(vw - 8);
    } finally {
      innerWidthSpy.mockRestore();
      rectSpy.mockRestore();
      widthSpy.mockRestore();
    }
  });

  it('浮层合同（F-04）：主菜单根与 flyout 根都挂 data-overlay-root', async () => {
    render(<Harness onSelect={() => undefined} />);
    const root = screen.getByRole('menu');
    expect(root.classList.contains('ctx-menu')).toBe(true);
    expect(root.hasAttribute('data-overlay-root')).toBe(true);
    fireEvent.mouseEnter(screen.getByRole('menuitemcheckbox', { name: '分屏显示' }));
    const flyout = await screen.findByRole('menu', { name: '分屏显示' });
    expect(flyout.hasAttribute('data-overlay-root')).toBe(true);
  });
});
