import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SetupCoachmark } from '../../src/renderer/src/onboarding/SetupCoachmark';
import { WorkbenchSetupGuide } from '../../src/renderer/src/onboarding/WorkbenchSetupGuide';
import { KeybindingProvider, useKeybindings } from '../../src/renderer/src/keybindings/KeybindingHost';
import { isInsideOverlay } from '../../src/renderer/src/keybindings/overlayStack';

function rect(left = 100, top = 100) { return new DOMRect(left, top, 80, 32); }

describe('SetupCoachmark', () => {
  let geometry: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    geometry = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this.matches('[data-anchor]') ? rect() : new DOMRect(0, 0, 304, 120);
    });
  });
  afterEach(() => geometry.mockRestore());

  it('locks outside pointer, wheel, focus and Tab while preserving real target and card actions', () => {
    const outside = vi.fn(), inside = vi.fn(), next = vi.fn();
    render(<><button onClick={outside}>背景操作</button><button data-anchor="" onClick={inside}>高亮操作</button>
      <SetupCoachmark lockOutside target="[data-anchor]" title="工作区" actions={<button onClick={next}>继续</button>}>说明</SetupCoachmark></>);
    const target = screen.getByRole('button', { name: '高亮操作' });
    const background = screen.getByRole('button', { name: '背景操作' });
    const action = screen.getByRole('button', { name: '继续' });
    fireEvent.click(background);
    expect(outside).not.toHaveBeenCalled();
    expect(fireEvent.wheel(background)).toBe(false);
    fireEvent.click(target); fireEvent.click(action);
    expect(inside).toHaveBeenCalledOnce(); expect(next).toHaveBeenCalledOnce();
    background.focus(); expect(document.activeElement).toBe(target);
    fireEvent.keyDown(target, { key: 'Tab' }); expect(document.activeElement).toBe(action);
    fireEvent.keyDown(action, { key: 'Tab' }); expect(document.activeElement).toBe(target);
    fireEvent.keyDown(target, { key: 'Tab', shiftKey: true }); expect(document.activeElement).toBe(action);
    expect(document.querySelector('[data-setup-lock="true"]')).toBeTruthy();
    expect(document.querySelectorAll('.setup-coachmark-blockers > div')).toHaveLength(4);
  });

  it('permits outside middle-button board toggling only in the board tour', () => {
    const middle = vi.fn();
    const { rerender } = render(<><div onMouseDown={middle}>背景</div><button data-anchor="">目标</button>
      <SetupCoachmark lockOutside target="[data-anchor]" title="看板">说明</SetupCoachmark></>);
    fireEvent.mouseDown(screen.getByText('背景'), { button: 1 });
    expect(middle).not.toHaveBeenCalled();
    rerender(<><div onMouseDown={middle}>背景</div><button data-anchor="">目标</button>
      <SetupCoachmark lockOutside allowBoardToggle target="[data-anchor]" title="看板">说明</SetupCoachmark></>);
    fireEvent.mouseDown(screen.getByText('背景'), { button: 1 });
    expect(middle).toHaveBeenCalledOnce();
    expect(document.querySelector('[data-setup-allow-board="true"]')).toBeTruthy();
  });

  it('keeps the real anchor interactive and preserves an edited field focus', async () => {
    const click = vi.fn();
    render(<><input aria-label="密钥" /><button data-anchor="" onClick={click}>添加模型</button></>);
    const field = screen.getByRole('textbox');
    field.focus();
    render(<SetupCoachmark target="[data-anchor]" title="连接模型" progress="1 / 3" actions={<button>下一步</button>}>使用真实控件完成设置</SetupCoachmark>);
    expect(screen.getByRole('dialog').getAttribute('aria-modal')).toBe('false');
    expect(document.activeElement).toBe(field);
    fireEvent.click(screen.getByRole('button', { name: '添加模型' }));
    expect(click).toHaveBeenCalledOnce();
    expect(document.querySelector('[data-setup-spotlight]')).toBeTruthy();
    expect(screen.getByRole('button', { name: '下一步' })).toBeTruthy();
  });

  it('chooses a visible candidate and uses fallback while the main section is folded', async () => {
    render(<><button data-anchor="" className="primary" hidden>隐藏</button><button data-anchor="" className="fallback">备用</button>
      <SetupCoachmark target=".primary" fallbackTarget=".fallback" title="设置">继续</SetupCoachmark></>);
    expect(screen.getByRole('dialog')).toBeTruthy();
    const anchor = screen.getByRole('button', { name: '备用' });
    act(() => anchor.setAttribute('hidden', ''));
    await waitFor(() => expect(document.querySelector('[data-setup-coachmark]')?.getAttribute('data-mp-stage')).toBe('out'));
    act(() => anchor.removeAttribute('hidden'));
    await waitFor(() => expect(document.querySelector('[data-setup-coachmark]')?.getAttribute('data-mp-stage')).toBe('in'));
  });

  it('repositions after scroll and supports opt-in target focus and explicit dismissal', async () => {
    const dismiss = vi.fn();
    render(<><button data-anchor="">目标</button><SetupCoachmark target="[data-anchor]" title="设置" focusTarget onDismiss={dismiss}>说明</SetupCoachmark></>);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '目标' }));
    geometry.mockImplementation(function (this: HTMLElement) { return this.matches('[data-anchor]') ? rect(200, 200) : new DOMRect(0, 0, 304, 120); });
    fireEvent.scroll(window);
    await waitFor(() => expect((document.querySelector('[data-setup-spotlight]') as HTMLElement).style.left).toBe('195px'));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(dismiss).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: '关闭引导' }));
    expect(dismiss).toHaveBeenCalledTimes(2);
  });

  it('waits for a late-mounted anchor without drawing a disconnected card', async () => {
    const { rerender } = render(<SetupCoachmark target=".late" title="稍后">说明</SetupCoachmark>);
    expect(screen.queryByRole('dialog')).toBeNull();
    rerender(<><button className="late" data-anchor="">出现</button><SetupCoachmark target=".late" title="稍后">说明</SetupCoachmark></>);
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
  });

  it('places a full-height peek strip card beside the strip without covering it', async () => {
    geometry.mockImplementation(function (this: HTMLElement) {
      return this.matches('[data-anchor]') ? new DOMRect(innerWidth - 160, 0, 160, innerHeight) : new DOMRect(0, 0, 304, 120);
    });
    render(<><button data-anchor="">展开虚拟屏</button><SetupCoachmark target="[data-anchor]" title="展开">说明</SetupCoachmark></>);
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('data-side')).toBe('left');
    expect(parseFloat(dialog.style.left) + 304).toBeLessThan(innerWidth - 160);
  });

  it('skips disabled controls and recovers when enabled; watches target marker changes', async () => {
    render(<><button data-anchor="" disabled>等待</button><SetupCoachmark target="[data-setup-target=ready]" title="准备">说明</SetupCoachmark></>);
    expect(screen.queryByRole('dialog')).toBeNull();
    const anchor = screen.getByRole('button', { name: '等待' });
    act(() => anchor.setAttribute('data-setup-target', 'ready'));
    await new Promise(resolve => requestAnimationFrame(resolve));
    expect(screen.queryByRole('dialog')).toBeNull();
    act(() => anchor.removeAttribute('disabled'));
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
  });

  it('links target context, routes forward Tab to coachmark actions, and ignores composing Escape', () => {
    const dismiss = vi.fn();
    const { unmount } = render(<><button data-anchor="" aria-describedby="existing">目标</button><SetupCoachmark target="[data-anchor]" title="设置" dismissLabel="稍后继续" onDismiss={dismiss}>说明</SetupCoachmark></>);
    const anchor = screen.getByRole('button', { name: '目标' });
    expect(anchor.getAttribute('aria-describedby')).toContain(screen.getByRole('dialog').getAttribute('aria-describedby'));
    anchor.focus();
    fireEvent.keyDown(anchor, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '稍后继续' }));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape', isComposing: true });
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape', keyCode: 229 });
    expect(dismiss).not.toHaveBeenCalled();
    unmount();
    expect(anchor.getAttribute('aria-describedby')).toBe('existing');
  });

  it('describes the middle button and current shortcut, then moves to the real board tabs', async () => {
    const move = vi.fn();
    const pause = vi.fn();
    let rebind: (chord: string | null) => Promise<void>;
    function Harness(): React.JSX.Element {
      const [boardOpen, setBoardOpen] = React.useState(false);
      const { setOverride } = useKeybindings();
      rebind = chord => setOverride('globalBoard.toggle', chord);
      return <>
        <button data-anchor="" data-setup-target="global-board" onClick={() => setBoardOpen(true)}>全局看板</button>
        {boardOpen && <div role="tablist" data-anchor="" data-setup-target="global-board-views">
          <button role="tab" aria-selected="true">状态</button>
          <button role="tab" aria-selected="false">自由</button>
        </div>}
        <WorkbenchSetupGuide step="board" setup={{ step: 'board', hasWorkspace: true, hasSession: true,
          deferred: [], configuredModel: false, move, onPause: pause, onResume: vi.fn(), onModelReturn: vi.fn() }}
          narrow={false} sidebarHidden={false} onGitPage={false} virtualScreenOpen={false} rightPanelOpen={false}
          boardOpen={boardOpen} onCloseBoard={() => setBoardOpen(false)} />
      </>;
    }
    await act(async () => { render(<KeybindingProvider><Harness /></KeybindingProvider>); });
    const open = screen.getByRole('button', { name: '全局看板' });
    expect(document.activeElement).toBe(open);
    const guide = () => screen.getByRole('dialog', { name: '使用全局看板' }).textContent;
    expect(guide()).toContain('按鼠标中键或快捷键 Ctrl+Shift+G 打开');
    await act(async () => { await rebind('alt+shift+b'); });
    expect(guide()).toContain('按鼠标中键或快捷键 Alt+Shift+B 打开');
    expect(guide()).not.toContain('Ctrl+Shift+G');
    await act(async () => { await rebind(null); });
    expect(guide()).toContain('也可以按鼠标中键打开');
    expect(guide()).toContain('可在「设置 → 快捷键」为看板设置快捷键');
    expect(guide()).not.toContain('或快捷键');
    fireEvent.click(open);
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: '状态' }));
    expect(screen.getByRole('dialog', { name: '使用全局看板' }).textContent).toContain('筛选工作区或新建任务');
    const next = screen.getByRole('button', { name: '下一步' });
    expect(isInsideOverlay(next)).toBe(true);
    fireEvent.click(next);
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(move).toHaveBeenCalledWith('theme');
  });
});
