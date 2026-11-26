import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ComposerEditable, type ComposerEditableHandle } from '../../src/renderer/src/components/ComposerEditable';
import { composerLineFormats, composerNewlineEdit } from '../../src/renderer/src/components/composerMarkdown';
import { composerOffsetOfPosition, resolveComposerPosition } from '../../src/renderer/src/components/composerDomText';

function mount(value: string, onKeyDown?: React.KeyboardEventHandler<HTMLDivElement>) {
  const ref = React.createRef<ComposerEditableHandle>();
  const onChange = vi.fn();
  render(<ComposerEditable ref={ref} value={value} onChange={onChange} onKeyDown={onKeyDown} noteTokens={[{id:'n1',token:'批注1',label:'批注 · 调整字号'}]}/>);
  const editor = screen.getByRole('textbox');
  act(() => { ref.current!.focus(); ref.current!.setCaret(value.length); });
  return { ref, editor, onChange };
}

describe('Markdown 在输入框中呈现与续写', () => {
  it('删除技能后的空格时，Chromium 在胶囊后插入的 br 不是换行', () => {
    const {editor, ref} = mount('');
    act(() => ref.current!.insertToken({type:'skill', name:'review'}));
    const line = editor.querySelector('.composer-md-line')!;
    line.lastChild!.replaceWith(document.createElement('br')); // 模拟 Chromium 删除尾随空格后的 DOM
    fireEvent.input(editor);
    expect(ref.current!.getText()).toBe('/skill:review');
    expect(editor.querySelectorAll('.composer-md-line')).toHaveLength(1);
  });
  it.each([
    ['1. 第一项', '1. 第一项\n2. '], ['9) 项目', '9) 项目\n10) '],
    ['- 项目', '- 项目\n- '], ['* 项目', '* 项目\n* '], ['  + 项目', '  + 项目\n  + '],
    ['1. 第一项\n2. ', '1. 第一项\n'], ['- ', ''],
    ['# 标题', '# 标题\n'], ['普通文字', '普通文字\n'], ['', '\n']
  ])('换行续写/退出：%s', (before, after) => {
    const {ref, editor} = mount(before);
    fireEvent.keyDown(editor, {key:'Enter',shiftKey:true});
    expect(ref.current!.getText()).toBe(after);
    expect(ref.current!.getCaret()).toBe(after.length);
  });

  it('直接展示标题和列表；源标记隐藏但每个字符的偏移仍可往返', () => {
    const text = '# 标题\n\n1. 有序一\n2. 批注1\n- 无序';
    const {editor,ref} = mount(text);
    expect(editor.querySelector('[data-md="heading"][data-level="1"]')).not.toBeNull();
    expect(editor.querySelectorAll('[data-md="ordered"]')).toHaveLength(2);
    expect(editor.querySelector('[data-md="bullet"]')?.getAttribute('data-marker')).toBe('•');
    expect(editor.querySelector('[data-note-id="n1"]')?.textContent).toContain('调整字号');
    expect(ref.current!.getText()).toBe(text);
    // 源前缀不在内联流（零宽 span 毒化 caret 度量）：前缀由行属性 data-prefix 承担
    expect(editor.querySelector('[data-md="heading"]')?.getAttribute('data-prefix')).toBe('# ');
    // Atomic tokens deliberately do not resolve inside the hidden serialized label;
    // md 前缀内部/首后偏移统一归位行首内容位（不再逐字符往返）。
    const tokenAt = text.indexOf('批注1');
    // 各行的源前缀区段 [start, end)：归位值 = end（行内容首位）
    const prefixZones: Array<[number, number]> = [[0, 2], [6, 9], [13, 16], [20, 22]];
    for (let at = 0; at <= text.length; at++) {
      if (at > tokenAt && at < tokenAt + 3) continue;
      const position = resolveComposerPosition(editor, at);
      const back = composerOffsetOfPosition(editor, position.node, position.offset);
      const zone = prefixZones.find(([a, b]) => at >= a && at <= b);
      expect(back).toBe(zone ? zone[1] : at);
    }
  });

  it('普通输入事件立即转换；选中内容后换行不会遗留被替换的文字', () => {
    const {editor,ref} = mount('');
    editor.textContent = '# 标题'; fireEvent.input(editor);
    expect(editor.querySelector('[data-md="heading"]')).not.toBeNull();
    act(() => ref.current!.setCaret(3));
    const start = resolveComposerPosition(editor,3), end = resolveComposerPosition(editor,4);
    window.getSelection()!.setBaseAndExtent(start.node,start.offset,end.node,end.offset);
    fireEvent.keyDown(editor,{key:'Enter',shiftKey:true});
    expect(ref.current!.getText()).toBe('# 标\n');
  });

  it('列表正文开头退格移除格式，而不是删掉隐藏标记的最后一个空格', () => {
    const {editor,ref} = mount('1. 第一项');
    fireEvent.keyDown(editor,{key:'Home'});
    expect(ref.current!.getCaret()).toBe(3);
    fireEvent.keyDown(editor,{key:'Backspace'});
    expect(ref.current!.getText()).toBe('第一项');
    expect(editor.querySelector('[data-md]')).toBeNull();
    fireEvent.keyDown(editor,{key:'z',ctrlKey:true});
    expect(ref.current!.getText()).toBe('1. 第一项');
    expect(ref.current!.getCaret()).toBe(3);
  });

  it('选中整段列表正文后删除会同时清除不可选中的源前缀，且可撤销', () => {
    const { editor, ref, onChange } = mount('1. 第一项');
    const line = editor.querySelector('[data-md="ordered"]')!;
    const range = document.createRange(); range.selectNodeContents(line);
    window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
    const event = new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'deleteContentBackward' });
    fireEvent(editor, event);
    expect(event.defaultPrevented).toBe(true);
    expect(ref.current!.getText()).toBe('');
    expect(editor.getAttribute('data-empty')).toBe('true');
    expect(onChange).toHaveBeenLastCalledWith('', 0);
    fireEvent.keyDown(editor, { key: 'z', ctrlKey: true });
    expect(ref.current!.getText()).toBe('1. 第一项');
    expect(editor.querySelector('[data-md="ordered"]')).not.toBeNull();
  });

  it('部分选择列表正文时不吞掉未选中的前缀或正文', () => {
    const { editor, ref } = mount('1. 第一项');
    const node = editor.querySelector('[data-md="ordered"]')!.firstChild!;
    const range = document.createRange(); range.setStart(node, 1); range.setEnd(node, 2);
    window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
    const event = new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'deleteContentBackward' });
    fireEvent(editor, event);
    expect(event.defaultPrevented).toBe(false);
    expect(ref.current!.getText()).toBe('1. 第一项');
  });

  it('续写可撤销/重做，文件、技能和批注胶囊保留原子节点', () => {
    const {editor,ref} = mount('- 批注1');
    act(() => ref.current!.insertToken({type:'file',path:'src/app.ts'}));
    act(() => ref.current!.insertToken({type:'skill',name:'review'}));
    const before = ref.current!.getText();
    const file = editor.querySelector('[data-token="@src/app.ts"]');
    fireEvent.keyDown(editor,{key:'Enter',shiftKey:true});
    expect(ref.current!.getText()).toBe(before+'\n- ');
    expect(editor.querySelector('[data-token="@src/app.ts"]')).toBe(file);
    fireEvent.keyDown(editor,{key:'z',ctrlKey:true});
    expect(ref.current!.getText()).toBe(before);
    fireEvent.keyDown(editor,{key:'z',ctrlKey:true,shiftKey:true});
    expect(ref.current!.getText()).toBe(before+'\n- ');
    expect(editor.querySelectorAll('[data-token]')).toHaveLength(3);
  });

  it('合成期不重建 DOM、不续写、不发送；合成完成后呈现格式', () => {
    const {editor,ref} = mount('');
    fireEvent.compositionStart(editor);
    editor.textContent = '1. 中文'; fireEvent.input(editor);
    const node = editor.firstChild;
    fireEvent.keyDown(editor,{key:'Enter',shiftKey:true,isComposing:true});
    expect(editor.firstChild).toBe(node);
    expect(ref.current!.getText()).toBe('1. 中文');
    expect(editor.querySelector('[data-md]')).toBeNull();
    fireEvent.compositionEnd(editor);
    expect(editor.querySelector('[data-md="ordered"]')).not.toBeNull();
    fireEvent.keyDown(editor,{key:'z',ctrlKey:true});
    expect(ref.current!.getText()).toBe('');
  });

  it('输入法确认回车不会传给发送层，合成结束后正常回车才会传递', () => {
    const onKeyDown = vi.fn();
    const { editor } = mount('', onKeyDown);
    fireEvent.compositionStart(editor);
    fireEvent.keyDown(editor, { key: 'Enter', keyCode: 13 });
    fireEvent.compositionEnd(editor);
    fireEvent.keyDown(editor, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(editor, { key: 'Enter', keyCode: 229 });
    expect(onKeyDown).not.toHaveBeenCalled();
    fireEvent.keyDown(editor, { key: 'Enter', keyCode: 13 });
    expect(onKeyDown).toHaveBeenCalledTimes(1);
  });

  it('粘贴净化 HTML 和 CRLF，复制/剪切仍给出 Markdown 源码；草稿替换重置撤销栈', () => {
    const {editor,ref} = mount('');
    fireEvent.paste(editor,{clipboardData:{items:[],getData:()=> '# 标题\r\n\r\n- 项目'}});
    expect(ref.current!.getText()).toBe('# 标题\n\n- 项目');
    expect(editor.querySelector('[data-md="heading"]')).not.toBeNull();
    const range = document.createRange(); range.selectNodeContents(editor);
    window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
    const setData = vi.fn(); fireEvent.copy(editor,{clipboardData:{setData}});
    expect(setData).toHaveBeenCalledWith('text/plain','# 标题\n\n- 项目');
    fireEvent.cut(editor,{clipboardData:{setData}});
    expect(ref.current!.getText()).toBe('');
    fireEvent.keyDown(editor,{key:'z',ctrlKey:true});
    expect(ref.current!.getText()).toBe('# 标题\n\n- 项目');
    act(() => ref.current!.setText('外部草稿'));
    fireEvent.keyDown(editor,{key:'z',ctrlKey:true});
    expect(ref.current!.getText()).toBe('外部草稿');
  });

  it('代码围栏里的标记不转换、不续写；中间插行保留后半段', () => {
    const text = '```md\n# 源码\n1. 源码\n```\n# 标题';
    expect(composerLineFormats(text).map(f=>f?.kind??null)).toEqual([null,null,null,null,'heading']);
    const at = text.indexOf('\n```');
    expect(composerNewlineEdit(text,at)).toEqual({start:at,end:at,text:'\n'});
    const {ref,editor} = mount('1. 前后');
    act(() => ref.current!.setCaret(4));
    fireEvent.keyDown(editor,{key:'Enter',shiftKey:true});
    expect(ref.current!.getText()).toBe('1. 前\n2. 后');
  });
});
