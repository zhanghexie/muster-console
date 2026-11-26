import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ComposerEditable, type ComposerEditableHandle } from '../../src/renderer/src/components/ComposerEditable';
import { AgentComposer } from '../../src/renderer/src/components/AgentComposer';
import { ChatMessageView } from '../../src/renderer/src/components/ChatMessageView';
import { StoreProvider } from '../../src/renderer/src/store';
import { composerOffsetOfPosition, resolveComposerPosition } from '../../src/renderer/src/components/composerDomText';
import type { ChatMessage } from '../../src/shared/types';

describe('输入换行与用户 Markdown', () => {
  it.each([
    ['测试输入<div>1. 测试1</div><div>2. 测试2</div>', '测试输入\n1. 测试1\n2. 测试2'],
    ['<div>第一行</div><div><br></div><div>第三行</div>', '第一行\n\n第三行'],
    ['第一行<div><br></div><div><br></div>', '第一行\n\n'],
    ['<p>第一行<br>续行</p><p>下一段</p>', '第一行\n续行\n下一段'],
    ['<div><br></div><div>第二行</div>', '\n第二行']
  ])('原生行块保留换行及空行：%s', (html, text) => {
    const ref = React.createRef<ComposerEditableHandle>();
    const onChange = vi.fn();
    render(<ComposerEditable ref={ref} value="" onChange={onChange}/>);
    const editor = screen.getByRole('textbox');
    editor.innerHTML = html; fireEvent.input(editor);
    expect(ref.current!.getText()).toBe(text);
    expect(onChange).toHaveBeenLastCalledWith(text, text.length);
    for (let offset = 0; offset <= text.length; offset++) {
      const position = resolveComposerPosition(editor, offset);
      // Markdown source prefixes are virtual: every offset inside one maps to
      // the first real caret position after the prefix.
      const prefix = [...editor.querySelectorAll<HTMLElement>('[data-prefix]')].find(line => {
        const end = composerOffsetOfPosition(editor, line, 0);
        return offset >= end - (line.dataset.prefix?.length ?? 0) && offset < end;
      });
      const expected = prefix ? composerOffsetOfPosition(editor, prefix, 0) : offset;
      expect(composerOffsetOfPosition(editor, position.node, position.offset)).toBe(expected);
    }
  });

  it('多行中的 token 不包含装饰文字，光标插入保持行号与引用', () => {
    const ref = React.createRef<ComposerEditableHandle>();
    render(<ComposerEditable ref={ref} value="" onChange={() => {}}/>);
    const editor = screen.getByRole('textbox');
    editor.innerHTML = '标题<div><span contenteditable="false" data-token="批注1">内容摘要 ×</span></div><div>末行</div>';
    fireEvent.input(editor);
    expect(ref.current!.getText()).toBe('标题\n批注1\n末行');
    act(() => { ref.current!.focus(); ref.current!.setCaret(7); ref.current!.insertToken({type:'file',path:'src/app.ts'}); });
    expect(ref.current!.getText()).toBe('标题\n批注1\n@src/app.ts 末行');
  });

  it('真实 Composer 发送读取原生多行 DOM，不丢换行', async () => {
    const onSend = vi.fn(async () => true);
    render(<StoreProvider><AgentComposer workspaceId="newline-ws" surfaceKind="gui-session" busy={false} onSend={onSend} onClear={async () => {}}/></StoreProvider>);
    const editor = screen.getByRole('textbox');
    editor.innerHTML = '测试输入<div>1. 测试1</div><div>2. 测试2</div>';
    fireEvent.input(editor); fireEvent.keyDown(editor, {key:'Enter'});
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('测试输入\n1. 测试1\n2. 测试2', undefined));
  });

  it.each([false, true])('用户消息支持标题、两种列表和普通换行（parts=%s）', (parts) => {
    const text = '# 标题\n\n第一行\n第二行\n\n1. 有序一\n2. 有序二\n\n- 无序一\n- 无序二';
    const message = {id:'markdown-user',role:'user',content:text, ...(parts ? {parts:[{kind:'text',text}]} : {})} as ChatMessage;
    const {container} = render(<ChatMessageView message={message}/>);
    expect(container.querySelector('.chat-msg.user h1')?.textContent).toBe('标题');
    expect([...container.querySelectorAll('ol li')].map(el=>el.textContent)).toEqual(['有序一','有序二']);
    expect([...container.querySelectorAll('ul li')].map(el=>el.textContent)).toEqual(['无序一','无序二']);
    expect(container.querySelector('p')?.textContent).toBe('第一行\n第二行');
  });
});
