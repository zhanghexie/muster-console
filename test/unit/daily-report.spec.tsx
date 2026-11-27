import fs from 'node:fs';
import { waitFor } from '@testing-library/react';
// @ts-expect-error The same plain JavaScript domain is shipped to the extension worker.
import { createDomainRuntime } from '../../resources/extensions/daily-report/domain.mjs';

const html = fs.readFileSync('resources/extensions/daily-report/ui/panel.html', 'utf8');
const script = html.match(/<script>\s*([\s\S]*?)<\/script>/)![1];
let iframe: HTMLIFrameElement | undefined;
afterEach(() => { iframe?.remove(); iframe = undefined; });

function mount(initialFiles: [string, string][] = []) {
  iframe = document.createElement('iframe'); document.body.append(iframe);
  const page = iframe.contentWindow as Window & typeof globalThis;
  page.document.open(); page.document.write(html.replace(/<script[\s\S]*?<\/script>/g, '')); page.document.close();
  const files = new Map(initialFiles);
  const ma = {
    ready: Promise.resolve({ workspaceId: 'a' }),
    journal: { list: vi.fn(async () => ({ dates: [] as string[] })), read: vi.fn(async (day: string) => ({ content: `<!-- muster-journal:fixture -->\n## [${day}] 已完成\n- 要点：实际结果\n<!-- /muster-journal:fixture -->` })) },
    data: { read: vi.fn(async (name: string) => files.has(name) ? { content: files.get(name)! } : null), write: vi.fn(async (name: string, content: string) => { files.set(name, content); }), list: vi.fn(async () => []) },
    llm: { chat: vi.fn(async () => ({ text: '# 手动日报' })) },
    notify: vi.fn(async () => {}), storage: { set: vi.fn(async () => {}) },
    commands: { execute: vi.fn(async (_command: string, args: { mode: string }) => args.mode === 'list' ? [{ id: 'pi', label: 'Pi' }] : { ok: true, sessionId: 'child', receipt: 'stored' }) }
  };
  const runtime = createDomainRuntime({ broker: async (method: string, args: string[]) => {
    if (method === 'data.read') return ma.data.read(args[0]);
    if (method === 'data.write') return ma.data.write(args[0], args[1]);
    if (method === 'data.list') return ma.data.list();
    if (method === 'journal.list') return ma.journal.list();
    throw new Error('Unexpected broker method: ' + method);
  } });
  Object.assign(ma, {
    on: (type: string, callback: (event: unknown) => void) => runtime.subscribe((event: { type: string }) => { if (event.type === type) callback(event); }),
    agent: { domain: { command: (name: string, args: unknown) => runtime.execute(name, args, { actor: 'human' }), query: (name: string, args: unknown) => runtime.query(name, args, {}) } }
  });
  (page as unknown as { ma: unknown }).ma = ma;
  new Function('document', 'window', 'ma', script)(page.document, page, ma);
  return { page, ma, files, runtime };
}

it('reads the selected workspace journal and writes manually generated reports into extension data', async () => {
  const { page, ma } = mount();
  await waitFor(() => expect(page.document.querySelector('#genBtn')).not.toBeNull());
  expect(ma.llm.chat).not.toHaveBeenCalled();
  const day = ma.journal.read.mock.calls[0][0];
  (page.document.querySelector('#genBtn') as HTMLButtonElement).click();
  await waitFor(() => expect(ma.data.write).toHaveBeenCalledWith(`reports/${day}.md`, '# 手动日报'));
  expect(ma.llm.chat).toHaveBeenCalledTimes(1);
  page.document.dispatchEvent(new page.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  await waitFor(() => expect(ma.journal.read.mock.calls.some(([readDay]) => readDay !== day)).toBe(true));
});

it('resizes from the calendar seam without adding the pointer offset to the saved width', async () => {
  const { page, ma, files } = mount();
  await waitFor(() => expect(page.document.querySelector('#genBtn')).not.toBeNull());
  const pane = page.document.querySelector<HTMLElement>('.cal-pane')!;
  const handle = page.document.querySelector<HTMLElement>('#resizer')!;
  vi.spyOn(pane, 'getBoundingClientRect').mockReturnValue(new page.DOMRect(0, 0, 312, 400));

  handle.dispatchEvent(new page.MouseEvent('mousedown', { clientX: 316, bubbles: true }));
  expect(handle.classList.contains('active')).toBe(true);
  page.dispatchEvent(new page.MouseEvent('mousemove', { clientX: 346 }));
  expect(pane.style.width).toBe('342px');
  expect(ma.data.write).not.toHaveBeenCalled();
  page.dispatchEvent(new page.MouseEvent('mouseup'));
  expect(handle.classList.contains('active')).toBe(false);
  await waitFor(() => expect(JSON.parse(files.get('ui.json')!).calWidth).toBe(342));
});

it('creates a todo and dispatches it through the declared extension command', async () => {
  const { page, ma, files } = mount();
  await waitFor(() => expect(page.document.querySelector('#todoAdd')).not.toBeNull());
  (page.document.querySelector('#todoText') as HTMLInputElement).value = '整理文档';
  (page.document.querySelector('#todoAdd') as HTMLButtonElement).click();
  await waitFor(() => expect(page.document.querySelector('.t-dispatch')).not.toBeNull());
  (page.document.querySelector('.t-dispatch') as HTMLButtonElement).click();
  await waitFor(() => expect(page.document.querySelector('.dsp-item')).not.toBeNull());
  (page.document.querySelector('.dsp-item') as HTMLElement).click();
  await waitFor(() => expect(ma.commands.execute).toHaveBeenCalledWith('dispatch', expect.objectContaining({ mode: 'dispatch', runtimeId: 'pi', name: '整理文档' })));
  await waitFor(() => expect(files.get('todos.json')).toContain('child'));
  expect(ma.notify).toHaveBeenCalledWith(expect.stringContaining('已派活'));
});

it.each([
  { isComposing: true },
  { keyCode: 229 },
])('keeps the to-do title while confirming IME input (%j)', async (ime) => {
  const { page, ma, files } = mount();
  await waitFor(() => expect(page.document.querySelector('#genBtn')).not.toBeNull());
  const readsBeforeComposition = ma.data.read.mock.calls.length;
  const input = page.document.querySelector('#todoText') as HTMLInputElement;
  input.value = '待确认的候选词';
  const confirming = new page.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...ime });
  const compositionWasNotCancelled = input.dispatchEvent(confirming);
  // Let an incorrect asynchronous domain write finish before the fixture is removed.
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(compositionWasNotCancelled).toBe(true);
  expect(ma.data.read).toHaveBeenCalledTimes(readsBeforeComposition);
  expect(input.value).toBe('待确认的候选词');

  input.value = '已确认的待办';
  const submitting = new page.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  expect(input.dispatchEvent(submitting)).toBe(false);
  await waitFor(() => expect(input.value).toBe(''));
  expect(JSON.parse(files.get('todos.json')!).todos).toEqual([expect.objectContaining({ text: '已确认的待办' })]);
});

it('renders saved to-do IDs and dates as data before changing the status', async () => {
  const now = new Date();
  const date = [now.getFullYear(), now.getMonth() + 1, now.getDate()].map(value => String(value).padStart(2, '0')).join('-');
  const id = 'legacy "R&D" <1>';
  const doingDate = '2000-01-01 <i>旧日期</i>';
  const { page, files } = mount([['todos.json', JSON.stringify({ todos: [{ id, text: '旧待办', createDate: date, doingDate, createdAt: 1 }] })]]);
  await waitFor(() => expect(page.document.querySelector('.day-todos .ln')).not.toBeNull());
  const item = page.document.querySelector<HTMLElement>('.todo-item')!;
  const status = item.querySelector<HTMLButtonElement>('[data-status="doing"]')!;
  expect(item.dataset.id).toBe(id);
  expect(status.dataset.id).toBe(id);
  expect(item.querySelector('.t-sub')?.textContent).toContain(doingDate.slice(5));
  expect(page.document.querySelector('.day-todos .ln')?.textContent).toContain(doingDate.slice(5));
  status.click();
  await waitFor(() => expect(JSON.parse(files.get('todos.json')!).todos).toEqual([expect.objectContaining({ id, doingDate: date })]));
  await waitFor(() => expect(page.document.querySelector('.day-todos .ln')?.textContent).not.toContain('旧日期'));
});

it('switches the built-in page language without discarding an unfinished todo', async () => {
  const { page } = mount();
  await waitFor(() => expect(page.document.querySelector('#genBtn')).not.toBeNull());
  const input = page.document.querySelector('#todoText') as HTMLInputElement;
  input.value = '尚未保存的草稿';
  page.document.documentElement.lang = 'en';
  await waitFor(() => expect(page.document.querySelector('#genBtn')?.textContent).toContain('Generate today'));
  expect(page.document.querySelector('.hd-title')?.textContent).toContain('Daily report');
  expect(page.document.querySelector('.todo-head')?.textContent).toContain('To-dos');
  expect(page.document.querySelector('#detail')?.textContent).toContain('Completed');
  expect(page.document.querySelector('#detail')?.textContent).toContain('实际结果');
  expect(input.value).toBe('尚未保存的草稿');
  expect(input.placeholder).toBe('To-do title…');
  page.document.documentElement.lang = 'zh-CN';
  await waitFor(() => expect(page.document.querySelector('#genBtn')?.textContent).toContain('生成今日日报'));
  expect(input.value).toBe('尚未保存的草稿');
});

it('keeps the delegation picker open and its user data intact while switching languages', async () => {
  const { page, ma } = mount();
  await waitFor(() => expect(page.document.querySelector('#genBtn')).not.toBeNull());
  (page.document.querySelector('#todoText') as HTMLInputElement).value = '整理文档';
  (page.document.querySelector('#todoAdd') as HTMLButtonElement).click();
  await waitFor(() => expect(page.document.querySelector('.t-dispatch')).not.toBeNull());
  (page.document.querySelector('.t-dispatch') as HTMLButtonElement).click();
  await waitFor(() => expect(page.document.querySelector('.dsp-item')).not.toBeNull());
  page.document.documentElement.lang = 'en';
  await waitFor(() => expect(page.document.querySelector('#dspTitle')?.textContent).toContain('Delegate: 整理文档'));
  expect((page.document.querySelector('#dspModal') as HTMLElement).hidden).toBe(false);
  expect(page.document.querySelector('#dspCancel')?.textContent).toBe('Cancel');
  (page.document.querySelector('.dsp-item') as HTMLElement).click();
  await waitFor(() => expect(ma.commands.execute).toHaveBeenCalledWith('dispatch', expect.objectContaining({ mode: 'dispatch', name: '整理文档' })));
});

it('ignores an old journal response when the same day is redrawn in another language', async () => {
  const { page, ma } = mount();
  await waitFor(() => expect(page.document.querySelector('#genBtn')).not.toBeNull());
  let finish!: (value: { content: string }) => void;
  ma.journal.read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  page.document.documentElement.lang = 'en';
  await waitFor(() => expect(finish).toBeTypeOf('function'));
  page.document.documentElement.lang = 'zh-CN';
  await waitFor(() => expect(page.document.querySelector('#genBtn')?.textContent).toContain('生成今日日报'));
  finish({ content: '## [旧读取] 已完成\n- 要点：旧结果' });
  await Promise.resolve();
  await Promise.resolve();
  expect(page.document.querySelector('#detail')?.textContent).not.toContain('旧结果');
});

it('aligns Monday-first labels with dates and exposes selected days as buttons', async () => {
  const { page } = mount();
  await waitFor(() => expect(page.document.querySelector('.cal-day.selected')).not.toBeNull());
  const labels = [...page.document.querySelectorAll('.cal-dow')].map(el => el.textContent);
  expect(labels).toEqual(['一', '二', '三', '四', '五', '六', '日']);
  const days = [...page.document.querySelectorAll<HTMLButtonElement>('.cal-day')];
  days.forEach((button, index) => {
    expect(button.tagName).toBe('BUTTON');
    expect((new Date(button.dataset.d + 'T00:00:00').getDay() + 6) % 7).toBe(index % 7);
  });
  const day = days.find(button => !button.classList.contains('selected') && !button.classList.contains('other'))!;
  day.click();
  await waitFor(() => expect(page.document.querySelector('.d-date')?.textContent).toBe(day.dataset.d));
  expect(page.document.querySelector('.cal-day.selected')?.getAttribute('aria-pressed')).toBe('true');
  const adjacent = page.document.querySelector<HTMLButtonElement>('.cal-day.other')!;
  const adjacentDate = adjacent.dataset.d;
  adjacent.click();
  await waitFor(() => expect(page.document.querySelector('.d-date')?.textContent).toBe(adjacentDate));
  expect((page.document.querySelector('.cal-day.selected') as HTMLElement).dataset.d).toBe(adjacentDate);
});

it('keeps the compact to-do editor and fixed sidebar contract', async () => {
  const { page } = mount();
  await waitFor(() => expect(page.document.querySelector('#todoText')).not.toBeNull());
  expect(page.document.querySelector('.eyebrow')).toBeNull();
  expect(page.document.querySelector('.todo-caption')).toBeNull();
  const sidebar = page.document.querySelector('.cal-pane') as HTMLElement;
  const width = sidebar.style.width;
  const group = page.document.querySelector('[data-g="todo"]') as HTMLButtonElement;
  group.click();
  expect(sidebar.style.width).toBe(width);
  group.click();
  expect(sidebar.style.width).toBe(width);
});

it('keeps a resized sidebar usable and persists its bounded width', async () => {
  const { page, files } = mount();
  await waitFor(() => expect(page.document.querySelector('#genBtn')).not.toBeNull());
  page.document.querySelector('#resizer')!.dispatchEvent(new page.MouseEvent('mousedown', { bubbles: true }));
  page.dispatchEvent(new page.MouseEvent('mousemove', { clientX: 30 }));
  expect((page.document.querySelector('.cal-pane') as HTMLElement).style.width).toBe('260px');
  page.dispatchEvent(new page.MouseEvent('mousemove', { clientX: 900 }));
  expect((page.document.querySelector('.cal-pane') as HTMLElement).style.width).toBe('420px');
  page.dispatchEvent(new page.MouseEvent('mouseup'));
  await waitFor(() => expect(JSON.parse(files.get('ui.json')!).calWidth).toBe(420));
});

it('updates the day overview from real domain writes and preserves group focus and collapse preferences', async () => {
  const { page, files, runtime } = mount();
  await waitFor(() => expect(page.document.querySelector('[data-stat="entries"] .stat-value')?.textContent).toBe('1'));
  expect(page.document.querySelector('[data-stat="done"] .stat-value')?.textContent).toBe('1');
  expect(page.document.querySelector('[data-stat="doing"] .stat-value')?.textContent).toBe('0');
  const day = page.document.querySelector('.d-date')!.textContent;
  const created = await runtime.execute('todo.create', { text: '由 AI 创建的待办', date: day }, { actor: 'agent' });
  await waitFor(() => expect(page.document.querySelector('[data-stat="open-todos"] .stat-value')?.textContent).toBe('1'));
  (page.document.querySelector('.seg3 [data-status="done"]') as HTMLButtonElement).click();
  await waitFor(() => expect(page.document.querySelector('[data-stat="open-todos"] .stat-value')?.textContent).toBe('0'));
  expect(JSON.parse(files.get('todos.json')!).todos[0].id).toBe(created.result.id);
  const group = page.document.querySelector('[data-g="done"]') as HTMLButtonElement;
  expect(group.tagName).toBe('BUTTON');
  expect(group.getAttribute('aria-expanded')).toBe('false');
  group.click();
  expect(page.document.querySelector('[data-g="done"]')?.getAttribute('aria-expanded')).toBe('true');
  expect(page.document.activeElement?.getAttribute('data-g')).toBe('done');
  await waitFor(() => expect(JSON.parse(files.get('ui.json')!).todoCollapsed.done).toBe(false));
});

it('translates known built-in command errors and retains external diagnostic text', async () => {
  const { page, ma } = mount();
  await waitFor(() => expect(page.document.querySelector('#genBtn')).not.toBeNull());
  page.document.documentElement.lang = 'en';
  await waitFor(() => expect(page.document.querySelector('#todoAdd')?.textContent).toContain('Add'));
  (page.document.querySelector('#todoText') as HTMLInputElement).value = 'Example';
  (page.document.querySelector('#todoAdd') as HTMLButtonElement).click();
  await waitFor(() => expect(page.document.querySelector('.t-dispatch')).not.toBeNull());
  ma.commands.execute.mockRejectedValueOnce(new Error('Error: 缺少 sessionId'));
  (page.document.querySelector('.t-dispatch') as HTMLButtonElement).click();
  await waitFor(() => expect(ma.notify).toHaveBeenCalledWith(expect.stringContaining('Error: Missing sessionId')));
  ma.commands.execute.mockRejectedValueOnce(new Error('第三方原始诊断'));
  (page.document.querySelector('.t-dispatch') as HTMLButtonElement).click();
  await waitFor(() => expect(ma.notify).toHaveBeenCalledWith(expect.stringContaining('第三方原始诊断')));
});

