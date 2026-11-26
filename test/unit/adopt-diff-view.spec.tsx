/**
 * AdoptDiffView（T5.5 部分采纳勾选视图）组件级测试：
 * - hunk 勾选 → onToggleHunk 回调携带与主进程同源的四元组键（file/oldStart/oldLines/newStart/newLines）
 * - 文件级全选 → onToggleFile 回调携带该文件全部 hunk 键
 * - selectedIds 回显勾选态；空 diff / 非法 diff 的降级渲染
 * hunk 键格式与 src/shared/gitAdopt.ts 的 adoptHunkKeyId 严格一致（与主进程 filterPatchByHunks 的匹配合同）。
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AdoptDiffView } from '../../src/renderer/src/panels/AdoptDiffView';
import { adoptHunkKeyId } from '../../src/shared/gitAdopt';
import type { GitAdoptHunkKey } from '../../src/shared/types';

const DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 111..222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,4 +1,4 @@',
  ' line1',
  '-old',
  '+new',
  ' line4',
  '@@ -10,3 +10,4 @@',
  ' ctx',
  '+added',
  'diff --git a/b.txt b/b.txt',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/b.txt',
  '@@ -0,0 +1,2 @@',
  '+b1',
  '+b2'
].join('\n');

function renderView(
  selectedIds: ReadonlySet<string>,
  onToggleHunk: (k: GitAdoptHunkKey, checked: boolean) => void,
  onToggleFile: (keys: GitAdoptHunkKey[], checked: boolean) => void
) {
  return render(
    <AdoptDiffView
      diffText={DIFF}
      selectedIds={selectedIds}
      onToggleHunk={onToggleHunk}
      onToggleFile={onToggleFile}
    />
  );
}

describe('AdoptDiffView hunk 勾选（T5.5）', () => {
  it('渲染两文件三 hunk：文件标题 + hunk 头勾选行', () => {
    renderView(new Set(), () => {}, () => {});
    expect(screen.getByText('src/a.ts')).toBeTruthy();
    expect(screen.getByText('b.txt')).toBeTruthy();
    // 两个 hunk 头行 + 一个新文件 hunk 头行
    expect(screen.getAllByText('@@ -1,4 +1,4 @@').length).toBe(1);
    expect(screen.getAllByText('@@ -10,3 +10,4 @@').length).toBe(1);
    expect(screen.getAllByText('@@ -0,0 +1,2 @@').length).toBe(1);
    expect(screen.getAllByRole('checkbox').length).toBe(5); // 2 文件级 + 3 hunk 级
  });

  it('勾选 hunk → onToggleHunk 携带主进程同源四元组键', async () => {
    const user = userEvent.setup();
    const seen: Array<[GitAdoptHunkKey, boolean]> = [];
    renderView(new Set(), (k, checked) => seen.push([k, checked]), () => {});
    await user.click(screen.getAllByText('@@ -10,3 +10,4 @@')[0]!.closest('label')!);
    expect(seen.length).toBe(1);
    const [k, checked] = seen[0]!;
    expect(checked).toBe(true);
    expect(k).toEqual({
      file: 'src/a.ts',
      oldStart: 10,
      oldLines: 3,
      newStart: 10,
      newLines: 4
    });
    expect(adoptHunkKeyId(k)).toBe('src/a.ts|10,3,10,4');
  });

  it('勾选状态由 selectedIds 回显（checked）', () => {
    const id = adoptHunkKeyId({
      file: 'src/a.ts',
      oldStart: 10,
      oldLines: 3,
      newStart: 10,
      newLines: 4
    });
    renderView(new Set([id]), () => {}, () => {});
    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    // hunk 级第三、四、五个 checkbox 中第一个命中（src/a.ts 第二个 hunk）
    const checkedBoxes = boxes.filter((b) => b.checked);
    expect(checkedBoxes.length).toBe(1);
  });

  it('文件级全选 → onToggleFile 携带该文件全部 hunk 键', async () => {
    const user = userEvent.setup();
    const seen: Array<[GitAdoptHunkKey[], boolean]> = [];
    renderView(new Set(), () => {}, (keys, checked) => seen.push([keys, checked]));
    await user.click(screen.getByText('src/a.ts').closest('label')!);
    expect(seen.length).toBe(1);
    const [keys, checked] = seen[0]!;
    expect(checked).toBe(true);
    expect(keys.map((k) => adoptHunkKeyId(k))).toEqual([
      'src/a.ts|1,4,1,4',
      'src/a.ts|10,3,10,4'
    ]);
  });

  it('全选回显：selectedIds 覆盖整文件时文件级 checkbox 勾上', () => {
    const ids = new Set([
      adoptHunkKeyId({ file: 'src/a.ts', oldStart: 1, oldLines: 4, newStart: 1, newLines: 4 }),
      adoptHunkKeyId({ file: 'src/a.ts', oldStart: 10, oldLines: 3, newStart: 10, newLines: 4 })
    ]);
    renderView(ids, () => {}, () => {});
    // src/a.ts 文件级 checkbox 应 checked（该文件两个 hunk 全选）
    const label = screen.getByText('src/a.ts').closest('label')!;
    const box = label.querySelector('input') as HTMLInputElement;
    expect(box.checked).toBe(true);
  });

  it('空 diff → 无差异；坏/零 hunk diff → 降级提示（不抛错）', () => {
    const { rerender } = render(
      <AdoptDiffView
        diffText=""
        selectedIds={new Set()}
        onToggleHunk={() => {}}
        onToggleFile={() => {}}
      />
    );
    expect(screen.getByText('无差异')).toBeTruthy();
    rerender(
      <AdoptDiffView
        diffText="garbage not a diff"
        selectedIds={new Set()}
        onToggleHunk={() => {}}
        onToggleFile={() => {}}
      />
    );
    // parseDiff 对无 @@ 头的输入返回零 hunk 文件段 → 可勾选空态二选一提示
    const empty =
      screen.queryByText('无法解析 diff') ??
      screen.getByText('没有可勾选的文本 hunk（二进制文件改动不可部分采纳）');
    expect(empty).toBeTruthy();
  });
});
