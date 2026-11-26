import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { RightWorkspaceToolbar } from '../../src/renderer/src/components/RightWorkspaceToolbar';
import { KeybindingProvider, KeyChordHint, useKeybindings } from '../../src/renderer/src/keybindings/KeybindingHost';

function Toolbar({ backDepth = 3, forwardDepth = 1 }: { backDepth?: number; forwardDepth?: number }) {
  const keys = useKeybindings();
  return <><RightWorkspaceToolbar tabs={[]} panel="files" collapsed={false} backDepth={backDepth} forwardDepth={forwardDepth}
    onHistory={() => {}} onSelect={() => {}} onClose={() => {}} onAction={() => {}} onMove={() => {}} onResource={() => {}} onCollapse={() => {}}/>
    <button onClick={() => { void keys.setOverride('sideTools.back', 'ctrl+shift+j'); }}>改绑撤销</button>
    <button onClick={() => { void keys.setOverride('sideTools.forward', null); }}>解绑重做</button>
    <span data-testid="forward-key"><KeyChordHint actionId="sideTools.forward"/></span></>;
}

it('右侧历史提示显示实际步数和默认快捷键，空栈置灰但仍保留快捷键说明', async () => {
  const view = render(<KeybindingProvider><Toolbar/></KeybindingProvider>);
  await act(async () => {});
  const back = screen.getByRole('button', { name: '撤销' }) as HTMLButtonElement;
  const forward = screen.getByRole('button', { name: '重做' }) as HTMLButtonElement;
  expect(forward.querySelector('svg.right-forward')).toBeTruthy();
  expect(back.querySelector('svg path')?.getAttribute('d')).toBe(forward.querySelector('svg path')?.getAttribute('d'));
  expect(back.title).toBe('撤销（可撤销 3 步） · Ctrl+Alt+←');
  expect(forward.title).toBe('重做（可重做 1 步） · Ctrl+Alt+→');
  view.rerender(<KeybindingProvider><Toolbar backDepth={0} forwardDepth={0}/></KeybindingProvider>);
  expect(back.disabled).toBe(true); expect(forward.disabled).toBe(true);
  expect(back.title).toBe('撤销 · Ctrl+Alt+←'); expect(forward.title).toBe('重做 · Ctrl+Alt+→');
});

it('真实 KeybindingProvider 改绑/解绑后右侧悬浮提示即时更新', async () => {
  render(<KeybindingProvider><Toolbar/></KeybindingProvider>);
  await act(async () => {});
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '改绑撤销' })); });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '解绑重做' })); });
  expect(screen.getByRole('button', { name: '撤销' }).title).toBe('撤销（可撤销 3 步） · Ctrl+Shift+J');
  expect(screen.getByRole('button', { name: '重做' }).title).toBe('重做（可重做 1 步）');
  expect(screen.getByTestId('forward-key').textContent).toBe('');
});
