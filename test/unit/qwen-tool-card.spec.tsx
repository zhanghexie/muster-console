import React from 'react';
import { fireEvent, render, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { ChatMessageView } from '../../src/renderer/src/components/ChatMessageView';
import { toDisplayMessage } from '../../src/renderer/src/chatSurface/guiMessageView';
import type { GuiChatMessage, GuiToolCallView } from '../../src/shared/guiWorker';
import { buildWorkspaceFileHref } from '../../src/shared/linkifyWorkspacePaths';

function message(...tools: GuiToolCallView[]): GuiChatMessage {
  return {
    id: 'assistant', role: 'assistant', ts: 1,
    parts: tools.map(tool => ({ kind: 'tool', tool }))
  };
}

it('shows the resolved file path and parameters on the same open tool card', () => {
  const onFileLink = vi.fn();
  const file = 'E:/fixture/settings-example.txt';
  const start: GuiToolCallView = { id: 'read', name: 'read_file', input: {}, status: 'running' };
  const renderMessage = (tool: GuiToolCallView) => (
    <ChatMessageView message={toDisplayMessage(message(tool))} streaming={false} quiet onFileLink={onFileLink} />
  );
  const view = render(renderMessage(start));
  const group = view.container.querySelector<HTMLDetailsElement>('details.tool-call-group-details')!;
  fireEvent.click(group.querySelector('summary')!);
  const card = group.querySelector<HTMLDetailsElement>('details.tool-card')!;
  fireEvent.click(card.querySelector('summary')!);
  expect(within(card).queryByText('参数')).toBeNull();

  view.rerender(renderMessage({
    ...start, input: { file_path: file, limit: 2 }, status: 'ok', output: 'fixture version: 1'
  }));
  expect(view.container.querySelectorAll('.tool-card')).toHaveLength(1);
  expect(view.container.querySelector('.tool-card')).toBe(card);
  expect(card.open).toBe(true);
  const link = within(card).getByRole('link', { name: 'settings-example.txt' });
  expect(link.title).toBe(file);
  fireEvent.click(link);
  expect(onFileLink).toHaveBeenCalledWith(buildWorkspaceFileHref(file));
  expect(card.open).toBe(true);
  expect([...card.querySelectorAll('label')].map(label => label.textContent)).toEqual(['参数', '内容']);
  expect(JSON.parse(card.querySelector('pre')!.textContent!)).toEqual({ file_path: file, limit: 2 });
  expect(within(card).getByText('fixture version: 1')).toBeTruthy();
});

it('shows the shell command with its other arguments and identifies the actual MCP call', () => {
  const view = render(
    <ChatMessageView streaming={false} quiet message={toDisplayMessage(message(
      {
        id: 'shell', name: 'run_shell_command', status: 'ok',
        input: { command: 'echo fixture-terminal', timeout: 2000 }, output: 'fixture-terminal'
      },
      {
        id: 'mcp', name: 'mcp__muster__mcp_search', status: 'ok',
        input: { query: 'tools' }, output: '{"ok":true,"result":{"total":0}}'
      },
      {
        id: 'glob', name: 'glob', status: 'ok', input: { pattern: '*.txt' }, output: 'settings-example.txt'
      }
    ))} />
  );
  const group = view.container.querySelector<HTMLDetailsElement>('details.tool-call-group-details')!;
  fireEvent.click(group.querySelector('summary')!);
  const [shell, mcp, glob] = [...group.querySelectorAll<HTMLDetailsElement>('details.tool-card')];
  expect(shell.querySelector('summary')!.textContent).toContain('echo fixture-terminal');
  fireEvent.click(shell.querySelector('summary')!);
  expect([...shell.querySelectorAll('label')].map(label => label.textContent)).toEqual(['命令', '参数', '结果']);
  expect(JSON.parse(shell.querySelectorAll('pre')[1].textContent!)).toEqual({ timeout: 2000 });
  expect(within(shell).getByText('fixture-terminal')).toBeTruthy();

  expect(mcp.querySelector('summary')!.textContent).toContain('mcp_search · muster');
  fireEvent.click(mcp.querySelector('summary')!);
  expect([...mcp.querySelectorAll('label')].map(label => label.textContent)).toEqual(['参数', '结果']);
  const [args, output] = [...mcp.querySelectorAll('pre')];
  expect(JSON.parse(args.textContent!)).toEqual({ query: 'tools' });
  expect(JSON.parse(output.textContent!)).toEqual({ ok: true, result: { total: 0 } });
  expect(glob.querySelector('summary')!.textContent).toContain('*.txt');
});
