/**
 * 中栏工具面板切换：层不涂底（透出页的玻璃底），A→B 时被换下的旧层必须淡出（stage=out），
 * 否则会与新层内容叠印。
 * 退场的旧层必须是原实例（keyed 层列表），不能在别处重新 render 一份——否则旧面板状态重置、
 * 扩展 iframe 整页重载；退场中切回应原地回弹。
 * 自查：旧层恢复「保持 in 不淡出」或恢复「旁路 renderUtility(retiring.sel) 重挂载」时本用例应红。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import React from 'react';
import { act, render, waitFor, fireEvent } from '@testing-library/react';
import { beforeEach, afterEach, vi } from 'vitest';
import { StoreProvider } from '../../src/renderer/src/store';
import { CenterPanel } from '../../src/renderer/src/panels/CenterPanel';
import type { UtilitySelection } from '../../src/renderer/src/panels/LeftPanel';

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => vi.unstubAllGlobals());

vi.mock('../../src/renderer/src/components/TerminalView', () => ({
  TerminalView: () => null
}));


const usageMounts = vi.hoisted(() => ({ count: 0 }));
const workbenchMounts = vi.hoisted(() => ({ count: 0 }));
vi.mock('../../src/renderer/src/panels/WorkbenchNavigationPanel', async () => {
  const { useEffect, useState } = await import('react');
  return { WorkbenchNavigationPanel: () => { const [draft, setDraft] = useState(''); useEffect(() => { workbenchMounts.count++; }, []); return <input data-testid="workbench-draft" value={draft} onChange={event => setDraft(event.target.value)} />; } };
});

vi.mock('../../src/renderer/src/components/UsageStatsPanel', async () => {
  const { useEffect } = await import('react');
  return {
    UsageStatsPanel: () => {
      useEffect(() => {
        usageMounts.count += 1;
      }, []);
      return <div data-testid="usage-panel" />;
    }
  };
});

vi.mock('../../src/renderer/src/components/PromptTaskPanel', () => ({
  PromptTaskPanel: () => <div data-testid="tasks-panel" />
}));

function Harness({ sel }: { sel: UtilitySelection | null }): React.JSX.Element {
  return (
    <StoreProvider>
      <CenterPanel utilityPanel={sel} onCloseUtilityPanel={() => {}} />
    </StoreProvider>
  );
}
async function mount(sel: UtilitySelection): Promise<ReturnType<typeof render>> {
  let result!: ReturnType<typeof render>;
  await act(async () => { result = render(<Harness sel={sel} />); });
  return result;
}

const layerOf = (testId: string): HTMLElement | null =>
  (document.querySelector(`[data-testid="${testId}"]`)?.closest('.center-utility-layer') as HTMLElement | null) ??
  null;

describe('中栏工具面板交叉淡切', () => {
  it('导航工作面板在退出动画完成后保活，切回保留同一 DOM 和草稿', async () => {
    workbenchMounts.count = 0;
    const { rerender } = await mount('nav:example');
    const input = document.querySelector<HTMLInputElement>('[data-testid="workbench-draft"]')!;
    fireEvent.change(input, { target: { value: '未提交草稿' } });
    rerender(<Harness sel="tasks" />);
    await waitFor(() => expect(layerOf('workbench-draft')?.style.display).toBe('none'));
    expect(layerOf('workbench-draft')?.hasAttribute('inert')).toBe(true);
    rerender(<Harness sel="nav:example" />);
    await waitFor(() => expect(layerOf('workbench-draft')?.dataset.mpStage).toBe('in'));
    expect(document.querySelector('[data-testid="workbench-draft"]')).toBe(input);
    expect(input.value).toBe('未提交草稿'); expect(workbenchMounts.count).toBe(1);
  });
  it('A→B：旧层转 out 淡出，新层在其上入场', async () => {
    const { rerender } = await mount('usage');
    await waitFor(() => expect(layerOf('usage-panel')?.dataset.mpStage).toBe('in'));

    rerender(<Harness sel="tasks" />);
    expect(layerOf('tasks-panel')).toBeTruthy();
    await waitFor(() => expect(layerOf('usage-panel')?.dataset.mpStage).toBe('out'));
    expect(layerOf('tasks-panel')?.dataset.mpStage).not.toBe('out');
    await waitFor(() => expect(layerOf('usage-panel')).toBeNull());
  });

  it('A→B：退场的旧面板是原实例（不重新挂载），退场中切回 A 原地回弹到 in', async () => {
    usageMounts.count = 0;
    const { rerender } = await mount('usage');
    await waitFor(() => expect(layerOf('usage-panel')?.dataset.mpStage).toBe('in'));
    expect(usageMounts.count).toBe(1);
    const usageLayer = layerOf('usage-panel');

    rerender(<Harness sel="tasks" />);
    await waitFor(() => expect(layerOf('usage-panel')?.dataset.mpStage).toBe('out'));
    expect(usageMounts.count).toBe(1);
    expect(layerOf('usage-panel')).toBe(usageLayer);

    rerender(<Harness sel="usage" />);
    await waitFor(() => expect(layerOf('usage-panel')?.dataset.mpStage).toBe('in'));
    expect(layerOf('usage-panel')).toBe(usageLayer);
    expect(usageMounts.count).toBe(1);
    await waitFor(() => expect(layerOf('tasks-panel')).toBeNull());
    expect(layerOf('usage-panel')?.dataset.mpStage).toBe('in');
  });

  it('base.css：换下的层走 --dur-micro 快速淡出，有退场层时新层延迟入场（先出后入）', () => {
    const css = readFileSync(
      resolve(__dirname, '../../src/renderer/src/styles/base.css'),
      'utf8'
    );
    expect(css).toMatch(
      /\.center-utility-layer\.mp-panel\[data-mp-stage='out'\]\s*\{[^}]*var\(--dur-micro\)/
    );
    expect(css).toMatch(
      /\.center-panel:has\(> \.center-utility-layer\[data-mp-stage='out'\]\)\s*>\s*\.center-utility-layer\.mp-panel\[data-mp-stage='in'\]\s*\{[^}]*transition-delay:\s*calc\(var\(--dur-micro\) \/ 2\)/
    );
  });

  it('A→null：旧层淡出后卸载', async () => {
    const { rerender } = await mount('usage');
    await waitFor(() => expect(layerOf('usage-panel')).toBeTruthy());
    rerender(<Harness sel={null} />);
    await waitFor(() => expect(layerOf('usage-panel')?.dataset.mpStage).toBe('out'));
    await waitFor(() => expect(layerOf('usage-panel')).toBeNull());
  });
});
