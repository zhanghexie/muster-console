import { renderWithAppTips as render, findAppTip, getAppTip } from './helpers/app-tips';
import React from 'react';
import { act, fireEvent, renderHook, screen, waitFor, within } from '@testing-library/react';
import { AgentPhone } from '../../src/renderer/src/agentApps/AgentPhone';
import { useAgentPhone, PHONE_AUTO_KEY } from '../../src/renderer/src/agentApps/useAgentPhone';
import { AppPresentationController } from '../../src/renderer/src/agentApps/presentation';
import { builtInAgentApps } from '../../src/shared/agentAppsBuiltins';
import { photoAlbumExample } from '../../src/shared/agentAppsExamples';
import { CHANNEL_APP_ID, defineRecordApp, type AppOperation, type AppSnapshot } from '../../src/shared/agentApps';
import { currentApiMock } from './helpers/api-mock';
import { applyLocaleSetting } from '../../src/shared/i18n';
import { CustomAppView } from '../../src/renderer/src/agentApps/CustomAppView';
import { MOTION } from '../../src/renderer/src/components/motion';
import { localizeBuiltinApp } from '../../src/renderer/src/agentApps/appName';

const custom = defineRecordApp({ id: 'field-log', name: '观察记录', fields: [{ id: 'title', label: '标题', type: 'text', required: true }], titleField: 'title' });
const snapshot: AppSnapshot = { workspaceId: 'one', apps: [...builtInAgentApps(), custom].map(definition => ({ definition, enabled: true, installedAt: 1 })), operations: [], connections: [], errors: [] };
const operation = (overrides: Partial<AppOperation> = {}): AppOperation => ({ workspaceId: 'one', agentId: 'orchestrator:one', appId: 'field-log', commandId: 'create', title: '新增', operationId: 'op1', sequence: 1, runId: 'turn1', actor: 'agent', phase: 'succeeded', at: Date.now(), viewId: 'main', ...overrides });
function Harness({ workspaceId = 'one' }: { workspaceId?: string }) {
  const phone = useAgentPhone(workspaceId);
  return <><button onClick={() => phone.controller.open()}>打开手机应用</button><input aria-label="聊天输入"/><AgentPhone workspaceId={workspaceId} workspaceName="研究室" phone={phone}/></>;
}
beforeEach(() => {
  localStorage.removeItem(PHONE_AUTO_KEY);
  currentApiMock().override('agentApps.snapshot', async () => snapshot);
  currentApiMock().override('agentApps.query', async () => ({ records: [], total: 0 }));
});

describe('Agent phone production UI', () => {
  it('translates the unchanged example album while keeping edits and stored metadata intact', async () => {
    const album = photoAlbumExample();
    const edited = structuredClone(album);
    edited.collections[0].fields.find(field => field.id === 'note')!.label = '用户自定义备注';
    currentApiMock().override('agentApps.snapshot', async () => ({ ...snapshot, apps: [...snapshot.apps, { definition: edited, enabled: true, installedAt: 1 }] }));
    render(<Harness/>); fireEvent.click(screen.getByText('打开手机应用'));
    await screen.findByRole('button', { name: '相册' });
    try {
      act(() => { applyLocaleSetting('en'); });
      fireEvent.click(screen.getByRole('button', { name: 'Photo album' }));
      await screen.findByText('No entries yet');
      await act(async () => { fireEvent.click(await screen.findByRole('button', { name: 'Create' })); });
      expect(screen.getByLabelText('Name')).toBeTruthy();
      expect(screen.getByLabelText('用户自定义备注')).toBeTruthy();
      expect(edited.name).toBe('相册');
      expect(edited.collections[0].fields[0].label).toBe('名称');
      expect(localizeBuiltinApp(album).collections[0].fields.find(field => field.id === 'note')?.label).toBe('Notes');
    } finally { act(() => { applyLocaleSetting('zh-CN'); }); }
  });
  it('内置待办的操作与字段随语言切换，提交仍使用原始命令与用户数据', async () => {
    currentApiMock().override('agentApps.call', async () => ({ record: { id: 'saved', collection: 'items', revision: 1, createdAt: 1, updatedAt: 1, values: { title: '原始内容' } } }));
    render(<Harness/>); fireEvent.click(screen.getByText('打开手机应用'));
    await screen.findByRole('button', { name: '待办' });
    try {
      act(() => { applyLocaleSetting('en'); });
      fireEvent.click(screen.getByRole('button', { name: 'Todo' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Create' }));
      fireEvent.change(screen.getByRole('textbox', { name: 'What needs to be done' }), { target: { value: '原始内容' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(currentApiMock().mockOf('agentApps.call')).toHaveBeenCalledWith('one', expect.objectContaining({ appId: 'tasks', commandId: 'create', params: { values: { title: '原始内容' } } })));
      expect(snapshot.apps.find(item => item.definition.id === 'tasks')!.definition.collections[0].fields[0].label).toBe('要做什么');
    } finally { act(() => { applyLocaleSetting('zh-CN'); }); }
  });
  it('只翻译未修改的内置标签，邮件主题使用邮件语境', () => {
    const mail = structuredClone(builtInAgentApps().find(app => app.id === 'mail')!);
    mail.collections[0].fields.find(field => field.id === 'body')!.label = '用户自定义正文';
    try {
      act(() => { applyLocaleSetting('en'); });
      const display = localizeBuiltinApp(mail);
      expect(display.collections[0].fields.find(field => field.id === 'subject')!.label).toBe('Subject');
      expect(display.collections[0].fields.find(field => field.id === 'body')!.label).toBe('用户自定义正文');
      expect(mail.collections[0].fields.find(field => field.id === 'subject')!.label).toBe('主题');
    } finally { act(() => { applyLocaleSetting('zh-CN'); }); }
  });
  it('内置操作回执只翻译匹配命令的标题，错误详情保持原样', async () => {
    render(<Harness/>);
    try {
      act(() => { applyLocaleSetting('en'); });
      act(() => currentApiMock().emit('agentApps:operation', operation({ appId: 'tasks', commandId: 'create', title: '新增', viewId: 'main', phase: 'failed', error: '原始错误' })));
      expect((await findAppTip()).textContent).toContain('Create：原始错误');
    } finally { act(() => { applyLocaleSetting('zh-CN'); }); }
  });
  it('translates known operation errors on display without changing the event or remote detail', async () => {
    render(<Harness/>);
    const original = operation({ appId: 'tasks', commandId: 'create', title: '新增', viewId: 'main', phase: 'failed', error: '发送结果未确认，请核对远端后再决定是否重发：远端错误' });
    try {
      act(() => { applyLocaleSetting('en'); });
      act(() => currentApiMock().emit('agentApps:operation', original));
      expect((await findAppTip()).textContent).toContain('The send result was not confirmed. Check the remote status before deciding whether to resend: 远端错误');
      expect(original.error).toBe('发送结果未确认，请核对远端后再决定是否重发：远端错误');
    } finally { act(() => { applyLocaleSetting('zh-CN'); }); }
  });
  it('translates an interrupted operation recovery notice without rewriting the stored event', async () => {
    render(<Harness/>);
    const original = operation({ appId: 'tasks', commandId: 'create', title: '新增', viewId: 'main', phase: 'failed', error: '应用重启，执行结果需要核对' });
    try {
      act(() => { applyLocaleSetting('en'); });
      act(() => currentApiMock().emit('agentApps:operation', original));
      expect((await findAppTip()).textContent).toContain('The app restarted; check the operation result.');
      expect(original.error).toBe('应用重启，执行结果需要核对');
    } finally { act(() => { applyLocaleSetting('zh-CN'); }); }
  });
  it('自定义视图超时提示随语言切换，标准视图按钮仍可操作', () => {
    vi.useFakeTimers();
    const fallback = vi.fn();
    try {
      const view = { ...custom.views[0], kind: 'custom' as const, html: '<main>用户内容</main>' };
      render(<CustomAppView workspaceId="one" app={custom} view={view} revision={0} select={() => {}} interact={() => {}} fallback={fallback}/>);
      act(() => { vi.advanceTimersByTime(MOTION.breathMs * 3); });
      expect(getAppTip().textContent).toContain('自定义页面未完成展示接入');
      act(() => { applyLocaleSetting('en'); });
      expect(getAppTip().textContent).toContain('The custom page did not finish connecting');
      fireEvent.click(screen.getByRole('button', { name: 'Open standard view' }));
      expect(fallback).toHaveBeenCalledOnce();
    } finally { act(() => { applyLocaleSetting('zh-CN'); }); vi.useRealTimers(); }
  });

  it('自定义页面的宿主桥接错误随语言切换且不重建 iframe', () => {
    const view = { ...custom.views[0], kind: 'custom' as const, html: '<main>用户原始页面</main>' };
    const { container } = render(<CustomAppView workspaceId="one" app={custom} view={view} revision={0} select={() => {}} interact={() => {}} fallback={() => {}}/>);
    const frame = container.querySelector('iframe')!;
    const originalHtml = frame.getAttribute('srcdoc')!;
    const token = /const token="([^"]+)"/.exec(originalHtml)![1];
    const post = vi.spyOn(frame.contentWindow!, 'postMessage');
    try {
      act(() => { window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data: { phoneApp: token, type: 'ready' } })); });
      act(() => { applyLocaleSetting('en'); });
      expect(post).toHaveBeenCalledWith(expect.objectContaining({ phoneApp: token, type: 'locale', locale: 'en',
        labels: { readTimeout: 'Read timed out', useAppActions: 'Use the app action buttons at the bottom of the page' } }), '*');
      expect(container.querySelector('iframe')).toBe(frame);
      expect(frame.getAttribute('srcdoc')).toBe(originalHtml);
      expect(originalHtml).toContain('用户原始页面');
    } finally { post.mockRestore(); act(() => { applyLocaleSetting('zh-CN'); }); }
  });
  it('手机导航随语言切换翻译并保留工作区名称', async () => {
    render(<Harness/>); fireEvent.click(screen.getByText('打开手机应用'));
    await screen.findByRole('heading', { name: '我的应用' });
    try {
      act(() => { applyLocaleSetting('en'); });
      expect(await screen.findByRole('region', { name: '研究室 phone' })).toBeTruthy();
      expect(screen.getByRole('heading', { name: 'My apps' })).toBeTruthy();
      expect(screen.getByRole('navigation', { name: 'Phone navigation' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Settings and connections →' })).toBeTruthy();
      for (const name of ['Todo', 'Reminders', 'Channel', 'Reading']) expect(screen.getByRole('button', { name })).toBeTruthy();
      expect(screen.getByRole('button', { name: '观察记录' })).toBeTruthy();
    } finally { act(() => { applyLocaleSetting('zh-CN'); }); }
  });
  it('英文搜索可找到内置应用，改名的应用保持用户名称', async () => {
    currentApiMock().override('agentApps.snapshot', async () => ({ ...snapshot, apps: snapshot.apps.map(item => item.definition.id === 'rss' ? { ...item, definition: { ...item.definition, name: '自定义阅读' } } : item) }));
    render(<Harness/>); fireEvent.click(screen.getByText('打开手机应用'));
    await screen.findByRole('heading', { name: '我的应用' });
    try {
      act(() => { applyLocaleSetting('en'); });
      expect(screen.getByRole('button', { name: '自定义阅读' })).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Phone search' }));
      fireEvent.change(screen.getByRole('textbox', { name: 'Search app content' }), { target: { value: 'reminders' } });
      expect(screen.getByRole('button', { name: 'Reminders' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Todo' })).toBeNull();
    } finally { act(() => { applyLocaleSetting('zh-CN'); }); }
  });
  it('机身三键仅保留透明热区，使用图片符号且搜索、主页、返回仍可操作', async () => {
    render(<Harness/>); fireEvent.click(screen.getByText('打开手机应用'));
    const phone = await screen.findByRole('region', { name: '研究室的手机' });
    const buttons = within(within(phone).getByRole('navigation', { name: '手机导航' })).getAllByRole('button');
    expect(buttons.map(button => button.getAttribute('aria-label'))).toEqual(['返回', '手机主页', '手机搜索']);
    for (const button of buttons) {
      expect(button.childElementCount).toBe(0);
      expect(button.textContent).toBe('');
    }
    fireEvent.click(buttons[2]);
    expect(await screen.findByRole('textbox', { name: '搜索应用内容' })).toBeTruthy();
    fireEvent.click(buttons[0]);
    expect(screen.queryByRole('textbox', { name: '搜索应用内容' })).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: /观察记录/ }));
    await screen.findByRole('heading', { name: '观察记录' });
    fireEvent.click(buttons[1]);
    expect(await screen.findByRole('heading', { name: '我的应用' })).toBeTruthy();
    fireEvent.click(buttons[0]);
    await waitFor(() => expect(screen.queryByRole('region', { name: '研究室的手机' })).toBeNull());
  });
  it('磁贴退场和应用入场同时保留，快速返回反转同一个磁贴层', async () => {
    render(<Harness/>); fireEvent.click(screen.getByText('打开手机应用'));
    const tile = await screen.findByRole('button', { name: /观察记录/ });
    const home = tile.closest('.ap-scene')!;
    fireEvent.click(tile);
    await screen.findByRole('heading', { name: '观察记录' });
    expect(home.getAttribute('data-mp-stage')).toBe('out');
    expect(home.getAttribute('data-flight')).toBe('moving');
    expect(home.hasAttribute('inert')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '手机主页' }));
    expect(screen.getByRole('button', { name: /观察记录/ }).closest('.ap-scene')).toBe(home);
    expect(home.getAttribute('data-mp-stage')).toBe('in');
    expect(home.getAttribute('data-direction')).toBe('back');
    expect(home.hasAttribute('inert')).toBe(false);
  });
  it('工具失败显示在对应应用内，后续成功仍显示实际内容', async () => {
    render(<Harness/>);
    act(() => currentApiMock().emit('agentApps:operation', operation({ phase: 'failed', error: '读取失败，请检查连接' })));
    expect((await findAppTip()).textContent).toContain('读取失败，请检查连接');
    expect(screen.getByRole('heading', { name: '观察记录' })).toBeTruthy();
    act(() => currentApiMock().emit('agentApps:operation', operation({ operationId: 'next', sequence: 2 })));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });
  it('打开手机观察不会暂停跟随；工具打开真实记录而不是只显示操作计数', async () => {
    currentApiMock().override('agentApps.query', async () => ({ record: { id: 'note', collection: 'items', revision: 1, createdAt: 1, updatedAt: 1, values: { title: '工具写入的正文' } } }));
    render(<Harness/>); fireEvent.click(screen.getByText('打开手机应用'));
    await screen.findByRole('heading', { name: '我的应用' });
    expect(screen.queryByRole('button', { name: /继续跟随/ })).toBeNull();
    fireEvent.pointerDown(screen.getByRole('heading', { name: '我的应用' }));
    act(() => currentApiMock().emit('agentApps:operation', operation({ entityId: 'note' })));
    await screen.findByRole('heading', { name: '工具写入的正文' });
    expect(document.querySelector('.ap-operation')).toBeNull();
    expect(currentApiMock().mockOf('agentApps.call')).not.toHaveBeenCalled();
  });
  it('连续工具事件到达时仍按节拍展示，不能等到事件流停止才打开手机', async () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useAgentPhone('one'));
      act(() => currentApiMock().emit('agentApps:operation', operation()));
      for (let i = 2; i <= 4; i++) {
        await act(async () => { await vi.advanceTimersByTimeAsync(40); });
        act(() => currentApiMock().emit('agentApps:operation', operation({ operationId: `burst-${i}`, sequence: i })));
      }
      expect(result.current.state.open).toBe(true);
      expect(result.current.state.operation?.operationId).toBe('op1');
    } finally { vi.useRealTimers(); }
  });
  it('工具展示自动进入未知应用；不抢输入焦点，也不重执行命令', async () => {
    render(<Harness/>); const input = screen.getByLabelText('聊天输入'); input.focus();
    act(() => currentApiMock().emit('agentApps:operation', operation()));
    expect(await screen.findByRole('heading', { name: '观察记录' })).toBeTruthy();
    expect(document.activeElement).toBe(input);
    expect(currentApiMock().mockOf('agentApps.call')).not.toHaveBeenCalled();
    expect(screen.queryByText('已完成 · 新增')).toBeNull();
    expect(screen.getByRole('button', { name: '返回' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '手机主页' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '手机搜索' })).toBeTruthy();
  });
  it('旧操作延迟完成不能堵住后续页面的自动展示', async () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useAgentPhone('one'));
      act(() => currentApiMock().emit('agentApps:operation', operation({ phase: 'running' })));
      await act(async () => { await vi.advanceTimersByTimeAsync(120); });
      act(() => currentApiMock().emit('agentApps:operation', operation({ operationId: 'second', sequence: 2, appId: 'tasks' })));
      await act(async () => { await vi.advanceTimersByTimeAsync(580); });
      expect(result.current.state.route.appId).toBe('tasks');
      act(() => {
        currentApiMock().emit('agentApps:operation', operation({ sequence: 3 }));
        currentApiMock().emit('agentApps:operation', operation({ operationId: 'third', sequence: 4, appId: 'rss' }));
      });
      await act(async () => { await vi.advanceTimersByTimeAsync(1200); });
      expect(result.current.state.route.appId).toBe('rss');
      expect(result.current.state.pending).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it('人工浏览后继续自动展示，无跟随工具栏；关闭后同一轮不再弹出', async () => {
    render(<Harness/>);
    act(() => currentApiMock().emit('agentApps:operation', operation()));
    await screen.findByRole('heading', { name: '观察记录' });
    fireEvent.click(screen.getByRole('button', { name: '手机主页' }));
    await screen.findByRole('heading', { name: '我的应用' });
    act(() => currentApiMock().emit('agentApps:operation', operation({ operationId: 'op2', sequence: 2, appId: 'tasks', title: '读取待办' })));
    expect(screen.getByRole('heading', { name: '我的应用' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /继续跟随/ })).toBeNull();
    await screen.findByRole('heading', { name: '待办' });
    fireEvent.keyDown(screen.getByRole('region'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('region', { name: '研究室的手机' })).toBeNull());
    act(() => currentApiMock().emit('agentApps:operation', operation({ operationId: 'op3', sequence: 3 })));
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(screen.queryByRole('region', { name: '研究室的手机' })).toBeNull();
    act(() => currentApiMock().emit('agentApps:operation', operation({ operationId: 'op4', sequence: 4, runId: 'turn2' })));
    expect(await screen.findByRole('region', { name: '研究室的手机' })).toBeTruthy();
  });
  it('人工新增通过同一服务保存；搜索和返回不写业务数据', async () => {
    currentApiMock().override('agentApps.call', async () => ({ record: { id: 'saved', collection: 'items', revision: 1, createdAt: 1, updatedAt: 1, values: { title: '观察值' } } }));
    render(<Harness/>); fireEvent.click(screen.getByText('打开手机应用'));
    fireEvent.click(await screen.findByRole('button', { name: /观察记录/ }));
    fireEvent.click(await screen.findByRole('button', { name: /新增/ }));
    fireEvent.change(await screen.findByRole('textbox', { name: '标题' }), { target: { value: '观察值' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(currentApiMock().mockOf('agentApps.call')).toHaveBeenCalledTimes(1));
    expect(currentApiMock().mockOf('agentApps.call').mock.calls[0]).toEqual(['one', expect.objectContaining({ appId: 'field-log', commandId: 'create', params: { values: { title: '观察值' } } })]);
    fireEvent.click(screen.getByRole('button', { name: '手机搜索' }));
    fireEvent.change(screen.getByRole('textbox', { name: '搜索应用内容' }), { target: { value: '不存在' } });
    await screen.findByText('没有匹配的内容');
    expect(currentApiMock().mockOf('agentApps.call')).toHaveBeenCalledTimes(1);
  });
  it('编辑表单期间不丢草稿，退出后自动继续展示，不需要跟随按钮', async () => {
    render(<Harness/>); fireEvent.click(screen.getByText('打开手机应用'));
    fireEvent.click(await screen.findByRole('button', { name: /观察记录/ }));
    fireEvent.click(await screen.findByRole('button', { name: /新增/ }));
    const field = await screen.findByRole('textbox', { name: '标题' });
    fireEvent.change(field, { target: { value: '尚未保存的草稿' } });
    act(() => currentApiMock().emit('agentApps:operation', operation({ appId: 'tasks' })));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 650)); });
    expect((field as HTMLInputElement).value).toBe('尚未保存的草稿');
    expect(screen.getByRole('heading', { name: '编辑' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    await screen.findByRole('heading', { name: '待办' });
    expect(screen.queryByRole('button', { name: /继续跟随/ })).toBeNull();
  });
  it('总开关默认开启可持久关闭，手机设置不再新建独立连接', async () => {
    render(<Harness/>); fireEvent.click(screen.getByText('打开手机应用'));
    fireEvent.click(await screen.findByRole('button', { name: /设置与连接/ }));
    const toggle = await screen.findByRole('checkbox', { name: '自动展示 AI 的应用操作' }); expect((toggle as HTMLInputElement).checked).toBe(true);
    fireEvent.click(toggle); expect(localStorage.getItem(PHONE_AUTO_KEY)).toBe('false');
    expect(screen.queryByRole('button', { name: /添加邮箱|扫码创建专用机器人/ })).toBeNull();
    fireEvent.keyDown(screen.getByRole('region', { name: '研究室的手机' }), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('region', { name: '研究室的手机' })).toBeNull());
    act(() => currentApiMock().emit('agentApps:operation', operation()));
    await new Promise(resolve => setTimeout(resolve, 200)); expect(screen.queryByRole('region')).toBeNull();
  });
  it('延迟旧查询不会覆盖更新的记录；错误可重试', async () => {
    let finish: (value: unknown) => void = () => {};
    currentApiMock().override('agentApps.query', () => new Promise(resolve => { finish = resolve; }));
    render(<Harness/>); act(() => currentApiMock().emit('agentApps:operation', operation()));
    await screen.findByRole('heading', { name: '观察记录' });
    const oldFinish = finish;
    currentApiMock().override('agentApps.query', async () => ({ records: [{ id: 'new', collection: 'items', revision: 2, createdAt: 1, updatedAt: 2, values: { title: '新结果' } }], total: 1 }));
    act(() => currentApiMock().emit('agentApps:changed', { workspaceId: 'one', appId: 'field-log', revision: 3 }));
    await screen.findByText('新结果');
    await act(async () => oldFinish({ records: [{ id: 'old', values: { title: '旧结果' } }], total: 1 }));
    expect(screen.queryByText('旧结果')).toBeNull();
    const phone = screen.getByRole('region'); expect(within(phone).getByText('新结果')).toBeTruthy();
  });
  it('切换工作区再回来不会忘记本轮收起状态', async () => {
    const { rerender } = render(<Harness/>);
    act(() => currentApiMock().emit('agentApps:operation', operation()));
    fireEvent.keyDown(await screen.findByRole('region'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('region')).toBeNull());
    rerender(<Harness workspaceId="two"/>); rerender(<Harness workspaceId="one"/>);
    act(() => currentApiMock().emit('agentApps:operation', operation({ operationId: 'later', sequence: 2 })));
    await new Promise(resolve => setTimeout(resolve, 200)); expect(screen.queryByRole('region')).toBeNull();
  });
  it('旧消息操作进到统一渠道入口', async () => {
    currentApiMock().override('agentApps.query', async () => ({ channels: [] }));
    render(<Harness/>);
    act(() => currentApiMock().emit('agentApps:operation', operation({ appId: 'messages', viewId: 'main', entityId: 'historical' })));
    await screen.findByRole('heading', { name: 'Channel' });
    expect(currentApiMock().mockOf('agentApps.query')).toHaveBeenCalledWith('one', { appId: CHANNEL_APP_ID });
  });
  it('阅读器原文链接经宿主打开，失败明确显示且不重放业务', async () => {
    currentApiMock().override('agentApps.query', async () => ({ record: { id: 'article', collection: 'articles', revision: 1, createdAt: 1, updatedAt: 1, values: { title: '一篇文章', url: 'https://example.com/article', content: '正文' } } }));
    currentApiMock().override('shell.openExternal', async () => ({ ok: false, error: '系统浏览器不可用' }));
    render(<Harness/>); act(() => currentApiMock().emit('agentApps:operation', operation({ appId: 'rss', viewId: 'articles', entityId: 'article' })));
    fireEvent.click(await screen.findByRole('link', { name: 'https://example.com/article' }));
    await findAppTip(); expect(screen.getByText('系统浏览器不可用')).toBeTruthy();
    expect(currentApiMock().mockOf('shell.openExternal')).toHaveBeenCalledWith('https://example.com/article');
    expect(currentApiMock().mockOf('agentApps.call')).not.toHaveBeenCalled();
  });
});

describe('bounded independent presentation', () => {
  it('跨区、后台、关闭与乱序回执不串屏；队列有限且保留失败', () => {
    const controller = new AppPresentationController('one');
    controller.accept(operation({ workspaceId: 'two' })); controller.accept(operation({ actor: 'human' })); controller.accept(operation({ agentId: 'worker:one' })); controller.advance(); expect(controller.state.open).toBe(false);
    controller.accept(operation({ phase: 'running' })); controller.advance();
    controller.accept(operation({ operationId: 'new', sequence: 2, appId: 'tasks' })); controller.advance();
    controller.accept(operation({ sequence: 3, phase: 'succeeded' })); controller.advance(); expect(controller.state.route.appId).toBe('tasks');
    controller.accept(operation({ sequence: 2, phase: 'running' })); expect(controller.state.pending).toBe(0);
    controller.manual({ appId: 'tasks', editCommand: 'create' });
    for (let i = 4; i < 100; i++) controller.accept(operation({ operationId: `bulk-${i}`, sequence: i, phase: i === 6 ? 'failed' : 'succeeded', error: i === 6 ? '真实失败' : undefined }));
    expect(controller.state.pending).toBe(8); expect(controller.state.compressed).toBeGreaterThan(0); expect(controller.state.failures[0].error).toBe('真实失败');
    controller.resume(); expect(controller.state.pending).toBe(0); expect(controller.state.operation?.operationId).toBe('bulk-99');
  });
});

describe('Lifecycle command directions', () => {
  it('reminder and reply labels follow the interface language', async () => {
    const { commandPresentation } = await import('../../src/renderer/src/agentApps/commandPresentation');
    const reminder = builtInAgentApps().find(app => app.id === 'reminders')!.commands.find(command => command.handler === 'reminders.set')!;
    const message = builtInAgentApps().find(app => app.id === 'messages')!.commands.find(command => command.handler === 'messages.send')!;
    const record = { id: 'item', collection: 'items', revision: 1, createdAt: 1, updatedAt: 1, values: { enabled: false } };
    try {
      applyLocaleSetting('en');
      expect(commandPresentation(reminder, record).title).toBe('Set again');
      expect(commandPresentation(reminder, { ...record, values: { enabled: true } }).title).toBe('Edit reminder');
      expect(commandPresentation(message, record).title).toBe('Reply');
    } finally { applyLocaleSetting('zh-CN'); }
  });
  it('exposes delete and reversible state semantics on each content app', async () => {
    const { commandChangesRecord, commandPresentation } = await import('../../src/renderer/src/agentApps/commandPresentation');
    for (const app of builtInAgentApps().filter(app => ['rss', 'mail', 'messages'].includes(app.id))) {
      const view = app.views[0];
      expect(view.commands).toContain('remove');
      const record = { id: 'item', collection: app.collections[0].id, revision: 1, createdAt: 1, updatedAt: 1, values: {} };
      for (const [forward, reverse, field] of [['read', 'unread', 'read'], ['processed', 'unprocessed', 'processed'], ...(app.id === 'rss' ? [['save', 'unsave', 'saved']] : [])]) {
        const on = app.commands.find(command => command.id === forward)!;
        const off = app.commands.find(command => command.id === reverse)!;
        expect(commandChangesRecord(on, record)).toBe(true);
        expect(commandChangesRecord(off, record)).toBe(false);
        const changed = { ...record, values: { [field]: true } };
        expect(commandChangesRecord(on, changed)).toBe(false);
        expect(commandChangesRecord(off, changed)).toBe(true);
        expect(commandPresentation(off, changed).icon).toBe('undo');
      }
    }
  });
});
