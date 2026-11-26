import React from 'react';
import { act, render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { closeTopOverlay } from '../../src/renderer/src/keybindings/overlayStack';
import { SettingsDetailHeadingScope, SettingsSectionJumpProvider } from '../../src/renderer/src/components/settings/SettingsSectionJump';
import { SettingsDetailSection } from '../../src/renderer/src/components/settings/SettingsResource';
import { SettingsSection } from '../../src/renderer/src/components/settings/shared';

function Fixture({ activeTab = 'general' }: { activeTab?: string }): React.JSX.Element {
  return <main className="settings-sheet"><SettingsSectionJumpProvider activeTab={activeTab}>
    <div className="settings-tabpanes"><div className="settings-tabpane">
      <header className="settings-pane-title" />
      <SettingsSection title="语言与文字"><p>内容</p></SettingsSection>
      <SettingsSection title="任务与工作区"><p>内容</p></SettingsSection>
      <div aria-hidden="true"><SettingsSection title="隐藏分组"><p>内容</p></SettingsSection></div>
      <div style={{ overflowY: 'auto' }}><SettingsSection title="独立详情"><p>内容</p></SettingsSection></div>
      <div className="settings-resource-detail"><SettingsDetailHeadingScope>
        <SettingsDetailSection title="基本信息"><p>内容</p></SettingsDetailSection>
        <SettingsSection title="可用模型"><p>内容</p></SettingsSection>
      </SettingsDetailHeadingScope></div>
    </div></div>
  </SettingsSectionJumpProvider></main>;
}

describe('设置分区快速跳转', () => {
  it('点击标题只列出当前可见滚动区的分组，选择后定位并恢复焦点', async () => {
    const user = userEvent.setup();
    render(<Fixture />);
    const pane = document.querySelector<HTMLElement>('.settings-tabpane')!;
    pane.scrollTo = vi.fn();
    await user.click(screen.getByRole('button', { name: '语言与文字' }));
    const dialog = screen.getByRole('dialog', { name: '快速跳转' });
    expect(within(dialog).queryByRole('button', { name: '关闭' })).toBeNull();
    expect(within(dialog).getByRole('button', { name: '语言与文字' })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: '任务与工作区' })).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: '隐藏分组' })).toBeNull();
    expect(within(dialog).queryByRole('button', { name: '独立详情' })).toBeNull();
    expect(document.querySelector<HTMLElement>('.settings-tabpanes')!.inert).toBe(true);
    await user.click(within(dialog).getByRole('button', { name: '任务与工作区' }));
    expect(pane.scrollTo).toHaveBeenCalledOnce();
    expect(document.querySelector<HTMLElement>('.settings-tabpanes')!.inert).toBe(false);
    expect(document.activeElement?.textContent).toBe('任务与工作区');
  });

  it('点击索引的空白区域关闭并恢复焦点', async () => {
    const user = userEvent.setup();
    render(<Fixture />);
    const trigger = screen.getByRole('button', { name: '语言与文字' });
    await user.click(trigger);
    const dialog = screen.getByRole('dialog', { name: '快速跳转' });
    await user.click(within(dialog).getByRole('heading', { name: '快速跳转' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '快速跳转' })).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it('双栏详情标题不可跳转，普通设置标题仍能打开索引', async () => {
    const user = userEvent.setup();
    render(<Fixture />);
    const detail = document.querySelector('.settings-resource-detail') as HTMLElement;
    for (const name of ['基本信息', '可用模型']) {
      const heading = within(detail).getByRole('heading', { name });
      expect(within(heading).queryByRole('button')).toBeNull();
      await user.click(heading);
      expect(screen.queryByRole('dialog', { name: '快速跳转' })).toBeNull();
    }
    await user.click(screen.getByRole('button', { name: '语言与文字' }));
    const index = screen.getByRole('dialog', { name: '快速跳转' });
    expect(within(index).getByRole('button', { name: '任务与工作区' })).toBeTruthy();
    expect(within(index).queryByRole('button', { name: '可用模型' })).toBeNull();
  });

  it('Esc 关闭索引并回到触发标题；切换设置页也会关闭', async () => {
    const user = userEvent.setup();
    const view = render(<Fixture />);
    const trigger = screen.getByRole('button', { name: '语言与文字' });
    trigger.focus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('dialog', { name: '快速跳转' })).toBeTruthy();
    act(() => { expect(closeTopOverlay()).toBe(true); });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '快速跳转' })).toBeNull());
    expect(document.activeElement).toBe(trigger);
    await user.click(trigger);
    view.rerender(<Fixture activeTab="appearance" />);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '快速跳转' })).toBeNull());
  });
});
