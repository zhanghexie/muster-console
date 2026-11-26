import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileNoteEntryHost } from '../../src/renderer/src/components/FileNoteEntryHost';
import { StoreProvider } from '../../src/renderer/src/store';
import { closeFileNoteEntry, getFileNoteRecord, openFileNoteEdit, openFileNoteEntry, readFileNoteEntry, removeFileNoteRecord } from '../../src/renderer/src/components/fileNoteEntry';
import { registerFileNoteEditor, registerFileNoteSource, registerFileNoteTarget } from '../../src/renderer/src/agentChat/noteBridge';

vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
afterEach(() => {
  act(() => closeFileNoteEntry());
  registerFileNoteSource(null); registerFileNoteTarget('file-note-test', null); registerFileNoteEditor('file-note-test', null);
  window.getSelection()?.removeAllRanges();
});

describe('文件批注宿主接入统一编辑卡', () => {
  it('保存完整多行批注、路径和引文；重开后编辑更新同一记录并经桥回写', async () => {
    const delivered = vi.fn(() => 1); const update = vi.fn(); const remove = vi.fn();
    const fileRef = { workspaceId: 'ws-a', rootId: 'source-b', relativePath: 'src/main.ts' };
    registerFileNoteSource(() => ({ path: 'src/main.ts', fileRef, line: 3, endLine: 5, markKey: null }));
    registerFileNoteTarget('file-note-test', delivered);
    registerFileNoteEditor('file-note-test', { update, remove });
    await act(async () => { render(<StoreProvider><p data-testid="source">选中的文件原文</p><FileNoteEntryHost/></StoreProvider>); });
    const range = document.createRange(); range.selectNodeContents(screen.getByTestId('source'));
    window.getSelection()!.addRange(range);
    act(() => { expect(openFileNoteEntry({ target: { kind: 'chat', id: 'file-note-test', name: '测试会话' } })).toBe('ok'); });
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: '调整命名\n保持接口不变' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(delivered).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
    expect(delivered).toHaveBeenCalledWith(expect.objectContaining({ path: 'src/main.ts', quote: '选中的文件原文', note: '调整命名\n保持接口不变' }));
    expect(readFileNoteEntry()).toBeNull();
    const id = (delivered.mock.calls[0] as unknown as [{ noteId: string }])[0].noteId;
    expect(delivered).toHaveBeenCalledWith(expect.objectContaining({ fileRef }));
    expect(getFileNoteRecord(id)?.fileRef).toEqual(fileRef);
    act(() => { expect(openFileNoteEdit(id)).toBe(true); });
    expect(readFileNoteEntry()?.capture.fileRef).toEqual(fileRef);
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('调整命名\n保持接口不变');
    expect((screen.getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '改用清晰命名' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(update).toHaveBeenCalledWith(id, '改用清晰命名');
    expect(getFileNoteRecord(id)?.note).toBe('改用清晰命名');
    act(() => openFileNoteEdit(id));
    fireEvent.click(screen.getByRole('button', { name: '删除批注' }));
    expect(remove).toHaveBeenCalledWith(id);
    expect(getFileNoteRecord(id)).toBeUndefined();
    removeFileNoteRecord(id);
  });
});
