import React from 'react';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { AgentComposer } from '../../src/renderer/src/components/AgentComposer';
import { serializeComposerDom } from '../../src/renderer/src/components/composerDomText';
import { enterTask, renderTask } from './helpers/task-editor';
import { currentApiMock } from './helpers/api-mock';

const extensions = ['deck'];
const onAttachments = vi.fn();

function TaskField({ initial = '', path = false, save }: { initial?: string; path?: boolean; save: (text: string) => void }) {
  return <AgentComposer workspaceId="ws" surfaceKind="gui-session" busy={false} plusMenu extensionSkillNames={extensions}
    skillTarget={path ? 'qwen-cli' : 'pi-gui'} onSend={save}
    creation={{ initialText: initial, label: '任务', placeholder: '任务描述', rootId: 'selected', submitLabel: '开始任务',
      submitDisabled: false, allowEmpty: false, cli: path, skillFileReference: path, onAttachments, targetButton: null }} />;
}

it.each([false, true])('在选定根查找技能并按启动目标插入技能（文件引用 %s）', async path => {
  currentApiMock().override('agent.listSkills', async () => ({ skills: [{ name: 'article', description: '排版', filePath: '/project/art/SKILL.md' }] }));
  const save = vi.fn();
  renderTask(<TaskField save={save} path={path}/>);
  const box = screen.getByRole('textbox', { name: '任务' });
  enterTask(box, '/skill:art');
  const option = await screen.findByRole('option', { name: /article/ });
  expect(currentApiMock().mockOf('agent.listSkills')).toHaveBeenCalledWith('ws', path ? 'qwen-cli' : 'pi-gui', undefined, 'selected');
  if (path) fireEvent.mouseDown(option);
  else fireEvent.keyDown(box, { key: 'Enter' });
  expect(box.querySelector('.composer-token-label')?.textContent).toBe('/skill:article');
  fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
  expect(save.mock.calls[0][0]).toBe(path ? 'Use skill "article"; read "/project/art/SKILL.md".' : '/skill:article');
});

it('扩展命令从预填直到提交都保留原文，普通 Enter 写多行', async () => {
  const save = vi.fn();
  renderTask(<TaskField initial="/deck 演示稿" save={save}/>);
  const box = screen.getByRole('textbox', { name: '任务' });
  expect(box.querySelector('.composer-token-label')?.textContent).toBe('/skill:deck');
  fireEvent.keyDown(box, { key: 'Enter', isComposing: true });
  expect(save).not.toHaveBeenCalled();
  fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
  expect(save.mock.calls[0][0]).toBe('/deck 演示稿');
  await waitFor(() => expect(screen.getByRole<HTMLButtonElement>('button', { name: '开始任务' }).disabled).toBe(false));
  enterTask(box, '第一行');
  fireEvent.keyDown(box, { key: 'Enter' });
  expect(serializeComposerDom(box)).toBe('第一行\n');
  expect(save).toHaveBeenCalledTimes(1);
});

it('换目标时移除原引擎的技能引用并保留其余正文', () => {
  const save = vi.fn();
  const { rerender } = renderTask(<TaskField initial="/skill:article 草稿" save={save}/>);
  expect(screen.getByText('/skill:article')).toBeTruthy();
  rerender(<TaskField path save={save}/>);
  expect(screen.queryByText('/skill:article')).toBeNull();
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', ctrlKey: true });
  expect(save.mock.calls[0][0]).toBe('草稿');
});

it('从浮动命令菜单打开快捷短语，并返回同一输入框', async () => {
  renderTask(<TaskField save={vi.fn()}/>);
  const editor = screen.getByRole('textbox', { name: '任务' });
  enterTask(editor, '/quickInput');
  fireEvent.mouseDown(await screen.findByRole('option', { name: /quickInput/ }));
  const phrases = await screen.findByRole('dialog', { name: '快捷短语' });
  expect(phrases.closest('.agent-composer')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '取消命令' }));
  expect(screen.queryByRole('dialog', { name: '快捷短语' })).toBeNull();
  expect(screen.getByRole('textbox', { name: '任务' })).toBe(editor);
});

it('缺少 CSS 锚定定位时，长列表仍只占用编辑器上方的空间', async () => {
  renderTask(<TaskField save={vi.fn()}/>);
  const editor = screen.getByRole('textbox', { name: '任务' });
  const anchor = editor.closest('.agent-composer')!;
  vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue(new DOMRect(40, 110, 440, 160));
  enterTask(editor, '/');
  const list = await screen.findByRole('listbox');
  const popup = list.closest<HTMLElement>('.task-composer-flyout')!;
  expect(popup.style.bottom).toBe(`${window.innerHeight - 110 + 4}px`);
  expect(popup.style.maxHeight).toBe('98px');
});
