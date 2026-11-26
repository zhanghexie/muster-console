import React from 'react';
import { act, fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CapabilityCatalog } from '../../src/renderer/src/components/settings/CapabilityCatalog';
import { closeTopOverlay } from '../../src/renderer/src/keybindings/overlayStack';
import type { CatalogToolInfo } from '../../src/shared/types';
import { currentApiMock } from './helpers/api-mock';

const tools: CatalogToolInfo[] = [
  { name: 'sessions.delete', description: '永久删除已归档会话', summary: '删除会话', dangerous: true, parameters: {}, schedulerVisible: true },
  { name: 'sessions.requestIntegrate', description: '请求合入', dangerous: false, parameters: {}, schedulerVisible: false, workerVisible: true },
  { name: 'automations.list', description: '查看自动任务', dangerous: false, parameters: {}, schedulerVisible: true },
  { name: 'sessions.select', description: '聚焦会话', dangerous: false, parameters: {}, schedulerVisible: true, extensionVisible: true },
  { name: 'sessions.observe', description: '观察会话', dangerous: false, parameters: {}, schedulerVisible: true, workerVisible: true }
];

describe('应用能力目录', () => {
  const routed: CatalogToolInfo[] = [
    { name: 'browser.run', description: 'Browser domain', dangerous: false, parameters: {}, exposure: { kind: 'domain', scheduler: true, workerPresets: ['gui-full'], entry: 'browser.run', skillPath: '~/.muster/skills/browser/SKILL.md', actions: [{ action: 'click', target: 'browser.click' }] } },
    { name: 'browser.click', description: 'Click a page element', dangerous: false, parameters: {}, exposure: { kind: 'action', scheduler: true, workerPresets: ['gui-full'], entry: 'browser.run', action: 'click' } },
    { name: 'workflow.start', description: 'Start a workflow', dangerous: false, parameters: {}, exposure: { kind: 'action', scheduler: true, workerPresets: [], entry: 'workflow.run', action: 'start' } }
  ];
  it('opens the resolved local skill document without altering the declared path', async () => {
    const first = routed[0];
    const catalog = [{ ...first, exposure: { ...first.exposure!, resolvedSkillPath: '/home/me/.muster/skills/browser/SKILL.md' } }];
    const api = currentApiMock(); api.override('shell.revealPath', async () => ({ ok: true }));
    render(<CapabilityCatalog tools={catalog}/>);
    await userEvent.click(screen.getByRole('button', { name: '查看 browser.run' }));
    const panel = screen.getByRole('complementary', { name: '工具详情' });
    expect((within(panel).getByRole('textbox', { name: '用法文档' }) as HTMLInputElement).value).toBe('/home/me/.muster/skills/browser/SKILL.md');
    await userEvent.click(within(panel).getByRole('button', { name: '打开用法文档的位置' }));
    expect(api.mockOf('shell.revealPath')).toHaveBeenCalledWith('/home/me/.muster/skills/browser/SKILL.md');
    expect(first.exposure?.skillPath).toBe('~/.muster/skills/browser/SKILL.md');
  });
  it('keeps a path field in the narrow detail keyboard loop when its location is unresolved', async () => {
    render(<CapabilityCatalog tools={routed} narrow/>);
    fireEvent.click(screen.getByRole('button', { name: '查看 browser.run' }));
    const panel = screen.getByRole('complementary', { name: '工具详情' });
    const field = within(panel).getByRole('textbox', { name: '用法文档' });
    const close = within(panel).getByRole('button', { name: '关闭详情' });
    expect((within(panel).getByRole('button', { name: '打开用法文档的位置' }) as HTMLButtonElement).disabled).toBe(true);
    field.focus(); fireEvent.keyDown(field, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(field);
  });
  it('暴露筛选与使用方交集，计数和详情显示真实入口/action', async () => {
    const user = userEvent.setup();
    render(<CapabilityCatalog tools={routed}/>);
    await user.click(screen.getByRole('button', { name: '暴露方式' }));
    await user.click(await screen.findByRole('option', { name: '经域入口调用' }));
    expect(screen.queryByRole('button', { name: '查看 browser.run' })).toBeNull();
    expect(screen.getByText('2 个定义 · 0 个目录内原生入口')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '能力使用方' }));
    await user.click(await screen.findByRole('option', { name: 'Worker 可用' }));
    expect(screen.queryByRole('button', { name: '查看 workflow.start' })).toBeNull();
    await user.click(screen.getByRole('button', { name: '查看 browser.click' }));
    const panel = screen.getByRole('complementary', { name: '工具详情' });
    expect(within(panel).getByText('browser.run · action: click')).toBeTruthy();
    const row = screen.getByRole('button', { name: '查看 browser.click' });
    expect(row.querySelector('.settings-resource-name')?.textContent).toBe('browser.click');
    await user.click(row);
    expect(panel.inert).toBe(false);
    expect(within(panel).getByRole('heading', { name: 'browser.click' })).toBeTruthy();
    expect(screen.getByText('1 个定义 · 0 个目录内原生入口')).toBeTruthy();
  });
  it('窄屏复用详情实例，Escape 后解除 inert 并恢复列表位置和焦点', async () => {
    const user = userEvent.setup();
    const view = render(<CapabilityCatalog tools={routed} narrow/>);
    const row = screen.getByRole('button', { name: '查看 browser.run' });
    const list = view.container.querySelector('.cm-list-scroll')!;
    list.scrollTop = 84;
    await user.click(row);
    const panel = screen.getByRole('complementary', { name: '工具详情' });
    const inventory = view.container.querySelector('.cm-inventory') as HTMLElement;
    expect(inventory.inert).toBe(true);
    view.rerender(<CapabilityCatalog tools={routed} narrow={false}/>);
    expect(screen.getByRole('complementary', { name: '工具详情' })).toBe(panel);
    view.rerender(<CapabilityCatalog tools={routed} narrow/>);
    act(() => { closeTopOverlay(); });
    expect(panel.inert).toBe(true); expect(panel.getAttribute('aria-hidden')).toBe('true');
    expect(inventory.inert).toBe(true);
    await waitFor(() => expect(inventory.inert).toBe(false));
    expect(document.activeElement).toBe(row); expect(list.scrollTop).toBe(84);
    await user.click(row);
    expect(screen.getByRole('complementary', { name: '工具详情' })).toBeTruthy();
  });

  it('连续关闭再选择复用同一详情层，退场层不可交互', async () => {
    render(<CapabilityCatalog tools={routed}/>);
    fireEvent.click(screen.getByRole('button', { name: '查看 browser.run' }));
    const panel = screen.getByRole('complementary', { name: '工具详情' });
    expect(within(panel).queryByRole('button', { name: '关闭详情' })).toBeNull();
    expect(within(panel).queryByText('工具详情')).toBeNull();
    act(() => { closeTopOverlay(); });
    expect(panel.inert).toBe(true); expect(panel.getAttribute('aria-hidden')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: '查看 browser.click' }));
    expect(screen.getByRole('complementary', { name: '工具详情' })).toBe(panel);
    expect(panel.inert).toBe(false); expect(within(panel).getByRole('heading', { name: 'browser.click' })).toBeTruthy();
  });

  it('按实际角色筛选，隐藏项仍可在 Worker 或扩展视角发现', async () => {
    const user = userEvent.setup();
    render(<CapabilityCatalog tools={tools} />);
    expect(screen.getByText('sessions.requestIntegrate')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '能力使用方' }));
    await user.click(await screen.findByRole('option', { name: '调度可用' }));
    expect(screen.queryByText('sessions.requestIntegrate')).toBeNull();
    expect(screen.getByTitle('受确认策略约束')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '能力使用方' }));
    await user.click(await screen.findByRole('option', { name: 'Worker 可用' }));
    expect(screen.getByText('sessions.requestIntegrate')).toBeTruthy();
    expect(screen.queryByText('sessions.delete')).toBeNull();
    await user.click(screen.getByRole('button', { name: '能力使用方' }));
    await user.click(await screen.findByRole('option', { name: '扩展可用' }));
    expect(screen.getAllByText('sessions.select').length).toBeGreaterThan(0);
    expect(screen.queryByText('sessions.requestIntegrate')).toBeNull();
  });

  it('支持用途和规范名称搜索；点行开详情，空结果有空态', async () => {
    const user = userEvent.setup();
    render(<CapabilityCatalog tools={tools} />);
    expect(screen.getByRole('button', { name: '查看 automations.list' })).toBeTruthy();
    // 搜索规范名称
    await user.type(screen.getByLabelText('搜索能力'), 'sessions.delete');
    expect(screen.getAllByText('sessions.delete').length).toBeGreaterThan(0);
    expect(screen.queryByText(/兼容名：/)).toBeNull();
    // 搜索描述里的用途词
    await user.clear(screen.getByLabelText('搜索能力'));
    await user.type(screen.getByLabelText('搜索能力'), '观察会话');
    expect(screen.getByText('sessions.observe')).toBeTruthy();
    // 空结果空态
    await user.type(screen.getByLabelText('搜索能力'), '不存在');
    expect(screen.getByText('没有匹配的能力')).toBeTruthy();
    await user.clear(screen.getByLabelText('搜索能力'));
    // 点行 → 右侧详情（cm-detail），再点关闭
    await user.click(screen.getByRole('button', { name: /查看 sessions.delete/ }));
    expect(screen.getAllByText('sessions.delete').length).toBeGreaterThan(0);
    expect(screen.getByText('永久删除已归档会话')).toBeTruthy();
    expect(screen.getAllByText('受确认策略约束', { exact: false }).length).toBeGreaterThan(0);
    expect(screen.getByText('永久删除已归档会话')).toBeTruthy();
    act(() => { closeTopOverlay(); });
    await waitFor(() => expect(screen.getByText('选一项查看详情')).toBeTruthy());
  });
});
