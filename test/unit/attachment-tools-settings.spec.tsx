import React from 'react';
import { act, render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { AttachmentToolsSettings } from '../../src/renderer/src/components/settings/AttachmentToolsSettings';
import { AttachmentProcessingSettings } from '../../src/renderer/src/components/settings/AttachmentProcessingSettings';
import { AttachmentPolicyFields } from '../../src/renderer/src/components/settings/AttachmentPolicyFields';
import { normalizeAttachmentTools } from '../../src/shared/attachmentPolicy';
import { applyLocaleSetting } from '../../src/shared/i18n';

describe('machine-wide attachment tools', () => {
  it('keeps executable paths out of model settings', () => {
    render(<AttachmentPolicyFields value={{ nativeAudio: true }} onChange={vi.fn()} />);
    expect(screen.queryByText(/FFmpeg|LibreOffice/)).toBeNull();
    expect(screen.queryByLabelText('每条消息自动预览页数')).toBeNull();
    expect(screen.queryByLabelText('视频最多抽帧数')).toBeNull();
    expect(screen.getByLabelText('原生音频输入')).toBeTruthy();
  });
  it('edits global preview budgets without changing other limits', () => {
    const onChange = vi.fn();
    render(<AttachmentProcessingSettings value={{ videoFrames: 3 }} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('每条消息自动预览页数'), { target: { value: '2' } });
    expect(onChange).toHaveBeenCalledWith({ videoFrames: 3, autoPages: 2 });
  });
  it('translates budget labels while keeping their settings keys and values', () => {
    const onChange = vi.fn();
    try {
      act(() => { applyLocaleSetting('en'); });
      render(<AttachmentProcessingSettings value={{ videoFrames: 3 }} onChange={onChange} />);
      fireEvent.change(screen.getByLabelText('Automatic preview pages per message'), { target: { value: '2' } });
      expect(onChange).toHaveBeenCalledWith({ videoFrames: 3, autoPages: 2 });
    } finally { act(() => { applyLocaleSetting('zh-CN'); }); }
  });
  it('edits global tools without clearing the other executable', () => {
    const onChange = vi.fn();
    render(<AttachmentToolsSettings value={{ libreOfficePath: 'office' }} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('FFmpeg 路径'), { target: { value: 'C:\\tools\\ffmpeg.exe' } });
    expect(onChange).toHaveBeenCalledWith({ libreOfficePath: 'office', ffmpegPath: 'C:\\tools\\ffmpeg.exe' });
  });
  it('migrates legacy paths in priority order and honors explicit global clearing', () => {
    const legacy = [{ ffmpegPath: ' active ' }, { ffmpegPath: 'other', libreOfficePath: ' office ' }];
    expect(normalizeAttachmentTools(undefined, legacy)).toEqual({ ffmpegPath: 'active', libreOfficePath: 'office' });
    expect(normalizeAttachmentTools({}, legacy)).toEqual({});
    expect(normalizeAttachmentTools({ ffmpegPath: ' global ', libreOfficePath: '' }, legacy)).toEqual({ ffmpegPath: 'global' });
  });
});
