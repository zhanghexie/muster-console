import { renderWithAppTips as render, findAppTip } from './helpers/app-tips';
import React, { useCallback, useState } from 'react';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { FeedbackCenter, FeedbackEntryPoint } from '../../src/renderer/src/components/FeedbackCenter';
import type { FeedbackEntry, FeedbackReview, FeedbackSnapshot } from '../../src/shared/feedback';
import { feedbackEditableText, feedbackReadableBody } from '../../src/shared/feedbackFormatting';
import { currentApiMock } from './helpers/api-mock';

const entry: FeedbackEntry = { id: 'draft-1', revision: 1, status: 'pending', createdAt: 1, updatedAt: 1, sources: ['worker:a'],
  appVersion: '0.1.31', aiChecked: true, kind: 'bug', title: '切换工作区后滚动位置丢失', area: '会话列表', context: '切换两个工作区',
  actual: '回到顶部', expected: '恢复原位置', steps: '滚动列表后切换再返回', impact: '需要重新定位', evidence: '只观察一次', suggestion: '' };
const snapshot: FeedbackSnapshot = { entries: [entry] };
const review: FeedbackReview = { reviewId: 'review-1', revision: 1, matches: [], body: '## 实际情况\n回到顶部\n\n## 证据与不确定性\n只观察一次' };
function Harness({ initial = snapshot }: { initial?: FeedbackSnapshot } = {}) {
  const [state, setState] = useState(initial);
  const [open, setOpen] = useState(true);
  const refresh = useCallback(async () => {}, []);
  return <FeedbackCenter open={open} onClose={() => setOpen(false)} snapshot={state} onSnapshot={setState} onRefresh={refresh}/>;
}

it('lets supported browsers size feedback fields without observing or reading their layout', async () => {
  const supports = vi.fn(() => true);
  const observe = vi.fn();
  vi.stubGlobal('CSS', { supports });
  vi.stubGlobal('ResizeObserver', class { observe = observe; disconnect() {} });
  const clientWidth = vi.spyOn(HTMLTextAreaElement.prototype, 'clientWidth', 'get').mockReturnValue(240);
  const scrollHeight = vi.spyOn(HTMLTextAreaElement.prototype, 'scrollHeight', 'get').mockReturnValue(80);
  try {
    render(<Harness/>);
    const field = await screen.findByRole<HTMLTextAreaElement>('textbox', { name: '使用场景' });
    fireEvent.change(field, { target: { value: '第一行\n第二行' } });
    expect(field.value).toBe('第一行\n第二行');
    expect(supports).toHaveBeenCalledWith('field-sizing', 'content');
    expect(field.style.height).toBe('');
    expect(clientWidth).not.toHaveBeenCalled();
    expect(scrollHeight).not.toHaveBeenCalled();
    expect(observe).not.toHaveBeenCalled();
  } finally {
    clientWidth.mockRestore();
    scrollHeight.mockRestore();
    vi.unstubAllGlobals();
  }
});

it('keeps the legacy height measurement on edit, resize and programmatic updates while hidden', async () => {
  let width = 240;
  const observations = new Map<Element, () => void>();
  vi.stubGlobal('CSS', { supports: () => false });
  vi.stubGlobal('ResizeObserver', class {
    private field: Element | null = null;
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(field: Element) {
      this.field = field;
      observations.set(field, () => this.callback([{ target: field, contentRect: { width } } as ResizeObserverEntry], this as unknown as ResizeObserver));
    }
    disconnect() { if (this.field) observations.delete(this.field); }
  });
  const clientWidth = vi.spyOn(HTMLTextAreaElement.prototype, 'clientWidth', 'get').mockImplementation(() => width);
  const scrollHeight = vi.spyOn(HTMLTextAreaElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLTextAreaElement) {
    expect(this.style.height).toBe('auto');
    return (width < 200 ? 30 : 15) * this.value.split('\n').length;
  });
  const clientHeight = vi.spyOn(HTMLTextAreaElement.prototype, 'clientHeight', 'get').mockReturnValue(40);
  const offsetHeight = vi.spyOn(HTMLTextAreaElement.prototype, 'offsetHeight', 'get').mockReturnValue(42);
  const panel = (value: FeedbackSnapshot) => <FeedbackCenter open onClose={() => {}} snapshot={value} onSnapshot={() => {}} onRefresh={async () => {}}/>;
  const view = render(panel(snapshot));
  try {
    const field = await screen.findByRole<HTMLTextAreaElement>('textbox', { name: '使用场景' });
    expect(field.style.height).toBe('17px');
    fireEvent.change(field, { target: { value: '第一行\n第二行' } });
    expect(field.style.height).toBe('32px');
    width = 160;
    act(() => observations.get(field)?.());
    expect(field.style.height).toBe('62px');

    width = 0;
    act(() => observations.get(field)?.());
    view.rerender(panel({ entries: [{ ...entry, revision: 2, context: '程序写入\n补充一行\n最后一行' }] }));
    expect(field.value).toBe('程序写入\n补充一行\n最后一行');
    expect(field.style.height).toBe('62px');
    width = 160;
    act(() => observations.get(field)?.());
    expect(field.style.height).toBe('92px');
  } finally {
    view.unmount();
    vi.unstubAllGlobals();
    clientWidth.mockRestore();
    scrollHeight.mockRestore();
    clientHeight.mockRestore();
    offsetHeight.mockRestore();
  }
  expect(observations.size).toBe(0);
});

it('deletes only after confirmation and selects the next feedback', async () => {
  const api = currentApiMock();
  const other = { ...entry, id: 'draft-2', title: '另外一条反馈', area: '通知' };
  api.override('feedback.delete', async () => ({ entries: [other] }));
  render(<Harness initial={{ entries: [entry, other] }}/>);
  fireEvent.click(await screen.findByRole('button', { name: '删除反馈' }));
  const confirm = await screen.findByRole('dialog', { name: '删除反馈？' });
  expect(within(confirm).getByText(/无法恢复/)).toBeTruthy();
  fireEvent.click(within(confirm).getByRole('button', { name: '取消' }));
  expect(api.mockOf('feedback.delete')).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '删除反馈' }));
  fireEvent.click(within(await screen.findByRole('dialog', { name: '删除反馈？' })).getByRole('button', { name: '删除' }));
  await waitFor(() => expect(api.mockOf('feedback.delete')).toHaveBeenCalledWith(entry.id, 1));
  await waitFor(() => expect((screen.getByRole('textbox', { name: '标题' }) as HTMLInputElement).value).toBe('另外一条反馈'));
  expect(screen.queryByRole('button', { name: /切换工作区后滚动位置丢失/ })).toBeNull();
});

it('clearly states that deleting a submitted record does not delete its remote Issue', async () => {
  render(<Harness initial={{ entries: [{ ...entry, status: 'submitted', issueUrl: 'https://gitlab.example.test/a/b/-/issues/1' }] }}/>);
  const heading = await screen.findByText(entry.title, { selector: '.feedback-detail-heading strong' });
  expect(heading.parentElement?.textContent).toContain('已提交');
  expect(screen.queryByText(/本地来源/)).toBeNull();
  expect(screen.getByRole('button', { name: '查看已发送反馈' }).parentElement).toBe(screen.getByRole('button', { name: '删除反馈' }).parentElement);
  fireEvent.click(await screen.findByRole('button', { name: '删除反馈' }));
  expect(within(await screen.findByRole('dialog', { name: '删除反馈？' })).getByText(/不会删除仓库中的 Issue/)).toBeTruthy();
});

it('shows an empty list after deleting the final feedback and keeps it on failure', async () => {
  const api = currentApiMock();
  api.override('feedback.delete', async () => { throw new Error('反馈已变化，请重新检查'); });
  render(<Harness/>);
  fireEvent.click(await screen.findByRole('button', { name: '删除反馈' }));
  fireEvent.click(within(await screen.findByRole('dialog', { name: '删除反馈？' })).getByRole('button', { name: '删除' }));
  expect((await findAppTip()).textContent).toContain('反馈已变化');
  expect(screen.getByRole('textbox', { name: '标题' })).toBeTruthy();
  api.override('feedback.delete', async () => ({ entries: [] }));
  fireEvent.click(screen.getByRole('button', { name: '删除反馈' }));
  fireEvent.click(within(await screen.findByRole('dialog', { name: '删除反馈？' })).getByRole('button', { name: '删除' }));
  expect(await screen.findByText('暂无反馈')).toBeTruthy();
  expect(screen.queryByRole('textbox', { name: '标题' })).toBeNull();
});

it('warns before deleting feedback whose submission outcome is uncertain', async () => {
  render(<Harness initial={{ entries: [{ ...entry, status: 'uncertain' }] }}/>);
  fireEvent.click(await screen.findByRole('button', { name: '删除反馈' }));
  expect(within(await screen.findByRole('dialog', { name: '删除反馈？' })).getByText(/无法核对/)).toBeTruthy();
});

it('keeps previously edited free-form content visible and saves it without loss', async () => {
  const api = currentApiMock();
  const legacy = { ...entry, editedBody: '自定义前言\n\n实际情况：\n旧内容\n\n其他说明' };
  const expected = `${entry.title}\n\n自定义前言\n\n实际情况：\n新内容`;
  api.override('feedback.updateText', async () => ({ entries: [{ ...legacy, revision: 2, editedBody: '自定义前言\n\n实际情况：\n新内容' }] }));
  render(<Harness initial={{ entries: [legacy] }}/>);
  expect((await screen.findByRole('textbox', { name: '反馈正文' }) as HTMLTextAreaElement).value).toBe('自定义前言');
  expect((screen.getByRole('textbox', { name: '实际情况' }) as HTMLTextAreaElement).value).toBe('旧内容\n\n其他说明');
  fireEvent.change(screen.getByRole('textbox', { name: '实际情况' }), { target: { value: '新内容' } });
  fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));
  await waitFor(() => expect(api.mockOf('feedback.updateText')).toHaveBeenCalledWith(entry.id, 1, expected));
});

it('retains an older manual body while letting the user add a separate field', async () => {
  const api = currentApiMock();
  const legacyBody = '类型：问题\n\n反馈正文：\n此前保存的内容';
  const legacy = { ...entry, editedBody: legacyBody };
  api.override('feedback.updateText', async () => ({ entries: [{ ...legacy, revision: 2, editedBody: `${legacyBody}\n\n实际情况：\n补充实际情况` }] }));
  render(<Harness initial={{ entries: [legacy] }}/>);
  expect((await screen.findByRole('textbox', { name: '反馈正文' }) as HTMLTextAreaElement).value).toBe('此前保存的内容');
  fireEvent.change(screen.getByRole('textbox', { name: '实际情况' }), { target: { value: '补充实际情况' } });
  fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));
  await waitFor(() => expect(api.mockOf('feedback.updateText')).toHaveBeenCalledWith(entry.id, 1, `${entry.title}\n\n${legacyBody}\n\n实际情况：\n补充实际情况`));
});

it('requires saving edits and viewing a complete review before the user submits one issue', async () => {
  const api = currentApiMock();
  const editedBody = feedbackReadableBody(entry).replace('影响：\n需要重新定位', '影响：\n阻断继续工作');
  const edited = `新的反馈标题\n\n${editedBody}`;
  const changed = { ...entry, revision: 2, title: '新的反馈标题', editedBody };
  api.override('feedback.updateText', async () => ({ ...snapshot, entries: [changed] }));
  api.override('feedback.prepare', async () => ({ ...review, revision: 2, body: '## 影响\n阻断继续工作\n\n## 证据\n只观察一次' }));
  api.override('feedback.submit', async () => ({ ...snapshot, entries: [{ ...changed, revision: 3, status: 'submitted' }] }));
  render(<Harness/>);
  await screen.findByRole('textbox', { name: '标题' });
  expect((screen.getByRole('textbox', { name: '实际情况' }) as HTMLTextAreaElement).value).toBe('回到顶部');
  expect(feedbackEditableText(entry)).toContain('回到顶部');
  expect(screen.queryByRole('button', { name: '在 GitHub 提交' })).toBeNull();
  expect(screen.queryByLabelText('仓库地址')).toBeNull();
  expect(screen.queryByLabelText('访问令牌')).toBeNull();
  fireEvent.change(screen.getByRole('textbox', { name: '标题' }), { target: { value: '新的反馈标题' } });
  fireEvent.change(screen.getByRole('textbox', { name: '影响' }), { target: { value: '阻断继续工作' } });
  expect(screen.getByRole('button', { name: '审核反馈' }).hasAttribute('disabled')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));
  await waitFor(() => expect(api.mockOf('feedback.updateText')).toHaveBeenCalledWith(entry.id, 1, edited));
  await waitFor(() => expect(screen.getByRole('button', { name: '审核反馈' }).hasAttribute('disabled')).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: '审核反馈' }));
  const preview = within(await screen.findByLabelText('提交前核对')).getByRole('textbox', { name: '影响' }) as HTMLTextAreaElement;
  expect(preview.value).toBe('阻断继续工作');
  expect(preview.readOnly).toBe(true);
  expect(api.mockOf('feedback.submit')).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '在 GitHub 提交' }));
  await waitFor(() => expect(api.mockOf('feedback.submit')).toHaveBeenCalledWith(entry.id, 2, 'review-1', false));
});

it('does not ask the user to compare similar reports already assessed by AI', async () => {
  const api = currentApiMock();
  const match = { id: '42', title: '切换工作区后列表位置丢失', status: 'open', url: 'https://gitlab.example.test/a/b/-/issues/42', exact: false, source: 'remote' as const };
  api.override('feedback.prepare', async () => ({ ...review, matches: [match] }));
  render(<Harness/>);
  fireEvent.click(await screen.findByRole('button', { name: '审核反馈' }));
  const section = await screen.findByLabelText('提交前核对');
  expect(screen.getByRole('button', { name: '在 GitHub 提交' }).hasAttribute('disabled')).toBe(false);
  expect(within(section).queryByText(match.title)).toBeNull();
  expect(within(section).queryByRole('checkbox')).toBeNull();
  expect(within(section).queryByRole('button', { name: '标记为重复' })).toBeNull();
  expect(api.mockOf('feedback.submit')).not.toHaveBeenCalled();
});

it('blocks exact matches', async () => {
  const api = currentApiMock();
  api.override('feedback.prepare', async () => ({ ...review, matches: [{ id: '9', title: entry.title, status: 'closed', exact: true, source: 'remote' }] }));
  render(<Harness/>);
  fireEvent.click(await screen.findByRole('button', { name: '审核反馈' }));
  await screen.findByLabelText('提交前核对');
  expect(screen.getByRole('button', { name: '在 GitHub 提交' }).hasAttribute('disabled')).toBe(true);
  expect(screen.queryByRole('checkbox', { name: '我已核对以上反馈，确认这是不同问题' })).toBeNull();
});

it('shows pending AI review after an edit and never asks the user to do the duplicate check', async () => {
  const api = currentApiMock();
  const editedBody = feedbackReadableBody(entry).replace('影响：\n需要重新定位', '影响：\n阻断工作');
  api.override('feedback.updateText', async () => ({ entries: [{ ...entry, revision: 2, editedBody, aiChecked: false }] }));
  api.override('feedback.prepare', async () => { throw new Error('反馈正在等待 AI 查重，完成后即可提交'); });
  render(<Harness/>);
  fireEvent.change(await screen.findByRole('textbox', { name: '影响' }), { target: { value: '阻断工作' } });
  fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));
  expect(await screen.findByText('等待 AI 查重')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '审核反馈' }));
  expect((await findAppTip()).textContent).toContain('等待 AI 查重');
  expect(screen.queryByRole('checkbox')).toBeNull();
  expect(api.mockOf('feedback.submit')).not.toHaveBeenCalled();
});

it('allows anonymous review and keeps browser handoff separate from actual submission', async () => {
  const api = currentApiMock();
  const opened = { ...entry, status: 'opened' as const, revision: 2 };
  const issueUrl = 'https://github.com/zhanghexie/muster-console/issues/42';
  api.override('feedback.prepare', async () => ({ ...review, copyBody: true }));
  api.override('feedback.submit', async () => ({ entries: [opened] }));
  api.override('feedback.reconcile', async () => ({ entries: [{ ...opened, status: 'submitted', revision: 3, issueUrl }] }));
  render(<Harness/>);
  fireEvent.click(await screen.findByRole('button', { name: '审核反馈' }));
  expect(await screen.findByText(/标题和正文将在 GitHub 上公开/)).toBeTruthy();
  expect(screen.getByText(/请在网页中粘贴/)).toBeTruthy();
  expect(api.mockOf('feedback.submit')).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '在 GitHub 提交' }));
  const verify = await screen.findByRole('button', { name: '核对是否已提交' });
  expect(screen.getByText('请在 GitHub 页面提交，再回来核对。')).toBeTruthy();
  expect(screen.queryByRole('button', { name: '查看已发送反馈' })).toBeNull();
  fireEvent.click(verify);
  await waitFor(() => expect(api.mockOf('feedback.reconcile')).toHaveBeenCalledWith(entry.id, 2));
  expect(await screen.findByRole('button', { name: '查看已发送反馈' })).toBeTruthy();
});

it('offers to restore the draft after the user closes the GitHub page', async () => {
  const api = currentApiMock();
  api.override('feedback.reconcile', async () => ({ entries: [{ ...entry, revision: 3, aiChecked: false }] }));
  render(<Harness initial={{ entries: [{ ...entry, status: 'opened', revision: 2 }] }}/>);
  fireEvent.click(await screen.findByRole('button', { name: '已关闭网页，恢复草稿' }));
  await waitFor(() => expect(api.mockOf('feedback.reconcile')).toHaveBeenCalledWith(entry.id, 2, true));
  expect(await screen.findByText('等待 AI 查重')).toBeTruthy();
});

it('shows the title-bar entry only while feedback needs attention', async () => {
  const api = currentApiMock();
  let current: FeedbackSnapshot = { entries: [{ ...entry, status: 'submitted' }] };
  api.override('feedback.snapshot', async () => current);
  render(<FeedbackEntryPoint/>);
  await waitFor(() => expect(api.mockOf('feedback.snapshot')).toHaveBeenCalled());
  expect(screen.queryByRole('button', { name: /反馈审核/ })).toBeNull();
  current = snapshot;
  act(() => api.emit('feedback:changed', {}));
  expect(await screen.findByRole('button', { name: '反馈审核（1 条待处理）' })).toBeTruthy();
  current = { entries: [{ ...entry, status: 'submitted' }] };
  act(() => api.emit('feedback:changed', {}));
  await waitFor(() => expect(screen.queryByRole('button', { name: /反馈审核/ })).toBeNull());
  current = { entries: [{ ...entry, status: 'opened' }] };
  act(() => api.emit('feedback:changed', {}));
  expect(await screen.findByRole('button', { name: '反馈审核（1 条待处理）' })).toBeTruthy();
});

it('关闭反馈审核时面板与磨砂一起退场，外壳立即停止交互', async () => {
  render(<Harness/>);
  const dialog = await screen.findByRole('dialog', { name: '反馈审核' });
  const overlay = dialog.parentElement as HTMLElement;
  const scrim = overlay.querySelector<HTMLElement>(':scope > .backdrop-blur-overlay.mp-scrim');
  expect(overlay.classList.contains('mp-scrim')).toBe(false);
  expect(scrim?.dataset.mpStage).toBe('in');
  expect(dialog.classList.contains('mp-panel-fly')).toBe(true);
  expect(dialog.getAttribute('data-mp-stage')).toBe('in');
  fireEvent.click(within(dialog).getByRole('button', { name: '关闭' }));
  await waitFor(() => expect(overlay.getAttribute('data-mp-stage')).toBe('out'));
  expect(dialog.getAttribute('data-mp-stage')).toBe('out');
  expect(scrim?.dataset.mpStage).toBe('out');
  expect(overlay.hasAttribute('inert')).toBe(true);
});

it('lets a person add a draft from an empty list and keeps it for AI checking', async () => {
  const api = currentApiMock();
  const input = { kind: 'improvement' as const, title: '手动反馈', area: '会话列表', context: '切换工作区', actual: '回到顶部',
    expected: '恢复位置', steps: '切换后返回', impact: '', evidence: '观察一次', suggestion: '保存位置', environment: 'Windows 11' };
  const added = { ...entry, ...input, id: 'manual-1', aiChecked: false };
  api.override('feedback.createManual', async () => ({ id: added.id, snapshot: { entries: [added] } }));
  render(<Harness initial={{ entries: [] }}/>);
  fireEvent.click(await screen.findByRole('button', { name: '手动添加反馈' }));
  const title = screen.getByRole('textbox', { name: '标题' }) as HTMLTextAreaElement;
  expect(title.required).toBe(true);
  expect(title.closest('label')?.textContent).toContain('必填');
  expect(screen.getByRole('button', { name: '类型' }).closest('label')?.textContent).toContain('必填');
  expect(screen.queryByRole('textbox', { name: '影响' })).toBeNull();
  fireEvent.change(screen.getByRole('textbox', { name: '标题' }), { target: { value: '手动反馈' } });
  fireEvent.click(screen.getByRole('button', { name: '类型' }));
  fireEvent.click(await screen.findByRole('option', { name: '改进建议' }));
  for (const [label, value] of Object.entries({ 涉及功能: input.area, 使用场景: input.context, 实际情况: input.actual,
    期望: input.expected, 复现步骤或触发条件: input.steps, 证据与不确定性: input.evidence, 建议: input.suggestion, 环境: input.environment })) {
    expect(screen.getByRole('textbox', { name: label }).closest('label')?.textContent).toContain('选填');
    fireEvent.change(screen.getByRole('textbox', { name: label }), { target: { value } });
  }
  expect(screen.queryByRole('textbox', { name: '反馈正文' })).toBeNull();
  expect(api.mockOf('feedback.createManual')).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));
  await waitFor(() => expect(api.mockOf('feedback.createManual')).toHaveBeenCalledWith(input));
  expect(await screen.findByText('等待 AI 查重')).toBeTruthy();
  expect((screen.getByRole('textbox', { name: '实际情况' }) as HTMLTextAreaElement).value).toBe('回到顶部');
  expect((screen.getByRole('textbox', { name: '期望' }) as HTMLTextAreaElement).value).toBe('恢复位置');
  expect((screen.getByRole('textbox', { name: '环境' }) as HTMLTextAreaElement).value).toBe('Muster Console 0.1.31\nWindows 11');
  expect(api.mockOf('feedback.submit')).not.toHaveBeenCalled();
});

it('allows saving a manual draft with only a title and hides the empty impact field', async () => {
  const api = currentApiMock();
  const added = { ...entry, id: 'manual-title', title: '希望记住阅读位置', area: '', context: '', actual: '', expected: '', steps: '',
    impact: '', evidence: '', suggestion: '', environment: '', aiChecked: false };
  api.override('feedback.createManual', async () => ({ id: added.id, snapshot: { entries: [added] } }));
  render(<Harness initial={{ entries: [] }}/>);
  fireEvent.click(await screen.findByRole('button', { name: '手动添加反馈' }));
  const save = screen.getByRole('button', { name: '保存草稿' }) as HTMLButtonElement;
  expect(save.disabled).toBe(true);
  fireEvent.change(screen.getByRole('textbox', { name: '标题' }), { target: { value: added.title } });
  expect(save.disabled).toBe(false);
  fireEvent.click(save);
  await waitFor(() => expect(api.mockOf('feedback.createManual')).toHaveBeenCalledWith(expect.objectContaining({ title: added.title, actual: '', impact: '' })));
  expect(await screen.findByText('等待 AI 查重')).toBeTruthy();
  expect(screen.queryByRole('textbox', { name: '影响' })).toBeNull();
});

it('keeps the displayed required markers accurate when editing a draft', async () => {
  render(<Harness/>);
  const type = await screen.findByRole('textbox', { name: '类型' }) as HTMLTextAreaElement;
  expect(type.required).toBe(true);
  expect(type.closest('label')?.textContent).toContain('必填');
  expect(screen.getByRole('textbox', { name: '实际情况' }).closest('label')?.textContent).toContain('选填');
  fireEvent.change(type, { target: { value: '' } });
  expect((screen.getByRole('button', { name: '保存草稿' }) as HTMLButtonElement).disabled).toBe(true);
});

it('keeps manual feedback text visible when saving fails', async () => {
  const api = currentApiMock();
  api.override('feedback.createManual', async () => { throw new Error('反馈队列无法写入'); });
  render(<Harness initial={{ entries: [] }}/>);
  fireEvent.click(await screen.findByRole('button', { name: '手动添加反馈' }));
  fireEvent.change(screen.getByRole('textbox', { name: '标题' }), { target: { value: '手动反馈' } });
  fireEvent.change(screen.getByRole('textbox', { name: '实际情况' }), { target: { value: '实际问题' } });
  fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));
  expect((await findAppTip()).textContent).toContain('反馈队列无法写入');
  expect((screen.getByRole('textbox', { name: '标题' }) as HTMLTextAreaElement).value).toBe('手动反馈');
  expect((screen.getByRole('textbox', { name: '实际情况' }) as HTMLTextAreaElement).value).toBe('实际问题');
});

it('keeps feedback available locally and shows an actionable message when the repository is unreachable', async () => {
  const api = currentApiMock();
  api.override('feedback.prepare', async () => { throw new Error('无法连接反馈仓库，请稍后重试。'); });
  render(<Harness/>);
  expect(screen.queryByRole('button', { name: '登录以发送反馈' })).toBeNull();
  fireEvent.click(await screen.findByRole('button', { name: '审核反馈' }));
  expect((await findAppTip()).textContent).toContain('无法连接反馈仓库');
  expect(screen.queryByRole('button', { name: '登录以发送反馈' })).toBeNull();
  expect(screen.getByRole('textbox', { name: '标题' })).toBeTruthy();
  expect(screen.queryByLabelText('访问令牌')).toBeNull();
});
