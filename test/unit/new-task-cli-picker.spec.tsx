import { renderTask, enterTask } from './helpers/task-editor';
import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NewTaskDialog } from '../../src/renderer/src/components/NewTaskDialog';
import { HarnessModelPicker } from '../../src/renderer/src/components/HarnessModelPicker';
import type { AgentRuntimeEntry } from '../../src/shared/types';
import type { HarnessPickerChoice, HarnessPickerRequest, HarnessPickerResult } from '../../src/shared/harnessPicker';
import { resolveModelParameters } from '../../src/shared/modelParameters';
import { currentApiMock } from './helpers/api-mock';
import { pickerCatalog } from './helpers/picker-catalog';

const workspace = { id: 'picker-ws', name: 'Fixture', path: 'E:/fixture', openedAt: 1 };
const choices: HarnessPickerChoice[] = [
  { harnessId: 'codex', runtimeId: 'codex', surface: 'cli', label: 'Codex', available: true, status: 'available' },
  { harnessId: 'claude', runtimeId: 'claude-code', surface: 'cli', label: 'Claude Code', available: true, status: 'available' },
  { harnessId: 'cursor', runtimeId: 'cursor', surface: 'cli', label: 'Cursor', available: false, status: 'not_configured', warning: 'Sign in required' }
];
const runtimes = choices.slice(0, 2).map(choice => ({ id: choice.runtimeId, label: choice.label, surface: 'pty', enabled: true })) as AgentRuntimeEntry[];
const models = [{ providerId: 'claude', modelId: 'sonnet', label: 'Sonnet', nativeLaunchModel: 'sonnet' }];

beforeEach(() => {
  localStorage.clear();
  currentApiMock().override('sessions.precheck', async () => ({ dirty: false }));
  currentApiMock().override('runtimes.availability', async () => ({ runtimes, acpAgents: [], checkedAt: 1 }));
  currentApiMock().override('agentSession.listHarnessPickerChoices', async () => ({ choices, checkedAt: 1 }));
  currentApiMock().override('agentSession.readHarnessPickerCatalog', async request => pickerCatalog(request, { models }));
});

it('offers model references in a single-root workspace saved without a roots revision', async () => {
  renderTask(<NewTaskDialog open workspace={workspace} runtimes={runtimes} onClose={vi.fn()} onDelegate={vi.fn()} onBlankSession={vi.fn()} />);
  currentApiMock().override('agent.listSkills', async () => ({ skills: [] }));
  enterTask(screen.getByRole('textbox', { name: '任务' }), '/harness');
  const option = await screen.findByRole('option', { name: /\/harness/ });
  const form = screen.getByRole('dialog', { name: '新建任务' });
  expect(form.contains(option)).toBe(false);
  expect(option.closest('.task-composer-flyout')).toBeTruthy();
  fireEvent.keyDown(screen.getByRole('textbox', { name: '任务' }), { key: 'Escape' });
  expect(screen.queryByRole('option', { name: /\/harness/ })).toBeNull();
  expect(form.isConnected).toBe(true);
});

it('opens the GUI/CLI picker above the Harness button and confirms without starting the task', async () => {
  const onDelegate = vi.fn(async () => ({ notified: false }));
  renderTask(<NewTaskDialog open workspace={workspace} runtimes={runtimes} onClose={vi.fn()} onDelegate={onDelegate} onBlankSession={vi.fn()} />);
  expect(screen.queryByRole('tab', { name: 'CLI' })).toBeNull();
  enterTask(screen.getByRole('textbox', { name: '任务' }), 'Keep this task draft');
  const original = screen.getByRole('dialog', { name: '新建任务' });
  const trigger = within(original).getByRole('button', { name: '选择 Harness 和模型' });
  vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue(new DOMRect(620, 315, 210, 28));
  fireEvent.click(trigger);
  const popup = screen.getByRole('dialog', { name: '选择 Harness 和模型' }).closest<HTMLElement>('[data-flyout=harness]')!;
  expect(popup.style.bottom).toBe(`${window.innerHeight - 315 + 4}px`);
  expect(popup.style.left).toBe('310px');
  fireEvent.mouseDown(within(original).getByRole('textbox', { name: '任务' }));
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(within(original).getByRole('button', { name: '选择 Harness 和模型' }));
  fireEvent.click(screen.getByRole('tab', { name: 'CLI' }));
  fireEvent.keyDown(screen.getByRole('tab', { name: 'CLI' }), { key: 'Escape' });
  expect(screen.getByRole('button', { name: '选择 Harness 和模型' })).toBeTruthy();
  expect(screen.getByRole('textbox', { name: '任务' }).textContent).toBe('Keep this task draft');
  fireEvent.click(within(original).getByRole('button', { name: '选择 Harness 和模型' }));
  const gui = screen.getByRole('tab', { name: 'GUI' });
  expect(gui.getAttribute('aria-selected')).toBe('true');
  fireEvent.keyDown(gui, { key: 'ArrowRight' });
  const dialog = screen.getByRole('dialog', { name: '选择 Harness 和模型' });
  expect(original.contains(dialog)).toBe(false);
  expect(original.isConnected).toBe(true);
  expect(original.closest('[inert]')).toBeNull();
  expect(dialog.closest('[data-flyout=harness]')).toBeTruthy();
  expect(dialog.hasAttribute('aria-modal')).toBe(false);
  const unavailable = await within(dialog).findByRole<HTMLButtonElement>('tab', { name: /Cursor.*Sign in required/ });
  expect(unavailable.disabled).toBe(true);
  expect(within(dialog).queryByRole('tab', { name: /Gemini/ })).toBeNull();
  fireEvent.change(within(dialog).getByRole('searchbox'), { target: { value: 'Claude' } });
  fireEvent.click(within(dialog).getByRole('tab', { name: 'Claude Code' }));
  const option = await within(dialog).findByRole('option', { name: 'Sonnet' });
  fireEvent.click(option);
  option.focus();
  await waitFor(() => expect(within(dialog).getByRole<HTMLButtonElement>('button', { name: '确认配置' }).disabled).toBe(false));
  fireEvent.keyDown(option, { key: 'Enter' });
  expect(screen.getByRole('dialog', { name: '新建任务' })).toBe(original);
  expect(screen.getByRole('textbox', { name: '任务' }).textContent).toBe('Keep this task draft');
  expect(screen.getByRole('button', { name: '选择 Harness 和模型' }).textContent).toContain('Claude Code');
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: '选择 Harness 和模型' })));
  expect(onDelegate).not.toHaveBeenCalled();
});

it('does not move focus after a pending parameter navigation is superseded by search or a different source', async () => {
  const api = currentApiMock();
  const pending: Array<{ request: HarnessPickerRequest; finish: (value: HarnessPickerResult) => void }> = [];
  const controls = resolveModelParameters({ runtimeId: 'claude', providerId: 'claude', modelId: 'sonnet', parameters: [{ id: 'effort', label: 'Effort', apply: 'next-turn',
    supportsDefault: true, options: [{ value: 'high', label: 'High' }] }] }, []).controls;
  api.override('agentSession.readHarnessPickerCatalog', request => request.model && request.model.modelId === 'sonnet'
    ? new Promise(resolve => { pending.push({ request, finish: resolve }); }) : Promise.resolve(pickerCatalog(request, { models })));
  const onConfirm = vi.fn(() => ({ ok: true }));
  const props = { confirmLabel: 'Confirm', onConfirm, onCancel: vi.fn() };
  const view = render(<HarnessModelPicker {...props} target={{ sessionId: 'first' }} />);
  const option = await screen.findByRole('option', { name: 'Sonnet' });
  option.focus(); fireEvent.click(option);
  await waitFor(() => expect(pending).toHaveLength(1));
  fireEvent.keyDown(option, { key: 'ArrowRight' });
  fireEvent.keyDown(option, { key: '/', shiftKey: true });
  const search = screen.getByRole('searchbox');
  expect(document.activeElement).toBe(search);
  await act(async () => pending[0].finish(pickerCatalog(pending[0].request, { models, controls })));
  expect(document.activeElement).toBe(search);
  expect(screen.getByRole('radio', { name: 'High' })).toBeTruthy();

  view.rerender(<HarnessModelPicker {...props} target={{ sessionId: 'second' }} />);
  await screen.findByRole('option', { name: 'Sonnet' });
  expect(screen.queryByRole('radio', { name: 'High' })).toBeNull();
  expect(onConfirm).not.toHaveBeenCalled();
});

it('honors an arrow to the model column when the first read initializes the default', async () => {
  let finish!: (value: HarnessPickerResult) => void;
  let request!: HarnessPickerRequest;
  currentApiMock().override('agentSession.readHarnessPickerCatalog', input => {
    if (input.model !== undefined) return Promise.resolve(pickerCatalog(input, { models }));
    request = input;
    return new Promise(resolve => { finish = resolve; });
  });
  render(<HarnessModelPicker target={{ source: { workspaceId: 'picker-ws', rootId: 'root' }, surface: 'cli' }}
    onCancel={vi.fn()} onConfirm={vi.fn(() => ({ ok: true }))} confirmLabel="Confirm" />);
  const row = await screen.findByRole('tab', { name: 'Codex' });
  expect(document.activeElement).toBe(row);
  await waitFor(() => expect(finish).toBeTypeOf('function'));
  fireEvent.keyDown(row, { key: 'ArrowRight' });
  await act(async () => finish(pickerCatalog(request, { models })));
  expect(document.activeElement?.getAttribute('role')).toBe('option');
  expect(document.activeElement?.textContent).toBe('跟随 CLI 配置');
});

it('holds the same parameter column while model previews load and confirms only the new model’s parameters', async () => {
  const api = currentApiMock();
  const controlsFor = (value: string) => resolveModelParameters({ runtimeId: 'claude', providerId: 'claude', modelId: 'sonnet',
    parameters: [{ id: 'effort', label: 'Effort', apply: 'next-turn', supportsDefault: true, options: [{ value, label: value }] }] }, []).controls;
  const rows = [...models, { providerId: 'claude', modelId: 'opus', label: 'Opus' }];
  const reads: Array<{ request: HarnessPickerRequest; finish: (value: HarnessPickerResult) => void }> = [];
  api.override('agentSession.readHarnessPickerCatalog', request => request.model
    ? new Promise(resolve => { reads.push({ request, finish: resolve }); })
    : Promise.resolve(pickerCatalog(request, { models: rows, controls: controlsFor('old') })));
  const confirm = vi.fn(() => ({ ok: true }));
  render(<HarnessModelPicker target={{ sessionId: 'preview-session' }} confirmLabel="Confirm" onCancel={vi.fn()} onConfirm={confirm} />);
  const old = await screen.findByRole<HTMLButtonElement>('radio', { name: 'old' });
  const column = old.closest('[data-picker-column="parameters"]');
  const first = screen.getByRole('option', { name: '跟随引擎默认' });
  first.focus();
  fireEvent.keyDown(first, { key: 'ArrowDown' });
  const second = screen.getByRole('option', { name: 'Sonnet' });
  expect(document.activeElement).toBe(second);
  expect(old.closest('[data-picker-column="parameters"]')).toBe(column);
  expect(column?.isConnected).toBe(true);
  expect(old.disabled).toBe(true);
  expect(column?.querySelector('[aria-busy="true"]')?.textContent).toContain('读取中…');
  expect(column?.querySelector('[aria-checked="true"]')).toBeNull();
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '模型参数' }).disabled).toBe(true);
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Confirm' }).disabled).toBe(true);
  fireEvent.keyDown(second, { key: 'ArrowDown' });
  const third = screen.getByRole('option', { name: 'Opus' });
  expect(document.activeElement).toBe(third);
  await waitFor(() => expect(reads).toHaveLength(2));
  await act(async () => reads[0].finish(pickerCatalog(reads[0].request, { models: rows, controls: controlsFor('obsolete') })));
  expect(screen.queryByRole('radio', { name: 'obsolete' })).toBeNull();
  fireEvent.keyDown(third, { key: 'ArrowRight' });
  await act(async () => reads[1].finish(pickerCatalog(reads[1].request, { models: rows, controls: controlsFor('current') })));
  const current = screen.getByRole('radio', { name: 'current' });
  expect(current.closest('[data-picker-column="parameters"]')).toBe(column);
  expect(document.activeElement).toBe(screen.getByRole('radio', { name: '跟随默认' }));
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
  fireEvent.keyDown(current, { key: 'Enter' });
  expect(confirm).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ model: expect.objectContaining({ modelId: 'opus' }), parameters: { effort: 'current' } }));
});

it('drops the held column on a Harness change or a completed preview with no parameters', async () => {
  const controls = resolveModelParameters({ runtimeId: 'codex', providerId: 'claude', modelId: 'sonnet',
    parameters: [{ id: 'effort', label: 'Effort', apply: 'next-turn', supportsDefault: true, options: [{ value: 'high', label: 'High' }] }] }, []).controls;
  const reads: Array<{ request: HarnessPickerRequest; finish: (value: HarnessPickerResult) => void }> = [];
  currentApiMock().override('agentSession.readHarnessPickerCatalog', request => request.model || 'harness' in request && request.harness.harnessId === 'claude'
    ? new Promise(resolve => { reads.push({ request, finish: resolve }); })
    : Promise.resolve(pickerCatalog(request, { models, controls })));
  const confirm = vi.fn(() => ({ ok: true }));
  render(<HarnessModelPicker target={{ source: { workspaceId: 'picker-ws', rootId: 'root' }, surface: 'cli' }}
    initial={{ harness: choices[0], model: null }} confirmLabel="Confirm" onCancel={vi.fn()} onConfirm={confirm} />);
  await screen.findByRole('radio', { name: 'High' });
  fireEvent.click(screen.getByRole('option', { name: 'Sonnet' }));
  await waitFor(() => expect(reads).toHaveLength(1));
  expect(screen.getByRole<HTMLButtonElement>('radio', { name: 'High' }).disabled).toBe(true);
  fireEvent.click(screen.getByRole('tab', { name: 'Claude Code' }));
  expect(screen.queryByRole('radio', { name: 'High' })).toBeNull();
  await waitFor(() => expect(reads).toHaveLength(2));
  await act(async () => reads[0].finish(pickerCatalog(reads[0].request, { models, controls })));
  expect(screen.queryByRole('radio', { name: 'High' })).toBeNull();

  fireEvent.click(screen.getByRole('tab', { name: 'Codex' }));
  await screen.findByRole('radio', { name: 'High' });
  const row = screen.getByRole('option', { name: 'Sonnet' });
  fireEvent.click(row);
  await waitFor(() => expect(reads).toHaveLength(3));
  expect(screen.getByRole<HTMLButtonElement>('radio', { name: 'High' }).disabled).toBe(true);
  await act(async () => reads[2].finish(pickerCatalog(reads[2].request, { models })));
  expect(screen.queryByRole('radio', { name: 'High' })).toBeNull();
  row.focus();
  fireEvent.keyDown(row, { key: 'Enter' });
  expect(confirm).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ model: expect.objectContaining({ modelId: 'sonnet' }), parameters: {} }));
});
