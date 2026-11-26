import { renderWithAppTips as render, findAppTip } from './helpers/app-tips';
import React from 'react';
import { act, createEvent, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionMeta } from '../../src/shared/types';
import { clearDraft } from '../../src/renderer/src/composerDrafts';
import { currentApiMock } from './helpers/api-mock';
import { deliverFileNote, deliverWebNote } from '../../src/renderer/src/agentChat/noteBridge';
import { MOTION } from '../../src/renderer/src/components/motion';
import { workerModelMentions } from '../../src/shared/workerModelMention';
import { pickerCatalog } from './helpers/picker-catalog';

const store = vi.hoisted(() => ({ flashTip: vi.fn(), requestOpenWorkspaceFile: vi.fn(), composerInsert: null,
  clearComposerInsert: vi.fn() }));
const scanHarness = vi.hoisted(() => ({ request: vi.fn(),
  prepare: null as null | (() => () => void), escape: null as null | (() => boolean),
  state: null as null | ((active: boolean) => void) }));
const holdHarness = vi.hoisted(() => ({ blank: true }));
vi.mock('../../src/renderer/src/store', () => ({ useUiStore: () => store,
  useWorkspaceStore: () => ({ workspaces: [{ id: 'ws-input', name: 'Input', path: '/workspace', openedAt: 1 }] }) }));
vi.mock('../../src/renderer/src/components/TerminalView', () => ({
  TerminalView: ({ onAnnotateSelection, onBlankPointerDown, onScanControl, onScanStateChange, onScanEscape, prepareScanCapture }: {
    onAnnotateSelection: (text: string) => void; onScanControl: (request: typeof scanHarness.request | null) => void;
    onBlankPointerDown: (event: React.PointerEvent<HTMLDivElement>, remainsBlank: () => boolean) => void;
    onScanStateChange: (active: boolean) => void; onScanEscape: () => boolean; prepareScanCapture: () => () => void;
  }) => {
    React.useEffect(() => { onScanControl(scanHarness.request); return () => onScanControl(null); }, [onScanControl]);
    scanHarness.prepare = prepareScanCapture; scanHarness.escape = onScanEscape; scanHarness.state = onScanStateChange;
    return <><button type="button" onClick={() => onAnnotateSelection('终端选区')}>选取终端文本</button>
      <div data-testid="terminal-blank" onPointerDown={event => onBlankPointerDown(event, () => holdHarness.blank)} />
      <div className="term-scan-mask" data-testid="scan-layer" /></>;
  }
}));
import { CliSessionView } from '../../src/renderer/src/components/CliSessionView';

const session: SessionMeta = { id: 'cli-test', name: 'CLI', type: 'terminal', launchKind: 'agent',
  runtime: 'opencode', status: 'running', createdAt: 1, lastUsedAt: 1,
  cliSuggestedReplies: { messageId: 'one', replies: ['第一条建议', '第二条建议'] } };

beforeEach(() => {
  clearDraft('cli-session:cli-test');
  localStorage.removeItem('muster.cli-notes.v1:cli-test');
  localStorage.removeItem('muster.cli-composer-position:cli-test');
  localStorage.removeItem('muster.cli-composer-size:cli-test');
  localStorage.setItem('muster.cli-composer-collapsed:cli-test', '0');
  store.flashTip.mockClear();
  scanHarness.request.mockClear();
  holdHarness.blank = true;
  if (typeof document.execCommand !== 'function') document.execCommand = () => false;
  if (typeof Element.prototype.scrollIntoView !== 'function') Element.prototype.scrollIntoView = () => {};
  // Node can expose PointerEvent even when the jsdom window does not. Use the
  // window's MouseEvent so Testing Library emits real pointer coordinates.
  class TestPointerEvent extends window.MouseEvent {
    pointerId: number; isPrimary: boolean; pointerType: string;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init); this.pointerId = init.pointerId ?? 1;
      this.isPrimary = init.isPrimary ?? true; this.pointerType = init.pointerType ?? 'mouse';
    }
  }
  vi.stubGlobal('PointerEvent', TestPointerEvent);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('CLI 终端悬浮输入区', () => {
  it('待办按钮位于输入底栏，面板挂在防裁切浮层，收起时关闭', async () => {
    const api = currentApiMock();
    api.override('sessionReminders.list', async () => ({ scope: 'cli-scope', items: [{ id: 'r', text: '确认 CLI 操作',
      createdAt: 1, completedAt: null, completedBy: null, sourceMessageId: null }] }));
    const user = userEvent.setup();
    const view = render(<CliSessionView session={session} visible/>);
    const trigger = screen.getByRole('button', { name: '用户待办提醒' });
    expect(trigger.closest('.agent-composer-toolbar')).toBeTruthy();
    await waitFor(() => expect(trigger.textContent).toContain('1'));
    expect(api.mockOf('sessionReminders.list')).toHaveBeenCalledWith({ kind: 'session', sessionId: 'cli-test' });
    await user.click(trigger);
    const panel = screen.getByRole('dialog', { name: '用户待办提醒' });
    expect(panel.parentElement).toBe(view.container.querySelector('.cli-reminder-popover'));
    expect(screen.getByRole('checkbox', { name: '标记完成：确认 CLI 操作' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '收起输入框' }));
    expect(screen.queryByRole('button', { name: '用户待办提醒' })).toBeNull();
    expect(screen.queryByRole('dialog', { name: '用户待办提醒' })).toBeNull();
    await user.click(screen.getByRole('button', { name: '展开输入框' }));
    expect(screen.getByRole('button', { name: '用户待办提醒' }).getAttribute('aria-expanded')).toBe('false');
  });
  it('将分屏几何应用到 CLI 外层，同时保留同一个终端', () => {
    const view = render(<CliSessionView session={session} visible style={{ left: 0, width: 400, height: 600 }} />);
    const host = view.container.querySelector<HTMLElement>('.cli-session-view')!;
    const terminal = screen.getByTestId('terminal-blank');
    expect(host.style.width).toBe('400px'); expect(host.style.height).toBe('600px');
    view.rerender(<CliSessionView session={session} visible style={{ left: 400, width: 400, height: 600 }} />);
    expect(host.style.left).toBe('400px'); expect(screen.getByTestId('terminal-blank')).toBe(terminal);
  });
  it('左右侧边只调整宽度，并在折叠、重挂和窗口缩放后保留', async () => {
    let viewWidth = 800;
    const rect = (width: number, height: number) => ({ x: 0, y: 0, left: 0, top: 0, right: width, bottom: height,
      width, height, toJSON: () => ({}) }) as DOMRect;
    const previous = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('cli-session-view')) return rect(viewWidth, 600);
      if (this.classList.contains('cli-composer-capsule')) return rect(120, 32);
      if (this.classList.contains('cli-composer-dialog')) return rect(784, 200);
      return previous.call(this);
    });
    const view = render(<CliSessionView session={session} visible />);
    const dialog = screen.getByRole('dialog', { name: '输入框' });
    const handle = screen.getByRole('button', { name: '拖动左侧边缘调整宽度（左右方向键微调）' });
    expect(handle.closest('.cli-composer-dialog')).toBe(dialog);
    expect(dialog.style.top).toBe('392px');
    fireEvent.pointerDown(handle, { button: 0, pointerId: 31, clientX: 8, clientY: 392 });
    fireEvent.pointerMove(handle, { button: 0, pointerId: 31, clientX: 8, clientY: 320 });
    expect(dialog.style.width).toBe('');
    expect(dialog.style.height).toBe('');
    fireEvent.pointerMove(handle, { button: 0, pointerId: 31, clientX: 200, clientY: 320 });
    expect(dialog.style.width).toBe('592px');
    expect(dialog.style.height).toBe('');
    expect(dialog.style.top).toBe('392px');
    fireEvent.pointerUp(handle, { button: 0, pointerId: 31, clientX: 200, clientY: 320 });
    expect(JSON.parse(localStorage.getItem('muster.cli-composer-size:cli-test')!))
      .toEqual({ width: 592, bottomOffset: 16, rightInset: 0 });
    const rightHandle = screen.getByRole('button', { name: '拖动右侧边缘调整宽度（左右方向键微调）' });
    fireEvent.pointerDown(rightHandle, { button: 0, pointerId: 35, clientX: 792, clientY: 450 });
    fireEvent.pointerMove(rightHandle, { button: 0, pointerId: 35, clientX: 722, clientY: 410 });
    expect(dialog.style.width).toBe('522px');
    expect(dialog.style.right).toBe('78px');
    expect(dialog.style.height).toBe('');
    fireEvent.pointerMove(rightHandle, { button: 0, pointerId: 35, clientX: 792, clientY: 410 });
    fireEvent.pointerUp(rightHandle, { button: 0, pointerId: 35, clientX: 792, clientY: 410 });
    expect(dialog.style.width).toBe('592px');
    expect(dialog.style.right).toBe('8px');
    fireEvent.click(screen.getByRole('button', { name: '收起输入框' }));
    fireEvent.click(screen.getByRole('button', { name: '展开输入框' }));
    expect(dialog.style.width).toBe('592px');
    expect(dialog.style.height).toBe('');
    view.unmount();
    const restored = render(<CliSessionView session={session} visible />);
    const restoredDialog = restored.container.querySelector<HTMLElement>('.cli-composer-dialog')!;
    expect(restoredDialog.style.width).toBe('592px');
    expect(restoredDialog.style.height).toBe('');
    expect(restoredDialog.style.top).toBe('392px');
    viewWidth = 400;
    fireEvent(window, new Event('resize'));
    expect(restoredDialog.style.width).toBe('384px');
    expect(JSON.parse(localStorage.getItem('muster.cli-composer-size:cli-test')!).width).toBe(592);
    viewWidth = 800;
    fireEvent(window, new Event('resize'));
    expect(restoredDialog.style.width).toBe('592px');
    const moveHandle = screen.getByRole('button', { name: '拖动输入框' });
    fireEvent.pointerDown(moveHandle, { button: 0, pointerId: 34, clientX: 780, clientY: 500 });
    fireEvent.pointerMove(moveHandle, { button: 0, pointerId: 34, clientX: 680, clientY: 500 });
    await waitFor(() => expect(restoredDialog.style.right).toBe('108px'));
    fireEvent.pointerUp(moveHandle, { button: 0, pointerId: 34, clientX: 680, clientY: 500 });
    expect(JSON.parse(localStorage.getItem('muster.cli-composer-size:cli-test')!).rightInset).toBe(100);
    expect(restoredDialog.style.right).toBe('108px');
  });

  it('取消拖动恢复宽度，只有左右方向键调整，把手不改变草稿', () => {
    const rect = (width: number, height: number) => ({ x: 0, y: 0, left: 0, top: 0, right: width, bottom: height,
      width, height, toJSON: () => ({}) }) as DOMRect;
    const previous = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('cli-session-view')) return rect(800, 600);
      if (this.classList.contains('cli-composer-capsule')) return rect(120, 32);
      if (this.classList.contains('cli-composer-dialog')) return rect(784, 200);
      return previous.call(this);
    });
    const view = render(<CliSessionView session={session} visible />);
    const dialog = screen.getByRole('dialog', { name: '输入框' });
    const handle = screen.getByRole('button', { name: '拖动左侧边缘调整宽度（左右方向键微调）' });
    const editor = view.container.querySelector<HTMLElement>('.composer-editable')!;
    fireEvent.input(editor, { target: { textContent: '保留草稿' } });
    fireEvent.pointerDown(handle, { button: 0, pointerId: 32, clientX: 8, clientY: 392 });
    fireEvent.pointerMove(handle, { button: 0, pointerId: 32, clientX: 700, clientY: 700 });
    expect(dialog.style.width).toBe('240px');
    expect(dialog.style.height).toBe('');
    fireEvent.pointerCancel(handle, { pointerId: 32 });
    expect(dialog.style.width).toBe('');
    expect(localStorage.getItem('muster.cli-composer-size:cli-test')).toBeNull();
    fireEvent.pointerDown(handle, { button: 0, pointerId: 33, clientX: 8, clientY: 392 });
    fireEvent.pointerMove(handle, { button: 0, pointerId: 33, clientX: 200, clientY: 320 });
    fireEvent(window, new Event('blur'));
    expect(dialog.style.width).toBe('');
    expect(localStorage.getItem('muster.cli-composer-size:cli-test')).toBeNull();
    fireEvent.keyDown(handle, { key: 'ArrowUp' });
    expect(dialog.style.width).toBe('');
    expect(localStorage.getItem('muster.cli-composer-size:cli-test')).toBeNull();
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(dialog.style.width).toBe('768px');
    expect(dialog.style.height).toBe('');
    expect(dialog.style.top).toBe('392px');
    const rightHandle = screen.getByRole('button', { name: '拖动右侧边缘调整宽度（左右方向键微调）' });
    fireEvent.keyDown(rightHandle, { key: 'ArrowLeft' });
    expect(dialog.style.width).toBe('752px');
    expect(dialog.style.right).toBe('24px');
    fireEvent.keyDown(rightHandle, { key: 'ArrowRight' });
    expect(JSON.parse(localStorage.getItem('muster.cli-composer-size:cli-test')!))
      .toEqual({ width: 768, bottomOffset: 16, rightInset: 0 });
    expect(editor.textContent).toContain('保留草稿');
  });

  it('旧版固定高度不再锁住输入框，但保留已调整的宽度和位置', () => {
    localStorage.setItem('muster.cli-composer-size:cli-test', JSON.stringify({
      width: 500, height: 144, bottomOffset: 16, rightInset: 40
    }));
    const view = render(<CliSessionView session={session} visible />);
    const dialog = view.container.querySelector<HTMLElement>('.cli-composer-dialog')!;
    expect(dialog.style.width).toBe('500px');
    expect(dialog.style.right).toBe('48px');
    expect(dialog.style.height).toBe('');
  });

  it('清除只作用于当前建议，关闭后不再呼吸，新建议仍能出现', async () => {
    const mock = currentApiMock();
    mock.override('suggestions.clear', async () => ({ ok: true, cleared: true }));
    const view = render(<CliSessionView session={session} visible />);
    const row = await screen.findByRole('group', { name: '建议回复' });
    const clear = screen.getByRole('button', { name: '清除本轮建议' });
    expect(row.lastElementChild).toBe(clear);
    fireEvent.click(clear);
    await waitFor(() => expect(mock.mockOf('suggestions.clear')).toHaveBeenCalledWith({
      kind: 'cli', targetId: 'cli-test', messageId: 'one', replies: ['第一条建议', '第二条建议']
    }));
    expect(view.container.querySelector('.composer-ghost-suggestion')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '收起输入框' }));
    expect(screen.getByRole('button', { name: '展开输入框' }).classList.contains('has-suggestions')).toBe(false);
    view.rerender(<CliSessionView session={{ ...session, cliSuggestedReplies: { messageId: 'two', replies: ['新的建议'] } }} visible />);
    expect(screen.getByRole('button', { name: '展开输入框' }).classList.contains('has-suggestions')).toBe(true);
  });

  it('清除失败会恢复建议并显示错误', async () => {
    const mock = currentApiMock();
    mock.override('suggestions.clear', async () => ({ ok: false, error: '写入失败' }));
    render(<CliSessionView session={session} visible />);
    fireEvent.click(screen.getByRole('button', { name: '清除本轮建议' }));
    expect((await findAppTip()).textContent).toContain('写入失败');
    expect(await screen.findByRole('button', { name: '第一条建议' })).toBeTruthy();
    expect(mock.mockOf('pty.submitComposer')).not.toHaveBeenCalled();
  });

  it('清除请求在途时出现的新建议不会被旧请求隐藏', async () => {
    let resolve!: (result: { ok: boolean; cleared: boolean }) => void;
    currentApiMock().override('suggestions.clear', () => new Promise(res => { resolve = res; }));
    const view = render(<CliSessionView session={session} visible />);
    fireEvent.click(screen.getByRole('button', { name: '清除本轮建议' }));
    view.rerender(<CliSessionView session={{ ...session, cliSuggestedReplies: { messageId: 'two', replies: ['新一轮'] } }} visible />);
    expect(await screen.findByRole('button', { name: '新一轮' })).toBeTruthy();
    await act(async () => resolve({ ok: true, cleared: false }));
    expect(screen.getByRole('button', { name: '新一轮' })).toBeTruthy();
  });

  it('加号菜单复用共享快捷短语面板，选择后回填当前 CLI 输入框', async () => {
    localStorage.setItem('muster.quick-phrases.v1', JSON.stringify([{ id: 'p1', key: '摘要', value: '请整理结论', ts: 1 }]));
    const user = userEvent.setup();
    const view = render(<CliSessionView session={session} visible />);
    await user.click(screen.getByRole('button', { name: '添加附件' }));
    expect(screen.getByRole('menu').closest('.cli-composer-popover')).not.toBeNull();
    await user.click(screen.getByRole('menuitem', { name: /命令 \/ 技能/ }));
    fireEvent.mouseDown(await screen.findByRole('option', { name: /\/quickInput/ }));
    const phrase = await screen.findByRole('option', { name: /摘要/ });
    fireEvent.mouseDown(phrase);
    expect(view.container.querySelector('.composer-editable')?.textContent).toBe('请整理结论');
    localStorage.removeItem('muster.quick-phrases.v1');
  });

  it('加号菜单可调用已配置的系统快捷操作，并显示执行失败', async () => {
    const mock = currentApiMock();
    mock.override('config.get', async () => ({ systemShortcuts: [{ id: 'shot', name: '截图', chord: 'ctrl+alt+a' }] }));
    mock.override('app.runSystemShortcut', async () => ({ ok: false, error: '快捷键不可用' }));
    render(<CliSessionView session={session} visible />);
    fireEvent.click(screen.getByRole('button', { name: '添加附件' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /截图/ }));
    expect((await screen.findByRole('alert')).textContent).toContain('快捷键不可用');
    expect(mock.mockOf('app.runSystemShortcut')).toHaveBeenCalledWith('shot');
  });

  it('技能选择沿用共享候选，按当前 CLI 加载并发送明确的技能文件路径', async () => {
    const mock = currentApiMock();
    mock.override('agent.listSkills', async () => ({ skills: [{ name: 'review', description: '审查', filePath: '/workspace/.agents/skills/review/SKILL.md' }] }));
    mock.override('pty.submitComposer', async () => ({ ok: true }));
    const view = render(<CliSessionView session={{ ...session, workspaceId: 'ws-input' }} skillTarget="fixture-cli" visible />);
    const editor = view.container.querySelector<HTMLElement>('.composer-editable')!;
    editor.focus(); editor.textContent = '/review';
    const range = document.createRange(); range.selectNodeContents(editor); range.collapse(false);
    window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
    fireEvent.input(editor);
    const item = await screen.findByRole('option', { name: /\/skill:review/ });
    expect(mock.mockOf('agent.listSkills')).toHaveBeenCalledWith('ws-input', 'fixture-cli', 'cli-test');
    fireEvent.mouseDown(item);
    expect(editor.querySelector('.composer-token-label')?.textContent).toBe('/skill:review');
    expect(editor.querySelector('.composer-token')?.getAttribute('data-token')).toContain('/workspace/.agents/skills/review/SKILL.md');
    fireEvent.keyDown(editor, { key: 'Enter' });
    await waitFor(() => expect(mock.mockOf('pty.submitComposer')).toHaveBeenCalledWith('cli-test',
      expect.stringContaining('/workspace/.agents/skills/review/SKILL.md')));
  });

  it('opens the Harness picker from managed CLI without submitting the local command to the PTY', async () => {
    const mock = currentApiMock();
    const targetRef = 'wr1.' + 'b'.repeat(32);
    const runtime = { id: 'pi', label: 'Muster Core', enabled: true, builtin: true, kind: 'gui', surface: 'chat' };
    mock.override('runtimes.list', async () => [runtime]);
    mock.override('runtimes.availability', async () => ({ checkedAt: 1, runtimes: [runtime], acpAgents: [] }));
    mock.override('agent.listSkills', async () => ({ skills: [] }));
    mock.override('config.get', async () => ({ llm: { providers: [{ id: 'provider', name: 'Account',
      models: [{ id: 'model', name: 'Delegation model' }] }] } }));
    mock.override('agentSession.describeModelParameters', async ({ providerId, modelId }) =>
      ({ runtimeId: 'pi', providerId, modelId, parameters: [] }));
    mock.override('agentSession.listHarnessPickerChoices', async () => ({ checkedAt: 1, choices: [
      { harnessId: 'muster-core', runtimeId: 'pi', surface: 'gui', label: 'Muster Core', available: true, status: 'available' }
    ] }));
    mock.override('agentSession.readHarnessPickerCatalog', async request => pickerCatalog(request, {
      models: [{ providerId: 'provider', modelId: 'model', label: 'Account · Delegation model' }]
    }));
    mock.override('workerRouting.reference', async ({ config }) => ({ targetRef, config }));
    mock.override('pty.submitComposer', async () => ({ ok: true }));
    const view = render(<CliSessionView session={{ ...session, workspaceId: 'ws-input' }} visible />);
    const editor = view.container.querySelector<HTMLElement>('.composer-editable')!;
    editor.focus(); editor.textContent = '/harness';
    const range = document.createRange(); range.selectNodeContents(editor); range.collapse(false);
    window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
    fireEvent.input(editor);
    await screen.findByRole('option', { name: /\/harness/ });
    fireEvent.keyDown(editor, { key: 'Enter' });
    const dialog = await screen.findByRole('dialog', { name: '插入模型引用' });
    fireEvent.keyDown(within(dialog).getByRole('searchbox'), { key: 'Escape' });
    expect(editor.textContent).toBe('/harness');
    expect(document.activeElement).toBe(editor);
    expect(mock.mockOf('pty.submitComposer')).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    const reopened = await screen.findByRole('dialog', { name: '插入模型引用' });
    fireEvent.click(await within(reopened).findByRole('tab', { name: 'Muster Core' }));
    fireEvent.click(await within(reopened).findByRole('option', { name: 'Account · Delegation model' }));
    const insert = within(reopened).getByRole<HTMLButtonElement>('button', { name: '插入引用' });
    await waitFor(() => expect(insert.disabled).toBe(false));
    fireEvent.click(insert);
    const chip = await within(editor).findByRole('button', { name: /Account · Delegation model/ });
    expect(workerModelMentions(chip.closest('.composer-token')?.getAttribute('data-token') ?? '')[0]?.mention.targetRef).toBe(targetRef);
    expect(editor.textContent).not.toContain('/harness');
    expect(mock.mockOf('pty.submitComposer')).not.toHaveBeenCalled();
  });

  it('工作区文件候选和工作台拖放保留带空格的完整路径', async () => {
    const mock = currentApiMock();
    mock.override('workspaces.listFiles', async () => ({ rootsRevision: 0, files: [{ path: 'my file.ts', absolutePath: '/workspace/my file.ts' }] }));
    mock.override('fs.cancelQuery', async () => ({}));
    const view = render(<CliSessionView session={{ ...session, workspaceId: 'ws-input' }} visible />);
    const editor = view.container.querySelector<HTMLElement>('.composer-editable')!;
    editor.focus(); editor.textContent = '@my';
    const range = document.createRange(); range.selectNodeContents(editor); range.collapse(false);
    window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
    fireEvent.input(editor);
    fireEvent.mouseDown(await screen.findByRole('option', { name: /@my file.ts/ }));
    expect(editor.querySelector('.composer-token')?.getAttribute('data-token')).toBe('[File: "/workspace/my file.ts"]');
    fireEvent.drop(view.container.querySelector('.cli-composer')!, { dataTransfer: {
      types: ['application/x-muster-paths'], files: [], getData: (type: string) => type === 'application/x-muster-paths' ? '["/workspace/other file.txt"]' : ''
    } });
    expect(editor.textContent).toContain('[File: "/workspace/other file.txt"]');
  });

  it('旧文件候选缺少完整路径时提示重启，不插入可能指向错误位置的相对路径', async () => {
    const mock = currentApiMock();
    mock.override('workspaces.listFiles', async () => ({ rootsRevision: 0, files: [{ path: 'legacy.ts' }] }));
    mock.override('fs.cancelQuery', async () => ({}));
    const view = render(<CliSessionView session={{ ...session, workspaceId: 'ws-input' }} visible />);
    const editor = view.container.querySelector<HTMLElement>('.composer-editable')!;
    editor.focus(); editor.textContent = '@legacy';
    const range = document.createRange(); range.selectNodeContents(editor); range.collapse(false);
    window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
    fireEvent.input(editor);
    fireEvent.mouseDown(await screen.findByRole('option', { name: /@legacy.ts/ }));
    expect(editor.querySelector('.composer-token')).toBeNull();
    expect(mock.mockOf('notify.toast')).toHaveBeenCalledWith({ text: '文件完整路径不可用，请完全重启应用后重试' });
  });

  it('文件路径包含批注字样时重建草稿仍完整保留', async () => {
    const instance = { ...session, id: 'cli-path-test', cliSuggestedReplies: undefined };
    localStorage.setItem('muster.cli-composer-collapsed:cli-path-test', '0');
    clearDraft('cli-session:cli-path-test');
    const view = render(<CliSessionView session={instance} visible />);
    fireEvent.drop(view.container.querySelector('.cli-composer')!, { dataTransfer: {
      types: ['application/x-muster-paths'], files: [], getData: (type: string) => type === 'application/x-muster-paths' ? '["/workspace/批注1.md"]' : ''
    } });
    expect(view.container.querySelector('.composer-editable')?.textContent).toContain('/workspace/批注1.md');
    view.unmount();
    const restored = render(<CliSessionView session={instance} visible />);
    await waitFor(() => expect(restored.container.querySelector('.composer-editable')?.textContent).toContain('/workspace/批注1.md'));
    clearDraft('cli-session:cli-path-test');
  });

  it('图片粘贴作为附件保留，失败可重试，只有附件也能提交', async () => {
    const mock = currentApiMock();
    mock.override('pty.submitComposer', async () => ({ ok: false, error: '附件不可读' }));
    const instance = { ...session, id: 'cli-image-test', cliSuggestedReplies: undefined };
    localStorage.setItem('muster.cli-composer-collapsed:cli-image-test', '0');
    const view = render(<CliSessionView session={instance} visible />);
    const editor = view.container.querySelector<HTMLElement>('.composer-editable')!;
    const image = new File(['image bytes'], 'clip.png', { type: 'image/png' });
    fireEvent.paste(editor, { clipboardData: { items: [{ kind: 'file', getAsFile: () => image }], getData: () => '' } });
    await waitFor(() => expect(screen.getByAltText('clip.png')).toBeTruthy());
    fireEvent.keyDown(editor, { key: 'Enter' });
    expect((await findAppTip()).textContent).toContain('附件不可读');
    expect(screen.getByAltText('clip.png')).toBeTruthy();
    view.unmount();
    const restored = render(<CliSessionView session={instance} visible />);
    expect(await screen.findByAltText('clip.png')).toBeTruthy();
    mock.override('pty.submitComposer', async () => ({ ok: true }));
    fireEvent.keyDown(restored.container.querySelector<HTMLElement>('.composer-editable')!, { key: 'Enter' });
    await waitFor(() => expect(mock.mockOf('pty.submitComposer')).toHaveBeenLastCalledWith('cli-image-test', '',
      [expect.objectContaining({ name: 'clip.png', mimeType: 'image/png', data: expect.any(String) })]));
    await waitFor(() => expect(screen.queryByAltText('clip.png')).toBeNull());
  });

  it('CLI 原生命令和前后空白原样发送', async () => {
    const mock = currentApiMock();
    mock.override('pty.submitComposer', async () => ({ ok: true }));
    const view = render(<CliSessionView session={session} visible />);
    const editor = view.container.querySelector<HTMLElement>('.composer-editable')!;
    editor.focus(); editor.textContent = '  /help  '; fireEvent.input(editor);
    fireEvent.keyDown(editor, { key: 'Enter' });
    await waitFor(() => expect(mock.mockOf('pty.submitComposer')).toHaveBeenCalledWith('cli-test', '  /help  '));
  });

  it('退场期间保留缩放外壳，快速重开不会被旧计时器隐藏', () => {
    vi.useFakeTimers();
    localStorage.removeItem('muster.cli-composer-collapsed:cli-test');
    const view = render(<CliSessionView session={session} visible />);
    const dialog = view.container.querySelector<HTMLElement>('.cli-composer-dialog')!;
    const capsuleShell = view.container.querySelector<HTMLElement>('.cli-composer-capsule-shell')!;
    expect(dialog.dataset.morphActive).toBe('false');
    expect(capsuleShell.dataset.morphActive).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: '展开输入框' }));
    expect(dialog.dataset.morphActive).toBe('true');
    expect(dialog.dataset.mpStage).toBe('in');
    expect(capsuleShell.dataset.morphActive).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: '收起输入框' }));
    expect(dialog.dataset.morphActive).toBe('true');
    expect(dialog.dataset.mpStage).toBe('out');
    fireEvent.click(screen.getByRole('button', { name: '展开输入框' }));
    expect(dialog.dataset.mpStage).toBe('in');
    act(() => vi.advanceTimersByTime(MOTION.exitMs + MOTION.microMs));
    expect(dialog.dataset.morphActive).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: '收起输入框' }));
    expect(dialog.dataset.morphActive).toBe('true');
    act(() => vi.advanceTimersByTime(MOTION.exitMs + MOTION.microMs));
    expect(dialog.dataset.morphActive).toBe('false');
    expect(capsuleShell.dataset.morphActive).toBe('false');
  });

  it('拖动松手贴边且不误展开，重新挂载恢复位置；点击后以胶囊纵向位置展开', async () => {
    localStorage.removeItem('muster.cli-composer-collapsed:cli-test');
    const rect = (width: number, height: number) => ({ x: 0, y: 0, left: 0, top: 0, right: width, bottom: height,
      width, height, toJSON: () => ({}) }) as DOMRect;
    const previous = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('cli-session-view')) return rect(800, 600);
      if (this.classList.contains('cli-composer-capsule')) return rect(120, 32);
      if (this.classList.contains('cli-composer-dialog')) return rect(784, 200);
      return previous.call(this);
    });
    const user = userEvent.setup();
    const view = render(<CliSessionView session={session} visible />);
    const capsule = screen.getByRole('button', { name: '展开输入框' });
    const handle = screen.getByRole('button', { name: '拖动输入框' });
    expect(handle.parentElement?.lastElementChild).toBe(handle);
    expect(view.container.textContent).not.toContain('工作台输入');
    expect(capsule.classList.contains('has-suggestions')).toBe(true);
    fireEvent.pointerDown(handle, { button: 0, pointerId: 7, clientX: 732, clientY: 576 });
    fireEvent.pointerMove(handle, { button: 0, pointerId: 7, clientX: 20, clientY: 250 });
    fireEvent.pointerUp(handle, { button: 0, pointerId: 7, clientX: 20, clientY: 250 });
    fireEvent.click(handle); // 浏览器拖动结束后可能仍派发 click
    expect(capsule.getAttribute('aria-expanded')).toBe('false');
    expect(JSON.parse(localStorage.getItem('muster.cli-composer-position:cli-test')!)).toMatchObject({ edge: 'left' });
    const capsuleY = (container: HTMLElement): number => {
      const transform = container.querySelector<HTMLElement>('.cli-composer-capsule')!.style.transform;
      const match = /^translate\(([-\d.]+)px, ([-\d.]+)px\)$/.exec(transform);
      expect(Number(match?.[1])).toBeCloseTo(8);
      return Number(match?.[2]);
    };
    expect(capsuleY(view.container)).toBeCloseTo(234);
    await user.click(capsule);
    const dialog = screen.getByRole('dialog', { name: '输入框' });
    expect(dialog.style.top).toBe('150px');
    await user.click(screen.getByRole('button', { name: '收起输入框' }));
    view.unmount();
    const restored = render(<CliSessionView session={session} visible />);
    expect(capsuleY(restored.container)).toBeCloseTo(234);
  });

  it('仅有建议时对展开图标启用呼吸提示', () => {
    localStorage.removeItem('muster.cli-composer-collapsed:cli-test');
    const view = render(<CliSessionView session={{ ...session, cliSuggestedReplies: undefined }} visible />);
    const capsule = screen.getByRole('button', { name: '展开输入框' });
    expect(capsule.classList.contains('has-suggestions')).toBe(false);
    view.rerender(<CliSessionView session={session} visible />);
    expect(capsule.classList.contains('has-suggestions')).toBe(true);
    expect(capsule.querySelector('.cli-composer-expand-icon')).not.toBeNull();
    view.rerender(<CliSessionView session={{ ...session, cliSuggestedReplies: undefined }} visible />);
    expect(capsule.classList.contains('has-suggestions')).toBe(false);
  });

  it('终端空白长按先预览，提前松手恢复；继续按住才提交展开并切换图标', () => {
    vi.useFakeTimers();
    localStorage.removeItem('muster.cli-composer-collapsed:cli-test');
    const view = render(<CliSessionView session={session} visible />);
    const blank = screen.getByTestId('terminal-blank');
    const host = view.container.querySelector<HTMLElement>('.cli-session-view')!;
    const dialog = view.container.querySelector<HTMLElement>('.cli-composer-dialog')!;
    const down = () => createEvent.pointerDown(blank, { button: 0, buttons: 1, pointerType: 'mouse',
      pointerId: 21, isPrimary: true, clientX: 20, clientY: 20, cancelable: true });
    const first = down(); fireEvent(blank, first);
    expect(first.defaultPrevented).toBe(false);
    act(() => vi.advanceTimersByTime(MOTION.panelMs));
    expect(host.dataset.holdPhase).toBe('opening');
    expect(dialog.getAttribute('data-mp-stage')).toBe('in');
    expect(dialog.getAttribute('aria-hidden')).toBe('true');
    expect(localStorage.getItem('muster.cli-composer-collapsed:cli-test')).toBeNull();
    act(() => vi.advanceTimersByTime(MOTION.panelMs));
    expect(host.dataset.holdPhase).toBe('charging');
    expect(host.dataset.holdStep).toBe('0');
    expect(dialog.querySelector('.cli-composer-state-icon.is-charging')?.getAttribute('data-state')).toBe('expand');
    expect(dialog.querySelector('.cli-composer-panel-charge')).not.toBeNull();
    for (const step of ['1', '2', '3', '4', '5', '6', '7']) {
      act(() => vi.advanceTimersByTime(MOTION.breathMs / 3 / 8));
      expect(host.dataset.holdStep).toBe(step);
    }
    act(() => vi.advanceTimersByTime(MOTION.breathMs / 3 / 8 - 1));
    expect(host.dataset.holdPhase).toBe('charging');
    fireEvent.pointerUp(window, { button: 0, pointerId: 21, pointerType: 'mouse' });
    expect(host.dataset.holdPhase).toBeUndefined();
    expect(host.dataset.holdStep).toBeUndefined();
    expect(dialog.getAttribute('data-mp-stage')).toBe('out');
    expect(localStorage.getItem('muster.cli-composer-collapsed:cli-test')).toBeNull();

    fireEvent(blank, down());
    act(() => vi.advanceTimersByTime(MOTION.panelMs * 2 + MOTION.breathMs / 3 - 1));
    expect(host.dataset.holdPhase).toBe('charging');
    expect(localStorage.getItem('muster.cli-composer-collapsed:cli-test')).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(host.dataset.holdPhase).toBe('committed');
    expect(localStorage.getItem('muster.cli-composer-collapsed:cli-test')).toBe('0');
    expect(dialog.querySelector('.cli-composer-state-icon')?.getAttribute('data-state')).toBe('shrink');
    expect(dialog.querySelector('.cli-composer-state-icon.is-charging')).toBeNull();
    fireEvent.pointerUp(window, { button: 0, pointerId: 21, pointerType: 'mouse' });
    expect(screen.getByRole('dialog', { name: '输入框' })).toBeTruthy();
  });

  it('展开态长按先预览收起，提前松手还原，按到阈值才正式收起', () => {
    vi.useFakeTimers();
    const view = render(<CliSessionView session={session} visible />);
    const blank = screen.getByTestId('terminal-blank');
    const host = view.container.querySelector<HTMLElement>('.cli-session-view')!;
    const shell = view.container.querySelector<HTMLElement>('.cli-composer-capsule-shell')!;
    const down = () => fireEvent.pointerDown(blank, { button: 0, buttons: 1, pointerType: 'mouse',
      pointerId: 22, isPrimary: true, clientX: 20, clientY: 20 });
    down();
    act(() => vi.advanceTimersByTime(MOTION.panelMs * 2));
    expect(host.dataset.holdPhase).toBe('charging');
    expect(shell.getAttribute('data-mp-stage')).toBe('in');
    expect(shell.querySelector('.cli-composer-state-icon.is-charging')?.getAttribute('data-state')).toBe('shrink');
    expect(shell.closest('.cli-composer-capsule-charge')).not.toBeNull();
    act(() => vi.advanceTimersByTime(MOTION.breathMs / 3 - 1));
    expect(host.dataset.holdStep).toBe('7');
    fireEvent.pointerUp(window, { button: 0, pointerId: 22, pointerType: 'mouse' });
    expect(screen.getByRole('dialog', { name: '输入框' })).toBeTruthy();
    expect(localStorage.getItem('muster.cli-composer-collapsed:cli-test')).toBe('0');

    down();
    act(() => vi.advanceTimersByTime(MOTION.panelMs * 2 + MOTION.breathMs / 3));
    expect(host.dataset.holdPhase).toBe('committed');
    expect(shell.querySelector('.cli-composer-state-icon')?.getAttribute('data-state')).toBe('expand');
    expect(localStorage.getItem('muster.cli-composer-collapsed:cli-test')).toBe('1');
    fireEvent.pointerUp(window, { button: 0, pointerId: 22, pointerType: 'mouse' });
    expect(screen.getByRole('button', { name: '展开输入框' })).toBeTruthy();
  });

  it('鼠标移动或终端内容变化会取消长按，不提交状态', () => {
    vi.useFakeTimers();
    localStorage.removeItem('muster.cli-composer-collapsed:cli-test');
    const view = render(<CliSessionView session={session} visible />);
    const blank = screen.getByTestId('terminal-blank');
    const host = view.container.querySelector<HTMLElement>('.cli-session-view')!;
    const down = () => fireEvent.pointerDown(blank, { button: 0, buttons: 1, pointerType: 'mouse',
      pointerId: 23, isPrimary: true, clientX: 20, clientY: 20 });
    down();
    act(() => vi.advanceTimersByTime(MOTION.panelMs));
    fireEvent.pointerMove(window, { pointerId: 23, pointerType: 'mouse', buttons: 1, clientX: 40, clientY: 20 });
    expect(host.dataset.holdPhase).toBeUndefined();
    act(() => vi.advanceTimersByTime(MOTION.panelMs * 2 + MOTION.breathMs / 3));
    expect(localStorage.getItem('muster.cli-composer-collapsed:cli-test')).toBeNull();
    down();
    act(() => vi.advanceTimersByTime(MOTION.panelMs));
    holdHarness.blank = false;
    act(() => vi.advanceTimersByTime(MOTION.panelMs));
    expect(host.dataset.holdPhase).toBeUndefined();
    expect(localStorage.getItem('muster.cli-composer-collapsed:cli-test')).toBeNull();
  });

  it('普通点击、滚轮和切出会话不会误提交长按状态', () => {
    vi.useFakeTimers();
    localStorage.removeItem('muster.cli-composer-collapsed:cli-test');
    const view = render(<CliSessionView session={session} visible />);
    const blank = screen.getByTestId('terminal-blank');
    const host = view.container.querySelector<HTMLElement>('.cli-session-view')!;
    const down = () => fireEvent.pointerDown(blank, { button: 0, buttons: 1, pointerType: 'mouse',
      pointerId: 24, isPrimary: true, clientX: 20, clientY: 20 });
    down();
    fireEvent.pointerUp(window, { button: 0, pointerId: 24, pointerType: 'mouse' });
    act(() => vi.advanceTimersByTime(MOTION.panelMs * 2 + MOTION.breathMs / 3));
    expect(host.dataset.holdPhase).toBeUndefined();
    down();
    act(() => vi.advanceTimersByTime(MOTION.panelMs));
    fireEvent.wheel(window);
    expect(host.dataset.holdPhase).toBeUndefined();
    down();
    act(() => vi.advanceTimersByTime(MOTION.panelMs));
    view.rerender(<CliSessionView session={session} visible={false} />);
    act(() => vi.advanceTimersByTime(MOTION.panelMs * 2 + MOTION.breathMs / 3));
    expect(host.dataset.holdPhase).toBeUndefined();
    expect(localStorage.getItem('muster.cli-composer-collapsed:cli-test')).toBeNull();
  });

  it('展开后从把手拖动输入框，靠边时也能立即跟手移动并保留位置', async () => {
    const rect = (width: number, height: number) => ({ x: 0, y: 0, left: 0, top: 0, right: width, bottom: height,
      width, height, toJSON: () => ({}) }) as DOMRect;
    const previous = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('cli-session-view')) return rect(800, 600);
      if (this.classList.contains('cli-composer-capsule')) return rect(120, 32);
      if (this.classList.contains('cli-composer-dialog')) return rect(784, 200);
      return previous.call(this);
    });
    const user = userEvent.setup();
    const view = render(<CliSessionView session={session} visible />);
    const dialog = screen.getByRole('dialog', { name: '输入框' });
    const handle = screen.getByRole('button', { name: '拖动输入框' });
    expect(handle.nextElementSibling).toBe(screen.getByRole('button', { name: '发送' }));
    expect(dialog.style.top).toBe('392px');
    fireEvent.pointerDown(handle, { button: 0, pointerId: 11, clientX: 780, clientY: 420 });
    fireEvent.pointerMove(handle, { button: 0, pointerId: 11, clientX: 780, clientY: 396 });
    await waitFor(() => expect(dialog.style.top).toBe('368px'));
    fireEvent.pointerUp(handle, { button: 0, pointerId: 11, clientX: 780, clientY: 396 });
    expect(JSON.parse(localStorage.getItem('muster.cli-composer-position:cli-test')!)).toMatchObject({ edge: 'right' });
    await user.click(screen.getByRole('button', { name: '收起输入框' }));
    const transform = view.container.querySelector<HTMLElement>('.cli-composer-capsule')?.style.transform;
    const position = /^translate\(([-\d.]+)px, ([-\d.]+)px\)$/.exec(transform ?? '');
    expect(Number(position?.[1])).toBeCloseTo(672);
    expect(Number(position?.[2])).toBeCloseTo(452);
  });

  it('展开态识屏、收起和拖动与发送共用底栏', () => {
    const view = render(<CliSessionView session={session} visible />);
    const dialog = screen.getByRole('dialog', { name: '输入框' });
    const toolbar = dialog.querySelector('.agent-composer-toolbar')!;
    const controls = ['识屏', '收起输入框', '拖动输入框', '发送'].map(name => screen.getByRole('button', { name }));
    expect(controls.every(control => toolbar.contains(control))).toBe(true);
    expect(Array.from(toolbar.querySelector('.cli-composer-actions')!.children)).toEqual(controls);
    expect(view.container.querySelector('.cli-composer-titlebar')).toBeNull();
  });

  it('识屏由胶囊或展开的输入框触发；点击识屏结果不收起输入框', async () => {
    localStorage.removeItem('muster.cli-composer-collapsed:cli-test');
    const user = userEvent.setup();
    render(<CliSessionView session={session} visible />);
    await user.click(screen.getByRole('button', { name: '识屏' }));
    expect(scanHarness.request).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: '展开输入框' }).getAttribute('aria-expanded')).toBe('false');
    act(() => scanHarness.state?.(true));
    expect(screen.getByRole('button', { name: '关闭识屏' }).getAttribute('aria-pressed')).toBe('true');
    await user.click(screen.getByRole('button', { name: '展开输入框' }));
    const editor = screen.getByRole('textbox');
    await waitFor(() => expect(document.activeElement).toBe(editor));
    fireEvent.pointerDown(screen.getByTestId('scan-layer'), { button: 0 });
    expect(screen.getByRole('dialog', { name: '输入框' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '关闭识屏' }));
    expect(scanHarness.request).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(document.activeElement).toBe(editor));
    act(() => { expect(scanHarness.escape?.()).toBe(true); });
    expect(screen.getByRole('button', { name: '展开输入框' })).toBeTruthy();
  });

  it('识屏截图临时排除悬浮层，并在并发及重复恢复时正确复原', () => {
    const view = render(<CliSessionView session={session} visible />);
    const host = view.container.querySelector('.cli-session-view')!;
    const finishA = scanHarness.prepare!(), finishB = scanHarness.prepare!();
    expect(host.classList.contains('is-scan-capturing')).toBe(true);
    finishA(); finishA();
    expect(host.classList.contains('is-scan-capturing')).toBe(true);
    finishB();
    expect(host.classList.contains('is-scan-capturing')).toBe(false);
  });

  it('展开和识屏按钮不能拖动，只有把手能拖动', () => {
    localStorage.removeItem('muster.cli-composer-collapsed:cli-test');
    render(<CliSessionView session={session} visible />);
    const scan = screen.getByRole('button', { name: '识屏' });
    fireEvent.pointerDown(scan, { button: 0, pointerId: 10, clientX: 20, clientY: 20 });
    fireEvent.pointerMove(scan, { button: 0, pointerId: 10, clientX: 80, clientY: 120 });
    fireEvent.pointerUp(scan, { button: 0, pointerId: 10, clientX: 80, clientY: 120 });
    const expand = screen.getByRole('button', { name: '展开输入框' });
    fireEvent.pointerDown(expand, { button: 0, pointerId: 10, clientX: 20, clientY: 20 });
    fireEvent.pointerMove(expand, { button: 0, pointerId: 10, clientX: 80, clientY: 120 });
    fireEvent.pointerUp(expand, { button: 0, pointerId: 10, clientX: 80, clientY: 120 });
    expect(localStorage.getItem('muster.cli-composer-position:cli-test')).toBeNull();
    fireEvent.click(scan);
    expect(scanHarness.request).toHaveBeenCalledOnce();
  });

  it('拖动被系统取消时恢复原位置，不保存或误展开', () => {
    localStorage.removeItem('muster.cli-composer-collapsed:cli-test');
    render(<CliSessionView session={session} visible />);
    const capsule = screen.getByRole('button', { name: '展开输入框' });
    const handle = screen.getByRole('button', { name: '拖动输入框' });
    fireEvent.pointerDown(handle, { button: 0, pointerId: 8, clientX: 20, clientY: 20 });
    fireEvent.pointerMove(handle, { button: 0, pointerId: 8, clientX: 80, clientY: 120 });
    fireEvent.pointerCancel(handle, { button: 0, pointerId: 8, clientX: 80, clientY: 120 });
    fireEvent.click(handle);
    expect(capsule.getAttribute('aria-expanded')).toBe('false');
    expect(localStorage.getItem('muster.cli-composer-position:cli-test')).toBeNull();
  });

  it('本地位置保存失败时提示用户，并继续保留当前视图位置', () => {
    localStorage.removeItem('muster.cli-composer-collapsed:cli-test');
    render(<CliSessionView session={session} visible />);
    const capsule = screen.getByRole('button', { name: '展开输入框' });
    const handle = screen.getByRole('button', { name: '拖动输入框' });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    fireEvent.pointerDown(handle, { button: 0, pointerId: 9, clientX: 20, clientY: 20 });
    fireEvent.pointerMove(handle, { button: 0, pointerId: 9, clientX: 80, clientY: 120 });
    fireEvent.pointerUp(handle, { button: 0, pointerId: 9, clientX: 80, clientY: 120 });
    expect(store.flashTip).toHaveBeenCalledWith('胶囊位置无法保存，重新打开后可能恢复默认');
    expect(capsule.getAttribute('aria-expanded')).toBe('false');
  });

  it('默认收起，点终端不会收起；按 Esc 收起后保留草稿', async () => {
    localStorage.removeItem('muster.cli-composer-collapsed:cli-test');
    const user = userEvent.setup();
    const { container } = render(<CliSessionView session={session} visible />);
    expect(screen.getByRole('button', { name: '展开输入框' }).getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('.cli-composer-indicator')).toBeNull();
    await user.click(screen.getByRole('button', { name: '展开输入框' }));
    const editor = screen.getByRole('textbox');
    await waitFor(() => expect(document.activeElement).toBe(editor));
    await user.type(editor, '尚未发送的草稿');
    fireEvent.pointerDown(container.querySelector('.cli-terminal-surface')!, { button: 0 });
    expect(screen.getByRole('dialog', { name: '输入框' })).toBeTruthy();
    expect(editor.textContent).toBe('尚未发送的草稿');
    fireEvent.keyDown(editor, { key: 'Escape' });
    const toggle = screen.getByRole('button', { name: '展开输入框' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('.cli-composer-indicator')).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(toggle));
    await user.click(toggle);
    expect(editor.textContent).toBe('尚未发送的草稿');
  });

  it('点击终端不收起输入框，手动收起后仍保留未保存的批注', async () => {
    const user = userEvent.setup();
    const view = render(<CliSessionView session={session} visible />);
    await user.click(screen.getByRole('button', { name: '选取终端文本' }));
    const note = screen.getByRole('textbox', { name: '批注内容…' }) as HTMLTextAreaElement;
    await user.type(note, '尚未保存的批注');
    fireEvent.pointerDown(view.container.querySelector('.cli-terminal-surface')!, { button: 0 });
    expect(screen.getByRole('dialog', { name: '输入框' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '收起输入框' }));
    await user.click(screen.getByRole('button', { name: '展开输入框' }));
    expect(note.value).toBe('尚未保存的批注');
    await user.click(screen.getByRole('button', { name: '选取终端文本' }));
    expect(store.flashTip).toHaveBeenCalledWith('请先保存或取消当前批注');
    expect(note.value).toBe('尚未保存的批注');
  });

  it.each(['Enter', '发送按钮'])('%s 发送成功后输入框保持展开并清空已发送草稿', async method => {
    const mock = currentApiMock();
    mock.override('pty.submitComposer', async () => ({ ok: true }));
    const user = userEvent.setup();
    render(<CliSessionView session={session} visible />);
    const editor = screen.getByRole('textbox');
    await user.type(editor, '准备发送');
    if (method === 'Enter') fireEvent.keyDown(editor, { key: 'Enter' });
    else await user.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(mock.mockOf('pty.submitComposer')).toHaveBeenCalledWith('cli-test', '准备发送'));
    await waitFor(() => expect(editor.textContent).toBe(''));
    expect(screen.getByRole('dialog', { name: '输入框' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '收起输入框' })).toBeTruthy();
    expect(localStorage.getItem('muster.cli-composer-collapsed:cli-test')).toBe('0');
  });

  it.each([false, true])('发送期间手动收起，重新展开=%s 时保留用户选择', async reopen => {
    let resolveSend!: (result: { ok: boolean }) => void;
    currentApiMock().override('pty.submitComposer', () => new Promise(resolve => { resolveSend = resolve; }));
    const user = userEvent.setup();
    render(<CliSessionView session={session} visible />);
    const editor = screen.getByRole('textbox');
    await user.type(editor, '准备发送');
    fireEvent.keyDown(editor, { key: 'Enter' });
    await user.click(screen.getByRole('button', { name: '收起输入框' }));
    if (reopen) await user.click(screen.getByRole('button', { name: '展开输入框' }));
    await act(async () => resolveSend({ ok: true }));
    await waitFor(() => expect(editor.textContent).toBe(''));
    expect(screen.getByRole('button', { name: reopen ? '收起输入框' : '展开输入框' })).toBeTruthy();
    expect(localStorage.getItem('muster.cli-composer-collapsed:cli-test')).toBe(reopen ? '0' : '1');
  });
  it('切换建议并用 Tab 接受，Enter 才发送；空格草稿不出现灰字', async () => {
    currentApiMock().override('pty.submitComposer', async () => ({ ok: true }));
    const user = userEvent.setup();
    const { container } = render(<CliSessionView session={session} visible />);
    const editor = await screen.findByRole('textbox');
    await user.click(editor);
    expect(container.querySelector('.composer-ghost-suggestion')?.textContent).toBe('第一条建议');
    fireEvent.keyDown(editor, { key: 'Tab', shiftKey: true });
    expect(container.querySelector('.composer-ghost-suggestion')?.textContent).toBe('第二条建议');
    fireEvent.keyDown(editor, { key: 'Tab' });
    expect(editor.textContent).toBe('第二条建议');
    expect(currentApiMock().mockOf('pty.submitComposer')).not.toHaveBeenCalled();
    fireEvent.keyDown(editor, { key: 'Enter' });
    await waitFor(() => expect(currentApiMock().mockOf('pty.submitComposer')).toHaveBeenCalledWith('cli-test', '第二条建议'));
    await waitFor(() => expect(editor.textContent).toBe(''));
    expect(screen.getByRole('dialog', { name: '输入框' })).toBeTruthy();
    await user.type(editor, ' ');
    expect(container.querySelector('.composer-ghost-suggestion')).toBeNull();
  });

  it('终端批注在折叠、视图卸载重建后保留，并随草稿展开提交', async () => {
    currentApiMock().override('pty.submitComposer', async () => ({ ok: true }));
    const user = userEvent.setup();
    const view = render(<CliSessionView session={session} visible />);
    await user.click(screen.getByRole('button', { name: '选取终端文本' }));
    await user.type(screen.getByRole('textbox', { name: '批注内容…' }), '请修改此处');
    await user.click(screen.getByRole('button', { name: '收起输入框' }));
    await user.click(screen.getByRole('button', { name: '展开输入框' }));
    expect((screen.getByRole('textbox', { name: '批注内容…' }) as HTMLTextAreaElement).value).toBe('请修改此处');
    await user.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(view.container.querySelector('[data-token="批注1"]')).not.toBeNull());
    await user.click(screen.getByRole('button', { name: '收起输入框' }));
    expect(screen.getByRole('button', { name: '展开输入框' }).getAttribute('aria-expanded')).toBe('false');
    view.unmount();
    const next = render(<CliSessionView session={session} visible />);
    await user.click(screen.getByRole('button', { name: '展开输入框' }));
    const editor = next.container.querySelector<HTMLElement>('.composer-editable')!;
    await waitFor(() => expect(editor.querySelector('[data-token="批注1"]')).not.toBeNull());
    fireEvent.keyDown(editor, { key: 'Enter' });
    await waitFor(() => expect(currentApiMock().mockOf('pty.submitComposer')).toHaveBeenCalledWith('cli-test',
      expect.stringContaining('原文：“终端选区”；用户批注：请修改此处')));
  });

  it('文件、网页批注进入对应 CLI 草稿，失败时保留内容', async () => {
    currentApiMock().override('pty.submitComposer', async () => ({ ok: false, error: '终端未就绪' }));
    const view = render(<CliSessionView session={session} visible />);
    await waitFor(() => expect(deliverFileNote('cli-test', { noteId: 'file1', path: '/work/a', quote: '文件内容', note: '检查', line: 2, endLine: 2, markKey: null })).toBe(1));
    expect(deliverWebNote('cli-test', { noteId: 'web1', label: '标题', selector: '#h', url: 'https://example.com', note: '调整' })).toBe(2);
    const editor = view.container.querySelector<HTMLElement>('.composer-editable')!;
    await waitFor(() => expect(editor.querySelector('[data-token="批注2"]')).not.toBeNull());
    fireEvent.keyDown(editor, { key: 'Enter' });
    await findAppTip();
    expect(editor.querySelector('[data-token="批注1"]')).not.toBeNull();
    expect(editor.querySelector('[data-token="批注2"]')).not.toBeNull();
    expect(currentApiMock().mockOf('pty.submitComposer')).toHaveBeenCalledWith('cli-test', expect.stringContaining('[文件批注 /work/a:2]'));
  });
});
