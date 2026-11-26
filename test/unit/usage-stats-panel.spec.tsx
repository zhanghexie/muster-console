import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StoreProvider } from '../../src/renderer/src/store';
import { UsageStatsPanel } from '../../src/renderer/src/components/UsageStatsPanel';
import { emptyUsageDay, usageDayKey, type UsageSummary } from '../../src/shared/usageStats';
import { currentApiMock } from './helpers/api-mock';
import { applyLocaleSetting } from '../../src/shared/i18n';

function summary(): UsageSummary {
  const today = usageDayKey(Date.now());
  const day = emptyUsageDay();
  day.agentSessions = 8;
  day.activeSessions = { old: { name: '持续使用的旧会话', runtime: 'pi', workspaceId: 'w', lastActiveAt: Date.now() } };
  day.toolCalls = { 'fs.read': 4 }; day.toolErrors = { 'fs.read': 2 };
  return { generatedAt: Date.now(), todayKey: today, fromKey: today, toKey: today,
    rangeDays: [{ date: today, day }], rangeTotal: day, prevTotal: emptyUsageDay(),
    headlessRuns: [], headlessTotal: 0, headlessRunningTotal: 0, headlessByTask: [],
    llmCalls: [], llmCallsTotal: 0, llmByExt: [], toolFailures: [
      { id: 'f1', name: 'fs.read', at: Date.now(), error: '文件不存在：src/missing.ts', cancelled: false },
      { id: 'f2', name: 'fs.read', at: Date.now(), error: '用户取消操作', cancelled: true }
    ] };
}
async function mount(value = summary()) {
  currentApiMock().override('usage.summary', () => value);
  const result = render(<StoreProvider><UsageStatsPanel /></StoreProvider>);
  await waitFor(() => expect(result.container.querySelectorAll('button.usage-card')).toHaveLength(4));
  return result;
}
describe('使用统计手动下钻', () => {
  it('移除退役入口，活跃数来自实际活动而非新建数，并展示会话来源', async () => {
    const app = await mount();
    expect(app.container.textContent).not.toContain('无头');
    const cards = app.container.querySelectorAll('button.usage-card');
    expect(cards[1].querySelector('.usage-card-value')?.textContent ?? cards[1].textContent).toContain('1');
    fireEvent.click(screen.getByRole('tab', { name: '活跃会话' }));
    expect(screen.getByText('持续使用的旧会话')).toBeTruthy();
    expect(screen.getByText(/旧数据无法回填/)).toBeTruthy();
  });
  it('translates only the host scheduler label while preserving names and saved statistics', async () => {
    const value = summary(), active = value.rangeTotal.activeSessions!;
    active['scheduler:w'] = { name: '调度 Agent', runtime: 'scheduler', workspaceId: 'w', lastActiveAt: Date.now() };
    active.custom = { name: '调度 Agent', runtime: 'pi', workspaceId: 'w', lastActiveAt: Date.now() };
    active['scheduler:x'] = { name: '用户命名', runtime: 'scheduler', workspaceId: 'x', lastActiveAt: Date.now() };
    const original = structuredClone(active);
    const view = await mount(value);
    fireEvent.click(screen.getByRole('tab', { name: '活跃会话' }));
    expect(screen.getAllByText('调度 Agent')).toHaveLength(2);
    try {
      act(() => { applyLocaleSetting('en'); });
      expect(await screen.findByText('Dispatcher Agent')).toBeTruthy();
      expect(screen.getByText('调度 Agent')).toBeTruthy();
      expect(screen.getByText('用户命名')).toBeTruthy();
      expect(active).toEqual(original);
    } finally { view.unmount(); act(() => { applyLocaleSetting('zh-CN'); }); }
  });
  it('等待超过旧轮播间隔后仍保持默认页签，手动选择后刷新也不跳转', async () => {
    vi.useFakeTimers();
    try {
      currentApiMock().override('usage.summary', () => summary());
      let app!: ReturnType<typeof render>;
      await act(async () => { app = render(<StoreProvider><UsageStatsPanel /></StoreProvider>); });
      expect(app.container.querySelectorAll('button.usage-card')).toHaveLength(4);
      await act(async () => { vi.advanceTimersByTime(9000); });
      expect(screen.getByRole('tab', { name: '新建会话' }).getAttribute('aria-selected')).toBe('true');
      fireEvent.click(screen.getByRole('tab', { name: '活跃会话' }));
      await act(async () => { vi.advanceTimersByTime(16000); });
      expect(screen.getByRole('tab', { name: '活跃会话' }).getAttribute('aria-selected')).toBe('true');
      expect(app.container.textContent).not.toContain('自动轮播');
    } finally { vi.useRealTimers(); }
  });
  it('失败焦点展示错误文本与取消状态，历史计数没有详情时明确提示', async () => {
    const app = await mount();
    fireEvent.click(screen.getByRole('tab', { name: '能力调用' }));
    fireEvent.click(screen.getByRole('tab', { name: '失败焦点' }));
    expect(screen.getByText('文件不存在：src/missing.ts')).toBeTruthy();
    expect(screen.getByText('已取消')).toBeTruthy();
    app.unmount();
    await mount({ ...summary(), toolFailures: [] });
    fireEvent.click(screen.getByRole('tab', { name: '能力调用' }));
    fireEvent.click(screen.getByRole('tab', { name: '失败焦点' }));
    expect(screen.getByText(/历史计数不受影响/)).toBeTruthy();
  });
  it('translates host fallback failure details without changing stored or external diagnostics', async () => {
    const value = summary();
    value.toolFailures = [
      { id: 'cancel', name: 'fs.read', at: Date.now(), error: '已取消', cancelled: true },
      { id: 'missing', name: 'fs.read', at: Date.now(), error: '调用失败，未提供原因', cancelled: false },
      { id: 'custom', name: 'fs.read', at: Date.now(), error: '用户原始错误', cancelled: false }
    ];
    const original = structuredClone(value.toolFailures);
    const app = await mount(value);
    fireEvent.click(screen.getByRole('tab', { name: '能力调用' }));
    fireEvent.click(screen.getByRole('tab', { name: '失败焦点' }));
    try {
      act(() => { applyLocaleSetting('en'); });
      expect(screen.getByText('The call failed without a reason.')).toBeTruthy();
      expect(screen.getByText('用户原始错误')).toBeTruthy();
      expect(app.container.querySelector('.usage-failure-error')?.textContent).toBe('Cancelled');
      expect(value.toolFailures).toEqual(original);
    } finally { app.unmount(); act(() => { applyLocaleSetting('zh-CN'); }); }
  });
  it('失败详情先显示50条，点击加载更多；切换日期重置分页', async () => {
    const value = summary();
    value.toolFailures = Array.from({ length: 51 }, (_, i) => ({
      id: `f${i}`, name: 'fs.read', at: Date.now(), error: `错误详情${i}`, cancelled: false
    }));
    await mount(value);
    fireEvent.click(screen.getByRole('tab', { name: '能力调用' }));
    fireEvent.click(screen.getByRole('tab', { name: '失败焦点' }));
    expect(screen.queryByText('错误详情50')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '加载更多失败详情' }));
    expect(screen.getByText('错误详情50')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '加载更多失败详情' })).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: '近 7 天' }));
    await waitFor(() => expect(currentApiMock().mockOf('usage.summary')).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('错误详情50')).toBeNull();
    expect(screen.getByRole('tab', { name: '能力调用' }).getAttribute('aria-selected')).toBe('true');
  });

});
