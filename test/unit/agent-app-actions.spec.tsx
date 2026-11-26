import { renderWithAppTips as render, findAppTip } from './helpers/app-tips';
import React, { useState } from 'react';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { AppDataView } from '../../src/renderer/src/agentApps/AppDataView';
import { builtInAgentApps } from '../../src/shared/agentAppsBuiltins';
import type { AppRecord } from '../../src/shared/agentApps';
import type { PhoneRoute } from '../../src/renderer/src/agentApps/presentation';
import { currentApiMock } from './helpers/api-mock';

function Harness({ appId }: { appId: string }) {
  const app = builtInAgentApps().find(a => a.id === appId)!;
  const [route, navigate] = useState<PhoneRoute>({ appId, viewId: app.homeView, entityId: 'item' });
  return <AppDataView workspaceId="one" app={app} view={app.views[0]} route={route} navigate={navigate} connections={[]} search="" revision={0} scrollPositions={new Map()}/>;
}
function recordMock(values: AppRecord['values']) {
  let record: AppRecord | undefined = { id: 'item', collection: 'items', revision: 1, createdAt: 1, updatedAt: 1, values };
  currentApiMock().override('agentApps.query', async (_ws, query) => query.id ? { record } : { records: record ? [record] : [], total: record ? 1 : 0 });
  currentApiMock().override('agentApps.call', async (_ws, input) => {
    if (input.commandId === 'remove') { record = undefined; return { removed: true }; }
    record = { ...record!, revision: record!.revision + 1, values: { ...record!.values, ...(input.commandId === 'cancel' ? { enabled: false } : input.commandId === 'complete' ? { done: true } : { done: false }) } };
    return { record };
  });
}
const icon = (name: string) => screen.getByRole('button', { name }).querySelector('[data-phone-icon]')?.getAttribute('data-phone-icon');

describe('phone app action semantics', () => {
  it('提醒可取消后保留记录，也可删除；两者具有不同图标并携带最新版本', async () => {
    recordMock({ title: '检查运行结果', dueAt: '2027-01-01T09:00:00Z', enabled: true });
    render(<Harness appId="reminders"/>);
    await screen.findByRole('heading', { name: '检查运行结果' });
    expect(icon('取消提醒')).toBe('reminder-off');
    expect(icon('删除')).toBe('delete');
    expect(icon('编辑提醒')).toBe('edit');
    fireEvent.click(screen.getByRole('button', { name: '取消提醒' }));
    await screen.findByText('已停用');
    expect(screen.queryByRole('button', { name: '取消提醒' })).toBeNull();
    expect(screen.getByRole('heading', { name: '检查运行结果' })).toBeTruthy();
    expect(icon('重新设置')).toBe('clock');
    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    await screen.findByText('这里还没有内容');
    expect(screen.queryByRole('heading', { name: '检查运行结果' })).toBeNull();
    expect(currentApiMock().mockOf('agentApps.call').mock.calls.map(call => call[1])).toEqual([
      expect.objectContaining({ commandId: 'cancel', params: { id: 'item', expectedRevision: 1 } }),
      expect.objectContaining({ commandId: 'remove', params: { id: 'item', expectedRevision: 2 } }),
    ]);
  });
  it('删除失败保留详情和可重试入口', async () => {
    recordMock({ title: '暂不能删除', dueAt: '2027-01-01T09:00:00Z', enabled: true });
    currentApiMock().override('agentApps.call', async () => { throw new Error('记录已更新，请重试'); });
    render(<Harness appId="reminders"/>);
    fireEvent.click(await screen.findByRole('button', { name: '删除' }));
    expect((await findAppTip()).textContent).toContain('记录已更新，请重试');
    expect(screen.getByRole('heading', { name: '暂不能删除' })).toBeTruthy();
    await waitFor(() => expect((screen.getByRole('button', { name: '删除' }) as HTMLButtonElement).disabled).toBe(false));
  });
  it('待办只显示当前可执行的完成或恢复，恢复使用撤回图标', async () => {
    recordMock({ title: '核对数据' });
    render(<Harness appId="tasks"/>);
    await screen.findByRole('heading', { name: '核对数据' });
    expect(icon('完成')).toBe('check');
    expect(screen.queryByRole('button', { name: '恢复' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '完成' }));
    await screen.findByRole('button', { name: '恢复' });
    expect(screen.queryByRole('button', { name: '完成' })).toBeNull();
    expect(icon('恢复')).toBe('undo');
    fireEvent.click(screen.getByRole('button', { name: '恢复' }));
    await screen.findByRole('button', { name: '完成' });
    expect(screen.queryByRole('button', { name: '恢复' })).toBeNull();
  });
  it('提醒表单没有无效启用开关，保存和取消有专用图标，取消不写数据', async () => {
    recordMock({ title: '检查运行结果', dueAt: '2027-01-01T09:00:00Z', enabled: true });
    render(<Harness appId="reminders"/>);
    fireEvent.click(await screen.findByRole('button', { name: '编辑提醒' }));
    expect(screen.queryByRole('checkbox', { name: '启用' })).toBeNull();
    expect(icon('保存')).toBe('save');
    expect(icon('取消')).toBe('close');
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(await screen.findByRole('button', { name: '取消提醒' })).toBeTruthy();
    expect(currentApiMock().mockOf('agentApps.call')).not.toHaveBeenCalled();
  });
  it('每日提醒显示当地时间，修改每日时间时由宿主重新计算下次发生时间', async () => {
    recordMock({ title: '提醒用户打卡', dueAt: '2027-01-01T01:00:00Z', dailyTime: '09:00', enabled: true });
    render(<Harness appId="reminders"/>);
    expect(await screen.findByText('每天 09:00')).toBeTruthy();
    expect(screen.queryByText('单次提醒')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '编辑提醒' }));
    fireEvent.change(screen.getByLabelText('重复时间（HH:mm）'), { target: { value: '10:00' } });
    const due = screen.getByLabelText('提醒时间') as HTMLInputElement;
    expect(due.required).toBe(false);
    expect(due.value).toBe('');
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(currentApiMock().mockOf('agentApps.call')).toHaveBeenCalledWith('one', expect.objectContaining({ commandId: 'set', params: expect.objectContaining({ values: expect.objectContaining({ dailyTime: '10:00' }) }) })));
    const call = currentApiMock().mockOf('agentApps.call').mock.calls.at(-1)![1];
    expect(call.params.values.dueAt).toBeUndefined();
  });
  it('每周提醒显示星期，编辑星期后交由宿主重新计算时间', async () => {
    recordMock({ title: '周提醒', dueAt: '2027-01-01T01:00:00Z', dailyTime: '09:00', weekdays: '1,3', enabled: true });
    render(<Harness appId="reminders"/>);
    expect(await screen.findByText('每周 1,3 · 09:00')).toBeTruthy();
    expect(screen.queryByText('每周星期（0=日，1=一，…6=六，逗号分隔）')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '编辑提醒' }));
    fireEvent.change(screen.getByLabelText('每周星期（0=日，1=一，…6=六，逗号分隔）'), { target: { value: '2,4' } });
    expect((screen.getByLabelText('提醒时间') as HTMLInputElement).value).toBe('');
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(currentApiMock().mockOf('agentApps.call')).toHaveBeenCalledWith('one', expect.objectContaining({ commandId: 'set', params: expect.objectContaining({ values: expect.objectContaining({ weekdays: '2,4' }) }) })));
    expect(currentApiMock().mockOf('agentApps.call').mock.calls.at(-1)![1].params.values.dueAt).toBeUndefined();
  });
});
