import { renderWithAppTips as render, findAppTip } from './helpers/app-tips';
import React, { useState } from 'react';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SettingsPathField } from '../../src/renderer/src/components/settings/SettingsPathField';
import { currentApiMock } from './helpers/api-mock';

describe('SettingsPathField', () => {
  it.each(['C:\\Users\\me\\.claude', '/Users/me/.claude', '/home/me/.claude', '\\\\server\\share\\config'])('reveals %s unchanged through the existing cross-platform shell bridge', async path => {
    const api = currentApiMock(); api.override('shell.revealPath', async () => ({ ok: true }));
    render(<SettingsPathField label="配置目录" path={path}/>);
    const field = screen.getByRole('textbox', { name: '配置目录' }) as HTMLInputElement;
    expect(field.readOnly).toBe(true); expect(field.value).toBe(path);
    expect(screen.getByText('只读')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '打开配置目录的位置' }));
    expect(api.mockOf('shell.revealPath')).toHaveBeenCalledWith(path);
  });
  it.each(['', 'claude', 'https://example.test'])('does not send a non-absolute value to the shell: %s', async path => {
    render(<SettingsPathField label="程序路径" path={path}/>);
    const button = screen.getByRole('button', { name: '打开程序路径的位置' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    await userEvent.click(button);
    expect(currentApiMock().mockOf('shell.revealPath')).not.toHaveBeenCalled();
  });
  it('shows returned failures and supports retry', async () => {
    const api = currentApiMock(); api.override('shell.revealPath', async () => ({ ok: false, error: '目录不存在' }));
    render(<SettingsPathField label="配置目录" path="/missing/config"/>);
    await userEvent.click(screen.getByRole('button', { name: '打开配置目录的位置' }));
    expect((await findAppTip()).textContent).toContain('目录不存在');
    api.override('shell.revealPath', async () => ({ ok: true }));
    await userEvent.click(screen.getByRole('button', { name: '打开配置目录的位置' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });
  it('ignores a late failure for a previous path', async () => {
    let finish!: (result: { ok: boolean; error: string }) => void;
    currentApiMock().override('shell.revealPath', () => new Promise(resolve => { finish = resolve; }));
    const view = render(<SettingsPathField label="配置目录" path="/old/config"/>);
    await userEvent.click(screen.getByRole('button', { name: '打开配置目录的位置' }));
    view.rerender(<SettingsPathField label="配置目录" path="/new/config"/>);
    await act(async () => finish({ ok: false, error: 'old path failed' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect((screen.getByRole('button', { name: '打开配置目录的位置' }) as HTMLButtonElement).disabled).toBe(false);
  });
  it('also supports an editable path with an explicit save action', async () => {
    const save = vi.fn();
    function Editor() { const [path, setPath] = useState('/old/bin'); return <SettingsPathField label="程序路径" path={path} onChange={setPath} action={<button onClick={() => save(path)}>保存</button>}/>; }
    render(<Editor/>);
    expect(screen.queryByText('只读')).toBeNull();
    const field = screen.getByRole('textbox', { name: '程序路径' });
    expect((field as HTMLInputElement).readOnly).toBe(false);
    await userEvent.clear(field); await userEvent.type(field, '/new/bin');
    await userEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(save).toHaveBeenCalledWith('/new/bin');
  });
});
