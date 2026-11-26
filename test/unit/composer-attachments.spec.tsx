import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, renderHook, act, waitFor, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useComposerImages } from '../../src/renderer/src/components/agentComposer/useComposerImages';
import { ComposerImageStrip } from '../../src/renderer/src/components/ComposerImageStrip';
import { ComposerEditable } from '../../src/renderer/src/components/ComposerEditable';
import { AttachmentPolicyFields } from '../../src/renderer/src/components/settings/AttachmentPolicyFields';
import { addTosendItem } from '../../src/shared/composerTools';
import { currentApiMock } from './helpers/api-mock';

describe('generic composer attachments', () => {
  it('rejects a later attachment batch when the combined draft exceeds 32 files', () => {
    const error = vi.fn();
    const { result } = renderHook(() => useComposerImages((s: string) => s, 'limit', error));
    act(() => result.current.setImages(Array.from({ length: 32 }, (_, i) => ({ id: String(i), data: 'YQ==', mimeType: 'text/plain' }))));
    act(() => result.current.addImageFiles([new File(['b'], 'extra.txt')]));
    expect(result.current.images).toHaveLength(32);
    expect(error).toHaveBeenCalledWith('一次最多发送 32 个附件');
  });
  it('keeps local documents as paths without base64 encoding and preserves them in the queue', () => {
    currentApiMock().mockOf('shell.pathForFile').mockReturnValueOnce('C:\\Temp\\local.txt');
    const { result } = renderHook(() => useComposerImages((s: string) => s, 'local'));
    act(() => result.current.addImageFiles([new File(['hello'], 'local.txt', { type: 'text/plain' })]));
    expect(result.current.images[0]).toMatchObject({ data: '', sourcePath: 'C:\\Temp\\local.txt', name: 'local.txt' });
    expect(addTosendItem([], '', 1, result.current.images)[0].images?.[0].sourcePath).toBe('C:\\Temp\\local.txt');
    expect(result.current.loading).toBe(false);
  });
  it('reads documents as attachments and preserves source path through manual queue', async () => {
    const error = vi.fn();
    const { result } = renderHook(() => useComposerImages((s: string) => s, 'one', error));
    act(() => result.current.addImageFiles([new File(['hello'], 'notes.txt', { type: 'text/plain' })]));
    await waitFor(() => expect(result.current.images).toHaveLength(1));
    expect(result.current.images[0]).toMatchObject({ name: 'notes.txt', mimeType: 'text/plain', data: 'aGVsbG8=' });
    const im = { ...result.current.images[0], sourcePath: 'C:\\Temp\\notes.txt' };
    expect(addTosendItem([], '', 1, [im])[0].images?.[0].sourcePath).toBe(im.sourcePath);
    act(() => result.current.removeImage(im.id));
    expect(result.current.images).toHaveLength(0);
    expect(error).not.toHaveBeenCalled();
  });
  it('does not attach a late FileReader result to another conversation', async () => {
    const { result, rerender } = renderHook(({ scope }) => useComposerImages((s: string) => s, scope), { initialProps: { scope: 'one' } });
    act(() => result.current.addImageFiles([new File(['hello'], 'old.txt')]));
    rerender({ scope: 'two' });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)); });
    expect(result.current.images).toHaveLength(0); expect(result.current.loading).toBe(false);
  });
  it('pasting a non-image dispatches the file callback', () => {
    const onPasteFiles = vi.fn();
    render(<ComposerEditable value="" onChange={vi.fn()} onPasteFiles={onPasteFiles} />);
    const file = new File(['data'], 'report.csv', { type: 'text/csv' });
    fireEvent.paste(screen.getByRole('textbox'), { clipboardData: {
      items: [{ kind: 'file', type: file.type, getAsFile: () => file }], getData: () => ''
    } });
    expect(onPasteFiles).toHaveBeenCalledWith([file]);
  });
  it('empty native paste uses the file clipboard fallback without changing ordinary text paste', () => {
    const native = vi.fn();
    render(<ComposerEditable value="" onChange={vi.fn()} onPasteNativeFiles={native} />);
    fireEvent.paste(screen.getByRole('textbox'), { clipboardData: { items: [], getData: () => '' } });
    expect(native).toHaveBeenCalledTimes(1);
    fireEvent.paste(screen.getByRole('textbox'), { clipboardData: { items: [], getData: () => 'plain text' } });
    expect(native).toHaveBeenCalledTimes(1);
  });
  it('system file URI takes the native file route even when the clipboard also contains text', () => {
    const native = vi.fn();
    render(<ComposerEditable value="" onChange={vi.fn()} onPasteNativeFiles={native} />);
    fireEvent.paste(screen.getByRole('textbox'), { clipboardData: {
      items: [], types: ['text/uri-list', 'text/plain'],
      getData: (type: string) => type === 'text/uri-list' ? 'file:///tmp/a%20b.png\r\n' : 'file:///tmp/a%20b.png'
    } });
    expect(native).toHaveBeenCalledWith(true);
  });
  it('renders a removable document card without an image lightbox', async () => {
    const remove = vi.fn();
    render(<ComposerImageStrip images={[{ id: 'doc', data: '', mimeType: 'application/pdf', name: 'report.pdf', size: 1024 }]} onRemove={remove} />);
    expect(screen.queryByRole('img')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: '移除附件 report.pdf' }));
    expect(remove).toHaveBeenCalledWith('doc');
  });
  it('edits native capabilities without global conversion settings', async () => {
    function Fields() { const [value, setValue] = React.useState({}); return <AttachmentPolicyFields value={value} onChange={setValue} />; }
    render(<Fields />);
    await userEvent.click(screen.getByLabelText('原生音频输入'));
    expect((screen.getByLabelText('原生音频输入') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('原生视频输入') as HTMLInputElement).checked).toBe(false);
    expect(screen.queryByLabelText('视频最多抽帧数')).toBeNull();
    expect(screen.queryByLabelText('每条消息自动预览页数')).toBeNull();
    expect(screen.queryByLabelText('LibreOffice 路径（PPT 页面转换）')).toBeNull();
  });
});
