/**
 * GitChangeTree 多选交互：
 * - 修饰键点击只改选区（不看 Diff）；普通点击保持查看 Diff 行为
 * - 右键/双击落在多选区内 → 作用于整选区（目录展开为其全部文件路径）
 */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitFileChange } from '../../src/shared/types';
import { GitChangeTree, type GitChangeContextTarget } from '../../src/renderer/src/panels/GitChangeTree';

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

function makeFiles(): GitFileChange[] {
  return [
    { path: 'src/a.ts', index: 'M', working_dir: 'M' },
    { path: 'src/b.ts', index: 'M', working_dir: ' ' },
    { path: 'd/x.ts', index: '?', working_dir: '?' }
  ];
}

function renderTree(handlers: {
  onSelectFile?: ReturnType<typeof vi.fn>;
  onTogglePaths?: ReturnType<typeof vi.fn>;
  onContextMenu?: ReturnType<typeof vi.fn>;
}): void {
  render(
    <GitChangeTree
      files={makeFiles()}
      zone="unstaged"
      selectedFile={null}
      activeZone
      busy={false}
      badgeOf={() => 'M'}
      onSelectFile={handlers.onSelectFile ?? vi.fn()}
      onTogglePaths={handlers.onTogglePaths ?? vi.fn()}
      onContextMenu={handlers.onContextMenu as (e: React.MouseEvent, t: GitChangeContextTarget) => void}
    />
  );
}

function row(path: string): HTMLElement {
  const rows = Array.from(document.querySelectorAll<HTMLElement>('.file-tree-row'));
  const hit = rows.find((r) => r.title.startsWith(`${path}\n`));
  if (!hit) throw new Error(`row not found: ${path}`);
  return hit;
}

describe('GitChangeTree 多选', () => {
  it('Ctrl+点击切换选区且不触发查看 Diff；普通点击保持原行为', async () => {
    const onSelectFile = vi.fn();
    renderTree({ onSelectFile });
    const a = row('src/a.ts');
    const b = row('src/b.ts');

    fireEvent.click(a, { ctrlKey: true });
    fireEvent.click(b, { ctrlKey: true });
    expect(a.className).toContain('is-multiselected');
    expect(b.className).toContain('is-multiselected');
    expect(onSelectFile).not.toHaveBeenCalled();

    fireEvent.click(a);
    expect(onSelectFile).toHaveBeenCalledTimes(1);
    expect(a.className).not.toContain('is-multiselected');
  });

  it('右键落在多选区内 → target.paths 聚合整选区', () => {
    const onContextMenu = vi.fn();
    renderTree({ onContextMenu });
    fireEvent.click(row('src/a.ts'), { ctrlKey: true });
    fireEvent.click(row('src/b.ts'), { ctrlKey: true });

    fireEvent.contextMenu(row('src/a.ts'));
    expect(onContextMenu).toHaveBeenCalledTimes(1);
    const target = onContextMenu.mock.calls[0]![1] as GitChangeContextTarget;
    expect(new Set(target.paths)).toEqual(new Set(['src/a.ts', 'src/b.ts']));
    expect(target.zone).toBe('unstaged');
  });

  it('双击落在多选区内 → onTogglePaths 作用于整选区（目录展开为文件）', () => {
    const onTogglePaths = vi.fn();
    renderTree({ onTogglePaths });
    fireEvent.click(row('d'), { ctrlKey: true });
    fireEvent.click(row('src/a.ts'), { ctrlKey: true });

    fireEvent.dblClick(row('d'));
    expect(onTogglePaths).toHaveBeenCalledTimes(1);
    expect(new Set(onTogglePaths.mock.calls[0]![0])).toEqual(new Set(['d/x.ts', 'src/a.ts']));
  });

  it('右键在选区外的行 → 维持单行 paths（现状语义）', () => {
    const onContextMenu = vi.fn();
    renderTree({ onContextMenu });
    fireEvent.click(row('src/a.ts'), { ctrlKey: true });

    fireEvent.contextMenu(row('src/b.ts'));
    const target = onContextMenu.mock.calls[0]![1] as GitChangeContextTarget;
    expect(target.paths).toEqual(['src/b.ts']);
  });
});
