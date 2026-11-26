/**
 * Git 仓库搜索换皮后：防抖上抛、Esc 立即清空并关闭（行为与换皮前一致）。
 */
import React, { useRef } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import { GitRepoSearchInput } from '../../src/renderer/src/panels/GitRepoSearchInput';

function Harness({
  onQueryChange,
  onClose,
  matchCount = 1,
  matchTotal = 3
}: {
  onQueryChange: (q: string) => void;
  onClose: () => void;
  matchCount?: number;
  matchTotal?: number;
}): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement | null>(null);
  return (
    <GitRepoSearchInput
      inputRef={inputRef}
      onQueryChange={onQueryChange}
      onClose={onClose}
      matchCount={matchCount}
      matchTotal={matchTotal}
    />
  );
}

describe('Git 仓库搜索（SearchBar 换皮）', () => {
  it('击键防抖后才上抛查询，并显示计数', async () => {
    const user = userEvent.setup();
    const onQueryChange = vi.fn();
    const onClose = vi.fn();
    render(<Harness onQueryChange={onQueryChange} onClose={onClose} />);

    const input = screen.getByRole('searchbox', { name: '搜索仓库…' });
    await user.type(input, 'front');
    expect(onQueryChange).not.toHaveBeenCalledWith('front');
    await waitFor(() => {
      expect(onQueryChange).toHaveBeenLastCalledWith('front');
    });
    expect(screen.getByText('1/3')).toBeTruthy();
  });

  it('Esc 立即清空并关闭，不依赖防抖', async () => {
    const user = userEvent.setup();
    const onQueryChange = vi.fn();
    const onClose = vi.fn();
    render(<Harness onQueryChange={onQueryChange} onClose={onClose} />);

    const input = screen.getByRole('searchbox', { name: '搜索仓库…' }) as HTMLInputElement;
    await user.type(input, 'front');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input.value).toBe('');
    expect(onQueryChange).toHaveBeenCalledWith('');
    expect(onClose).toHaveBeenCalled();
  });
});
