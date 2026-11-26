/**
 * 右键菜单勾选槽对齐：菜单里只要有一项可勾选（checked 已定义），
 * 所有普通条目也要占同宽空槽，否则只有该项文字右移（会话右键「授权协作工具」曾错位）。
 */
import React from 'react';
import { render } from '@testing-library/react';
import { ContextMenu } from '../../src/renderer/src/components/ContextMenu';

describe('ContextMenu 勾选槽', () => {
  it('混排时每个条目都带 .ctx-check 槽', () => {
    render(
      <ContextMenu
        x={10}
        y={10}
        items={[
          { id: 'rename', label: '重命名' },
          { id: 'sep', separator: true },
          { id: 'grant', label: '授权协作工具', checked: false },
          { id: 'archive', label: '归档' }
        ]}
        onSelect={() => {}}
        onClose={() => {}}
      />
    );
    const items = Array.from(document.querySelectorAll('.ctx-item'));
    expect(items).toHaveLength(3);
    for (const el of items) expect(el.querySelector('.ctx-check')).toBeTruthy();
  });

  it('没有可勾选项时不占槽', () => {
    render(
      <ContextMenu
        x={10}
        y={10}
        items={[
          { id: 'rename', label: '重命名' },
          { id: 'archive', label: '归档' }
        ]}
        onSelect={() => {}}
        onClose={() => {}}
      />
    );
    expect(document.querySelector('.ctx-check')).toBeNull();
  });
});
