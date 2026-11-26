import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import ReactMarkdown from 'react-markdown';
import type { WorkspaceFileRef, WorkspaceInfo } from '../../src/shared/types';
import { createApiMock } from './helpers/api-mock';

const state = vi.hoisted(() => ({ workspaces: [] as WorkspaceInfo[] }));
vi.mock('../../src/renderer/src/store', () => ({ useWorkspaceStore: () => ({ workspaces: state.workspaces }) }));
vi.mock('react-markdown', async importOriginal => {
  const actual = await importOriginal<typeof import('react-markdown')>();
  return { ...actual, default: vi.fn(actual.default) };
});
import { FileEditor } from '../../src/renderer/src/components/FileEditor';

const parser = vi.mocked(ReactMarkdown);
beforeEach(() => {
  parser.mockClear();
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  state.workspaces = [{ id: 'ws', name: 'Workspace', path: 'E:/A', openedAt: 0, rootsRevision: 0, defaultRootId: 'a', controlRoot: 'E:/A', roots: [{ id: 'a', path: 'E:/A' }] }];
  const api = createApiMock(); window.api = api.api;
  api.override('fs.readTextRef', async (ref: WorkspaceFileRef) => ({ ok: true, content: `# ${ref.relativePath}\n\n[下一页](./target.md)`, mtimeMs: 1 }));
});
afterEach(() => vi.unstubAllGlobals());

it('switching visibility and navigation callbacks does not reparse a file; clicks use the current path and handler', async () => {
  const oldOpen = vi.fn(), nextOpen = vi.fn();
  const props = { workspaceId: 'ws', rootId: 'a', path: 'docs/source.md', findBarOpen: false, onFindBarClose: () => {} };
  const view = render(<FileEditor {...props} onOpenPath={oldOpen} />);
  await waitFor(() => expect(view.container.querySelector('.md-body h1')?.textContent).toBe('docs/source.md'));
  const before = parser.mock.calls.length;
  await act(async () => view.rerender(<FileEditor {...props} active={false} onOpenPath={nextOpen} />));
  expect(parser.mock.calls.length).toBe(before);
  fireEvent.click(view.container.querySelector('.md-body .ws-file-link')!);
  expect(nextOpen).toHaveBeenLastCalledWith('docs/target.md');
  expect(oldOpen).not.toHaveBeenCalled();

  view.rerender(<FileEditor {...props} path="other/source.md" onOpenPath={nextOpen} />);
  await waitFor(() => expect(view.container.querySelector('.md-body h1')?.textContent).toBe('other/source.md'));
  fireEvent.click(view.container.querySelector('.md-body .ws-file-link')!);
  expect(nextOpen).toHaveBeenLastCalledWith('other/target.md');
  expect(parser.mock.calls.length).toBeGreaterThan(before);
});

it('shows a toggleable right-hand table of contents and keeps save outside the mode toggle group', async () => {
  const scrollIntoView = vi.fn();
  const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
  HTMLElement.prototype.scrollIntoView = scrollIntoView;
  const api = createApiMock(); window.api = api.api;
  api.override('fs.readTextRef', async () => ({
    ok: true,
    content: '# Project\n\n## Setup\n\n### Details',
    mtimeMs: 1
  }));
  const toolbarHost = document.createElement('div');
  document.body.appendChild(toolbarHost);
  const view = render(<FileEditor
    workspaceId="ws"
    rootId="a"
    path="README.md"
    compactToolbar
    toolbarHost={toolbarHost}
    findBarOpen={false}
    onFindBarClose={() => {}}
  />);
  try {
    await waitFor(() => expect(toolbarHost.querySelector('[aria-label="显示文档目录"]')).not.toBeNull());
    expect(toolbarHost.querySelector('.right-mode-tools [aria-label="保存"]')).toBeNull();
    expect(toolbarHost.querySelector('.right-tool-group:not(.right-mode-tools) [aria-label="保存"]')).not.toBeNull();

    fireEvent.click(toolbarHost.querySelector('[aria-label="显示文档目录"]')!);
    const toc = await waitFor(() => view.container.querySelector('aside[aria-label="文档目录"]'));
    expect(toc?.textContent).toContain('Setup');
    expect(toc?.textContent).toContain('Details');

    const target = view.container.querySelector<HTMLElement>('#md-heading-2');
    expect(target).not.toBeNull();
    fireEvent.click(view.container.querySelector('[data-toc-index="1"]')!);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start' });

    fireEvent.click(toolbarHost.querySelector('[aria-label="隐藏文档目录"]')!);
    await waitFor(() => expect(view.container.querySelector('aside[aria-label="文档目录"]')).toBeNull());
    fireEvent.click(toolbarHost.querySelector('[aria-label="编辑"]')!);
    expect(toolbarHost.querySelector('.right-tool-group:not(.right-mode-tools) [aria-label="保存"]')).not.toBeNull();
    expect(toolbarHost.querySelector('[aria-label="显示文档目录"]')).toBeNull();
  } finally {
    view.unmount();
    toolbarHost.remove();
    HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
  }
});
