/**
 * 输入框汇总条「批注N」每项都必须是可点药丸（data-note-id）。
 * 回归：表晚于草稿到达时，最后一颗会落成纯文本、点了没反应——把 noteTokens
 * 对账 rebuild 拿掉，本文件「每项均可点击」应转红。
 * 运行: npx vitest run test/unit/composer-note-tokens.spec.tsx
 */
import React from 'react';
import { fireEvent, render } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ComposerEditable, type ComposerEditableHandle } from '../../src/renderer/src/components/ComposerEditable';

const THREE = [
  { id: 'n1', token: '批注1', title: '一' },
  { id: 'n2', token: '批注2', title: '二' },
  { id: 'n3', token: '批注3', title: '三' }
];

describe('汇总条批注药丸', () => {
  it('表晚到后三颗都切成药丸，每项 mousedown 都能点到对应 id', () => {
    const onNoteTokenClick = vi.fn();
    const view = render(
      <ComposerEditable
        value="批注1 批注2 批注3"
        noteTokens={THREE.slice(0, 2)}
        onChange={() => {}}
        onNoteTokenClick={onNoteTokenClick}
      />
    );
    // 第三颗还不在表里：不应有 data-note-id=n3
    expect(view.container.querySelector('[data-note-id="n3"]')).toBeNull();

    view.rerender(
      <ComposerEditable
        value="批注1 批注2 批注3"
        noteTokens={THREE}
        onChange={() => {}}
        onNoteTokenClick={onNoteTokenClick}
      />
    );

    const pills = view.container.querySelectorAll('.composer-token[data-note-id]');
    expect(pills).toHaveLength(3);
    expect([...pills].map((el) => el.getAttribute('data-note-id'))).toEqual(['n1', 'n2', 'n3']);
    expect([...pills].every((el) => el.hasAttribute('data-note-entry'))).toBe(true);

    fireEvent.mouseDown(pills[0]!);
    fireEvent.mouseDown(pills[1]!);
    fireEvent.mouseDown(pills[2]!);
    expect(onNoteTokenClick.mock.calls.map((c) => c[0])).toEqual(['n1', 'n2', 'n3']);
  });
  it('内容摘要更新原胶囊，序列化仍是编号；点击与快删继续使用 noteId', () => {
    const ref = React.createRef<ComposerEditableHandle>();
    const onChange = vi.fn(); const onNoteTokenClick = vi.fn(); const onNoteTokenDelete = vi.fn();
    const props = { ref, value: '请看批注1', onChange, onNoteTokenClick, onNoteTokenDelete };
    const view = render(<ComposerEditable {...props} noteTokens={[{ id: 'n1', token: '批注1', label: '批注 · 调整字体', title: '原文' }]}/>);
    const pill = view.container.querySelector('[data-note-id="n1"]')!;
    expect(pill.querySelector('.composer-token-label')!.textContent).toBe('批注 · 调整字体');
    expect(ref.current!.getText()).toBe('请看批注1');
    view.rerender(<ComposerEditable {...props} noteTokens={[{ id: 'n1', token: '批注1', label: '批注 · 提高对比度', title: '新引文' }]}/>);
    expect(view.container.querySelector('[data-note-id="n1"]')).toBe(pill);
    expect(pill.querySelector('.composer-token-label')!.textContent).toBe('批注 · 提高对比度');
    expect(pill.getAttribute('title')).toBe('新引文');
    expect(ref.current!.getText()).toBe('请看批注1');
    fireEvent.mouseDown(pill); expect(onNoteTokenClick).toHaveBeenCalledWith('n1');
    fireEvent.mouseDown(pill.querySelector('.composer-token-x')!);
    expect(onNoteTokenDelete).toHaveBeenCalledWith('n1');
    view.rerender(<ComposerEditable {...props} value="请看" noteTokens={[]}/>);
    expect(ref.current!.getText()).toBe('请看');
  });

});
