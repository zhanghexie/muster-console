import React, { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { NoteEditor } from '../../src/renderer/src/components/NoteEditor';
import { NoteCardShell } from '../../src/renderer/src/components/NoteCardShell';

describe('统一批注编辑卡', () => {
  it('仅显示批注编辑，Enter 留作换行；Ctrl+Enter 保存多行，IME 不提交', () => {
    const onSave = vi.fn();
    render(<NoteEditor initial="" onSave={onSave} onCancel={() => {}}/>);
    expect(document.querySelector('.msg-note-bubble-quote')).toBeNull();
    const input = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(input.tagName).toBe('TEXTAREA');
    expect(document.activeElement).toBe(input);
    expect((screen.getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: ' 第一行\n第二行 ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true, isComposing: true });
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
    expect(onSave).toHaveBeenCalledWith('第一行\n第二行');
  });

  it('编辑无变更不能保存；修改后可保存，Escape/关闭/删除分别触发对应动作', () => {
    const onSave = vi.fn(); const onCancel = vi.fn(); const onDelete = vi.fn();
    render(<NoteEditor initial="原批注" edit onSave={onSave} onCancel={onCancel} onDelete={onDelete}/>);
    const input = screen.getByRole('textbox');
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '新批注' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(onSave).toHaveBeenCalledWith('新批注');
    fireEvent.keyDown(input, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: '关闭批注' }));
    expect(onCancel).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', { name: '删除批注' }));
    expect(onDelete).toHaveBeenCalledOnce();
  });

  it('网页壳受控更新后仍可保存最新内容，点卡内不取消，点外取消', () => {
    const onConfirm = vi.fn(); const onCancel = vi.fn();
    function WebCard() {
      const [value, setValue] = useState('原批注');
      return <NoteCardShell value={value} edit onValueChange={setValue} onConfirm={onConfirm}
        onCancel={onCancel} shot={null} label="发送按钮" selector="button.send" footer="https://example.com"/>;
    }
    render(<WebCard/>);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '减小圆角\n保持主题色' } });
    fireEvent.pointerDown(screen.getByRole('textbox'));
    expect(onCancel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(onConfirm).toHaveBeenCalledWith('减小圆角\n保持主题色');
    fireEvent.pointerDown(document.querySelector('.browser-note-scrim')!);
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
