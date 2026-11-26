import { renderWithAppTips as render, findAppTip } from './helpers/app-tips';
import React from 'react';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { CapabilityUsagePanel } from '../../src/renderer/src/components/settings/CapabilityUsagePanel';
import { resolveUsage, type UsagePolicy, type UsageListInput, type UsageSetInput, type UsageSnapshot } from '../../src/shared/capabilityUsage';
import { currentApiMock } from './helpers/api-mock';

let policy: UsagePolicy;
function snapshot(input: UsageListInput): UsageSnapshot {
  return { revision: policy.revision, runtimes: [{ id: 'custom', label: 'Custom' }],
    categories: { skill: resolveUsage(policy, 'skill', '*', input), mcp: resolveUsage(policy, 'mcp', '*', input) },
    resources: ['one', 'two'].map(id => ({ id, name: id, kind: input.kind ?? 'skill', state: resolveUsage(policy, input.kind ?? 'skill', id, input), externalDiscovery: true })) };
}
beforeEach(() => {
  policy = { revision: 0, disabled: [] };
  currentApiMock().override('capabilityManagement.usageList', snapshot);
  currentApiMock().override('capabilityManagement.usageSet', (input: UsageSetInput) => {
    policy = { revision: policy.revision + 1, disabled: input.enabled ? [] : input.resourceIds.map(resourceId => ({ scope: input.scope, kind: input.kind, resourceId })) };
  });
});
describe('shared capability usage controls', () => {
  it('writes workspace restriction for inherited resources and displays server readback', async () => {
    render(<CapabilityUsagePanel kind="skill" resourceId="one" workspaceId="w1"/>);
    fireEvent.click(await screen.findByRole('checkbox', { name: '允许使用 one' }));
    await waitFor(() => expect(currentApiMock().mockOf('capabilityManagement.usageSet')).toHaveBeenCalledWith({ kind: 'skill', scope: { kind: 'workspace', workspaceId: 'w1' }, resourceIds: ['one'], enabled: false, expectedRevision: 0 }));
    expect(await screen.findByText('已关闭 · 当前工作区')).toBeTruthy();
    expect((screen.getByRole('checkbox', { name: '允许使用 one' }) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '恢复本层允许' }));
    await waitFor(() => expect((screen.getByRole('checkbox', { name: '允许使用 one' }) as HTMLInputElement).checked).toBe(true));
  });
  it('cannot override global denial from harness and links to its origin', async () => {
    policy.disabled = [{ scope: { kind: 'global' }, kind: 'mcp', resourceId: 'one' }];
    render(<CapabilityUsagePanel kind="mcp" resourceId="one" runtimeId="custom"/>);
    expect((await screen.findByRole('checkbox', { name: '允许使用 one' }) as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '查看全局设置' }));
    await waitFor(() => expect((screen.getByRole('checkbox', { name: '允许使用 one' }) as HTMLInputElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('checkbox', { name: '允许使用 one' }));
    await waitFor(() => expect(currentApiMock().mockOf('capabilityManagement.usageSet')).toHaveBeenCalledWith(expect.objectContaining({ scope: { kind: 'global' }, enabled: true })));
  });
  it('shows category blocker and prevents an ineffective individual enable', async () => {
    policy.disabled = [{ scope: { kind: 'global' }, kind: 'skill', resourceId: '*' }];
    render(<CapabilityUsagePanel kind="skill" resourceId="one"/>);
    expect((await screen.findByRole('checkbox', { name: '允许使用 one' }) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('checkbox', { name: '允许使用 Skills 总开关' }) as HTMLInputElement).disabled).toBe(false);
  });
  it('bulk edits one harness with one revision and discloses external discovery limits', async () => {
    render(<CapabilityUsagePanel kind="skill" runtimeId="custom"/>);
    fireEvent.click(await screen.findByRole('button', { name: '批量管理' }));
    fireEvent.click(await screen.findByRole('checkbox', { name: '选择 one' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '选择 two' }));
    fireEvent.click(screen.getByRole('button', { name: '批量关闭' }));
    await waitFor(() => expect(currentApiMock().mockOf('capabilityManagement.usageSet')).toHaveBeenCalledWith(expect.objectContaining({ scope: { kind: 'harness', runtimeId: 'custom' }, resourceIds: ['one', 'two'], expectedRevision: 0 })));
    expect(screen.getByText(/外部 CLI 仍可能读取原生目录/)).toBeTruthy();
  });
  it('failed writes retain real state and expose retry instead of optimistic success', async () => {
    currentApiMock().override('capabilityManagement.usageSet', () => { throw new Error('disk full'); });
    render(<CapabilityUsagePanel kind="mcp" resourceId="one"/>);
    fireEvent.click(await screen.findByRole('checkbox', { name: '允许使用 one' }));
    expect((await findAppTip()).textContent).toContain('disk full');
    expect((screen.getByRole('checkbox', { name: '允许使用 one' }) as HTMLInputElement).checked).toBe(true);
  });
  it('ignores stale reads on workspace switches and does not fetch hidden worker details', async () => {
    let finish!: (value: UsageSnapshot) => void;
    currentApiMock().override('capabilityManagement.usageList', (input: UsageListInput) => input.workspaceId === 'w1' ? new Promise(resolve => { finish = resolve; }) : snapshot(input));
    const view = render(<CapabilityUsagePanel kind="mcp" workspaceId="w1"/>);
    view.rerender(<CapabilityUsagePanel kind="mcp" workspaceId="w2"/>);
    await screen.findByRole('checkbox', { name: '允许使用 one' });
    await act(async () => finish({ ...snapshot({}), resources: [] }));
    expect(screen.getByRole('checkbox', { name: '允许使用 one' })).toBeTruthy();
    const count = currentApiMock().mockOf('capabilityManagement.usageList').mock.calls.length;
    view.rerender(<CapabilityUsagePanel kind="mcp" workspaceId="w3" active={false}/>);
    await act(async () => {});
    expect(currentApiMock().mockOf('capabilityManagement.usageList')).toHaveBeenCalledTimes(count);
  });
});
