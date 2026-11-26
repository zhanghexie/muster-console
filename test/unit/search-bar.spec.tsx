/**
 * SearchBar：计数、清空、Esc 清空并失焦。
 */
import React, { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import { SearchBar } from '../../src/renderer/src/components/SearchBar';

function Harness({
  matchCount,
  matchTotal,
  onEscape
}: {
  matchCount?: number;
  matchTotal?: number;
  onEscape?: () => void;
}): React.JSX.Element {
  const [value, setValue] = useState('');
  return (
    <SearchBar
      value={value}
      onChange={setValue}
      placeholder="搜索…"
      aria-label="搜索"
      matchCount={value ? matchCount : undefined}
      matchTotal={value ? matchTotal : undefined}
      onEscape={onEscape}
    />
  );
}

describe('SearchBar', () => {
  it('输入后显示 n/total，清空按钮清掉查询', async () => {
    const user = userEvent.setup();
    render(<Harness matchCount={3} matchTotal={20} />);

    const input = screen.getByRole('searchbox', { name: '搜索' });
    expect(screen.queryByText('3/20')).toBeNull();
    expect(screen.queryByRole('button', { name: '清空搜索' })).toBeNull();

    await user.type(input, 'foo');
    expect(screen.getByText('3/20')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: '清空搜索' }));
    expect((input as HTMLInputElement).value).toBe('');
    expect(screen.queryByText('3/20')).toBeNull();
    expect(document.activeElement).toBe(input);
  });

  it('Esc 清空并失焦，并调用 onEscape', async () => {
    const onEscape = vi.fn();
    render(<Harness matchCount={1} matchTotal={2} onEscape={onEscape} />);

    const input = screen.getByRole('searchbox', { name: '搜索' }) as HTMLInputElement;
    input.focus();
    fireEvent.change(input, { target: { value: 'bar' } });
    expect(input.value).toBe('bar');

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input.value).toBe('');
    expect(document.activeElement).not.toBe(input);
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it('IME 合成期（isComposing=true）Esc 不清空、不触发 onEscape', () => {
    const onEscape = vi.fn();
    render(<Harness matchCount={1} matchTotal={2} onEscape={onEscape} />);

    const input = screen.getByRole('searchbox', { name: '搜索' }) as HTMLInputElement;
    input.focus();
    fireEvent.change(input, { target: { value: 'ni' } });

    // 中文拼音合成期按 Esc 是「取消候选」，不是清空搜索
    fireEvent.keyDown(input, { key: 'Escape', isComposing: true });
    expect(input.value).toBe('ni');
    expect(onEscape).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(input);
  });

  it('非合成期（isComposing=false）Esc 行为不变', () => {
    const onEscape = vi.fn();
    render(<Harness matchCount={1} matchTotal={2} onEscape={onEscape} />);

    const input = screen.getByRole('searchbox', { name: '搜索' }) as HTMLInputElement;
    input.focus();
    fireEvent.change(input, { target: { value: 'bar' } });

    fireEvent.keyDown(input, { key: 'Escape', isComposing: false });
    expect(input.value).toBe('');
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it('未识别的透传 props（…rest）落到 input 上', () => {
    render(
      <SearchBar
        value=""
        onChange={() => {}}
        placeholder="搜索…"
        id="git-repo-search"
        title="仓库过滤"
      />
    );
    const input = screen.getByRole('searchbox') as HTMLInputElement;
    expect(input.id).toBe('git-repo-search');
    expect(input.title).toBe('仓库过滤');
    // aria-label 缺省逻辑不受影响
    expect(input.getAttribute('aria-label')).toBe('搜索…');
  });
});
