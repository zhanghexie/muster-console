import React from 'react';
import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { currentApiMock } from './helpers/api-mock';
import { SystemShortcutsSettings } from '../../src/renderer/src/components/settings/SystemShortcutsSettings';
import { ComposerToolbarLeft } from '../../src/renderer/src/components/agentComposer/ComposerToolbarLeft';
import { useSystemShortcuts } from '../../src/renderer/src/components/agentComposer/useSystemShortcuts';
import { applyLocaleSetting } from '../../src/shared/i18n';
import { KeybindingProvider, useKeybinding } from '../../src/renderer/src/keybindings/KeybindingHost';
import { KeybindingsPane } from '../../src/renderer/src/components/settings/KeybindingsPane';

const screenshot = { id: 'shot', name: '截图', chord: 'ctrl+alt+a' };
describe('system shortcuts', () => {
  it('switches between workbench and system recording without re-enabling application shortcuts', async () => {
    const settings = vi.fn();
    function Pane() { useKeybinding('settings.open', settings); return <KeybindingsPane/>; }
    render(<KeybindingProvider><Pane/></KeybindingProvider>);
    await waitFor(() => expect((screen.getByLabelText('系统组合键') as HTMLButtonElement).disabled).toBe(false));
    const workbench = within(document.querySelector('.kb-workbench-section') as HTMLElement);
    fireEvent.click(workbench.getAllByTitle('点击后按下新快捷键')[0]);
    fireEvent.click(screen.getByLabelText('系统组合键'));
    fireEvent.keyDown(window, { key: ',', ctrlKey: true });
    expect(settings).not.toHaveBeenCalled();
    expect(screen.getByLabelText('系统组合键').getAttribute('aria-pressed')).toBe('true');
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(screen.getByLabelText('系统组合键'));
    fireEvent.click(workbench.getAllByTitle('点击后按下新快捷键')[0]);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(settings).not.toHaveBeenCalled();
    expect(screen.getByLabelText('系统组合键').getAttribute('aria-pressed')).toBe('false');
    expect(currentApiMock().mockOf('config.update')).not.toHaveBeenCalled();
  });
  it.each([
    ['Win32', 'Shift+Win+S'], ['MacIntel', 'Shift+Cmd+S'], ['Linux x86_64', 'Shift+Super+S']
  ])('records the same portable chord and displays native modifiers on %s', async (platform, label) => {
    const previous = Object.getOwnPropertyDescriptor(navigator, 'platform');
    Object.defineProperty(navigator, 'platform', { configurable: true, value: platform });
    try {
      render(<SystemShortcutsSettings/>);
      await waitFor(() => expect((screen.getByLabelText('系统组合键') as HTMLButtonElement).disabled).toBe(false));
      fireEvent.click(screen.getByLabelText('系统组合键'));
      fireEvent.keyDown(window, { key: 'S', shiftKey: true, metaKey: true });
      expect(screen.getByLabelText('系统组合键').textContent).toBe(label);
      expect(currentApiMock().mockOf('config.update')).not.toHaveBeenCalled();
    } finally {
      if (previous) Object.defineProperty(navigator, 'platform', previous);
      else Reflect.deleteProperty(navigator, 'platform');
    }
  });
  it('captures keyboard input, cancels without losing the chord, and releases capture on page exit', async () => {
    const api = currentApiMock();
    api.mockOf('config.get').mockResolvedValue({ systemShortcuts: [screenshot] });
    const openSettings = vi.fn();
    function Pane({ active }: { active: boolean }) {
      useKeybinding('settings.open', openSettings);
      return <SystemShortcutsSettings active={active}/>;
    }
    const view = render(<KeybindingProvider><Pane active /></KeybindingProvider>);
    await screen.findByLabelText('编辑 截图');
    fireEvent.click(screen.getByLabelText('修改 截图 的快捷键'));
    fireEvent.keyDown(window, { key: ',', ctrlKey: true });
    expect(openSettings).not.toHaveBeenCalled();
    expect(screen.getByLabelText('系统组合键').textContent).toContain('按下快捷键');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByLabelText('系统组合键').textContent).toBe('Ctrl+Alt+A');
    expect(api.mockOf('config.update')).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText('系统组合键'));
    fireEvent.keyDown(window, { key: 'Control', ctrlKey: true });
    expect(screen.getByLabelText('系统组合键').getAttribute('aria-pressed')).toBe('true');
    view.rerender(<KeybindingProvider><Pane active={false}/></KeybindingProvider>);
    fireEvent.keyDown(window, { key: ',', ctrlKey: true });
    expect(openSettings).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('系统组合键').textContent).toBe('Ctrl+Alt+A');
    view.rerender(<KeybindingProvider><Pane active/></KeybindingProvider>);
    fireEvent.click(screen.getByLabelText('系统组合键'));
    fireEvent.blur(screen.getByLabelText('系统组合键'));
    expect(screen.getByLabelText('系统组合键').getAttribute('aria-pressed')).toBe('false');
  });
  it('shows a localized fallback when the host gives no failure detail', async () => {
    currentApiMock().mockOf('app.runSystemShortcut').mockResolvedValue({ ok: false });
    applyLocaleSetting('en');
    try {
      const { result } = renderHook(() => useSystemShortcuts(true, () => {}));
      await act(async () => { await result.current.run('shot'); });
      expect(result.current.error).toBe('Failed to send system shortcut');
    } finally { applyLocaleSetting('zh-CN'); }
  });
  it('adds, edits and removes a persisted shortcut without overwriting other config', async () => {
    const api = currentApiMock();
    api.mockOf('config.update').mockImplementation(async patch => patch);
    render(<SystemShortcutsSettings />);
    const name = screen.getByLabelText('操作名称');
    await waitFor(() => expect((name as HTMLInputElement).disabled).toBe(false));
    fireEvent.change(name, { target: { value: '截图' } });
    fireEvent.click(screen.getByLabelText('系统组合键'));
    fireEvent.keyDown(window, { key: 'S', shiftKey: true, metaKey: true });
    fireEvent.click(screen.getByText('添加快捷操作'));
    await screen.findByLabelText('编辑 截图');
    expect(api.mockOf('config.update')).toHaveBeenLastCalledWith({ systemShortcuts: [expect.objectContaining({ name: '截图', chord: 'shift+meta+s' })] });
    const chordButton = screen.getByLabelText('修改 截图 的快捷键');
    expect(chordButton.className).toBe('kb-chord');
    expect(screen.getByLabelText('编辑 截图').className).toBe('kb-icon-btn');
    fireEvent.click(chordButton);
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.change(name, { target: { value: '录屏' } });
    fireEvent.click(screen.getByText('保存修改'));
    await screen.findByLabelText('删除 录屏');
    fireEvent.click(screen.getByLabelText('删除 录屏'));
    await waitFor(() => expect(api.mockOf('config.update')).toHaveBeenLastCalledWith({ systemShortcuts: [] }));
  });

  it('rejects unsupported keys and keeps a failed save draft visible', async () => {
    const api = currentApiMock();
    render(<SystemShortcutsSettings />);
    await waitFor(() => expect((screen.getByLabelText('操作名称') as HTMLInputElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText('操作名称'), { target: { value: '截图' } });
    fireEvent.click(screen.getByLabelText('系统组合键'));
    fireEvent.keyDown(window, { key: 'a' });
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(screen.getByText('添加快捷操作'));
    expect(api.mockOf('config.update')).not.toHaveBeenCalled();
    api.mockOf('config.update').mockRejectedValueOnce(new Error('写入失败'));
    fireEvent.click(screen.getByLabelText('系统组合键'));
    fireEvent.keyDown(window, { key: 'a', ctrlKey: true, altKey: true });
    fireEvent.click(screen.getByText('添加快捷操作'));
    expect((await screen.findByRole('alert')).textContent).toContain('写入失败');
    expect((screen.getByLabelText('操作名称') as HTMLInputElement).value).toBe('截图');
  });

  it('loads configured menu items, closes before dispatch, blocks double click and shows failure', async () => {
    const api = currentApiMock();
    api.mockOf('config.get').mockResolvedValue({ systemShortcuts: [screenshot] });
    api.mockOf('app.runSystemShortcut').mockResolvedValue({ ok: false, error: '发送失败' });
    const closed: boolean[] = [];
    render(<ComposerToolbarLeft plusMenu allowImages={false} showPlusMenu setShowPlusMenu={value => closed.push(value === false)}
      plusMenuPresence={{ mounted: true, stage: 'in', spread: { 'data-mp-stage': 'in' } }} plusMenuRef={{ current: null }} insertTriggerChar={() => {}}
      fileInputRef={{ current: null }} mode="auto" modeLabel={() => ''} presetRoster={null} presetName=""
      showModeMenu={false} setShowModeMenu={() => {}} modeMenuPresence={{ mounted: false, stage: 'out', spread: { 'data-mp-stage': 'out' } }} modeMenuRef={{ current: null }} />);
    const item = await screen.findByRole('menuitem', { name: /截图/ });
    fireEvent.click(item); fireEvent.click(item);
    expect(closed).toEqual([true]);
    expect(api.mockOf('app.runSystemShortcut')).not.toHaveBeenCalled();
    expect((await screen.findByRole('alert')).textContent).toContain('发送失败');
    expect(api.mockOf('app.runSystemShortcut')).toHaveBeenCalledExactlyOnceWith('shot');
  });
});
