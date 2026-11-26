import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AvatarPicker } from '../../src/renderer/src/components/AvatarPicker';
import { ExtensionUiDialog } from '../../src/renderer/src/components/ExtensionUiDialog';
import { ThemePane } from '../../src/renderer/src/components/settings/ThemePane';
import { BoardCard } from '../../src/renderer/src/panels/BoardCard';
import { CanvasWorld, type CanvasWorldProps } from '../../src/renderer/src/panels/freeCanvas/CanvasWorld';
import { GitBranchPopover } from '../../src/renderer/src/panels/GitBranchPopover';
import { PrCreateDialog } from '../../src/renderer/src/panels/PrCreateDialog';
import { GitWorkspaceProvider } from '../../src/renderer/src/panels/gitpanel/GitWorkspaceScope';
import { builtinTheme } from '../../src/shared/theme';
import { currentApiMock } from './helpers/api-mock';

// Synthetic native-event shapes cover Chromium composition and Safari's 229 fallback.
// They do not claim to drive an operating system's candidate window.
const compositionKeys = [
  { isComposing: true, keyCode: 13 },
  { isComposing: false, keyCode: 229 }
];
const confirmCandidate = (input: HTMLElement, event: typeof compositionKeys[number]) =>
  fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', ...event });
const submit = (input: HTMLElement) => fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', keyCode: 13 });
const scope = { workspaceId: 'ime-fixture', rootsRevision: 1 };

function canvasProps(): CanvasWorldProps {
  return {
    items: [], nodes: {}, stickies: [], notes: {}, noteEdit: null, stickyEdit: null,
    edgeLabelEdit: null, groupRename: null, commitGroupRename: vi.fn(), setGroupRename: vi.fn(),
    commitEdgeLabel: vi.fn(), setEdgeLabelEdit: vi.fn(), changeNoteEdit: vi.fn(), commitNoteEdit: vi.fn(),
    cancelNoteEdit: vi.fn(), changeStickyEdit: vi.fn(), commitStickyEdit: vi.fn(), cancelStickyEdit: vi.fn(),
    onRequestCreate: vi.fn(), cancelHandover: vi.fn(), selNodeSet: new Set(), selEdgeSet: new Set(),
    selGroupSet: new Set(), zoom: 1, hotZone: null, guides: [], linkDrag: null, linkPath: null,
    handoverStubs: {}, handoverJobs: {}, sourceById: new Map(), edgeViews: [], groupViews: [], hullViews: []
  };
}

describe.each(compositionKeys)('IME-confirming Enter (%j)', event => {
  it('does not apply a custom avatar until a separate Enter', () => {
    const onChange = vi.fn();
    render(<AvatarPicker value="" allowEmoji onChange={onChange} onUpload={vi.fn()} />);
    const input = screen.getByPlaceholderText('自定义 emoji');
    fireEvent.change(input, { target: { value: '猫' } });
    confirmCandidate(input, event);
    expect(onChange).not.toHaveBeenCalled();
    submit(input);
    expect(onChange).toHaveBeenCalledWith('猫');
  });

  it('does not answer an extension prompt until a separate Enter', () => {
    const onRespond = vi.fn();
    render(<ExtensionUiDialog request={{ requestId: 'prompt', kind: 'prompt', title: 'Prompt', defaultValue: '候选词' }} onRespond={onRespond} />);
    const input = screen.getByRole('textbox');
    confirmCandidate(input, event);
    expect(onRespond).not.toHaveBeenCalled();
    submit(input);
    expect(onRespond).toHaveBeenCalledWith('prompt', false, '候选词');
  });

  it('does not commit a board rename until a separate Enter', () => {
    const commit = vi.fn();
    render(<BoardCard sessionId="s" name="Session" runtimeLabel="Pi" status="idle" relTimeTs={0} isActive={false}
      onSelect={vi.fn()} onContextMenu={vi.fn()} renaming renameValue="候选词" onRenameChange={vi.fn()}
      onRenameCommit={commit} onRenameCancel={vi.fn()} />);
    const input = screen.getByRole('textbox');
    confirmCandidate(input, event);
    expect(commit).not.toHaveBeenCalled();
    submit(input);
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it.each(['group', 'edge'] as const)('does not save a canvas %s label until a separate Enter', kind => {
    const props = canvasProps();
    const commit = vi.fn();
    if (kind === 'group') {
      props.groupRename = { id: 'g', value: '候选词' };
      props.groupViews = [{ g: { id: 'g', label: 'Group', members: [] }, box: { x: 0, y: 0, w: 100, h: 100 } }];
      props.commitGroupRename = commit;
    } else {
      props.edgeLabelEdit = { id: 'e', value: '候选词' };
      props.edgeViews = [{ e: { id: 'e', from: 'a', to: 'b', label: 'Edge' }, path: '',
        an: { a: { x: 0, y: 0 }, b: { x: 20, y: 20 }, aOut: { x: 0, y: 0 }, bOut: { x: 20, y: 20 } },
        mid: { x: 10, y: 10 }, angle: 0, aName: 'a', bName: 'b' }];
      props.commitEdgeLabel = commit;
    }
    render(<CanvasWorld {...props} />);
    const input = screen.getByRole('textbox');
    confirmCandidate(input, event);
    expect(commit).not.toHaveBeenCalled();
    submit(input);
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it.each(['branch', 'worktree'] as const)('does not create a Git %s until a separate Enter', async kind => {
    const api = currentApiMock();
    api.override('git.invokeScoped', async (_scope, method) => method === 'listBranches'
      ? { current: 'main', local: [{ name: 'main', ref: 'main', current: true }], remote: [] }
      : { ok: true, path: '/fixture/new' });
    render(<GitWorkspaceProvider scope={scope}><GitBranchPopover repoPath="/fixture" currentBranch="main" dirty={false} open onClose={vi.fn()} onChanged={vi.fn()} /></GitWorkspaceProvider>);
    await screen.findByText('main', { selector: '.git-branch-item-name' });
    fireEvent.click(screen.getByRole('button', { name: kind === 'branch' ? '＋ 基于当前分支新建' : '⎇ 在分支新建 worktree' }));
    const input = screen.getByPlaceholderText(kind === 'branch' ? '基于 main 新建…' : '在分支 main 上建 worktree，名字…');
    fireEvent.change(input, { target: { value: '候选词' } });
    const calls = () => api.mockOf('git.invokeScoped').mock.calls.filter(args => args[1] === (kind === 'branch' ? 'checkout' : 'worktreeAdd'));
    confirmCandidate(input, event);
    expect(calls()).toHaveLength(0);
    submit(input);
    await waitFor(() => expect(calls()).toHaveLength(1));
  });

  it('does not push a branch or create a PR until a separate Enter', async () => {
    const api = currentApiMock();
    api.override('pr.create', async () => ({ ok: true, value: { number: 1, url: 'https://github.com/team/repo/pull/1' } }));
    render(<GitWorkspaceProvider scope={scope}><PrCreateDialog open repoPath="/fixture" branch="feature"
      repository={{ name: 'team/repo', pushRepository: 'team/repo', url: 'https://github.com/team/repo/pulls', defaultBranch: 'main', autoReview: false }}
      onClose={vi.fn()} onCreated={vi.fn()} /></GitWorkspaceProvider>);
    const input = screen.getByLabelText('PR 标题');
    fireEvent.change(input, { target: { value: '候选词' } });
    confirmCandidate(input, event);
    expect(api.mockOf('pr.create')).not.toHaveBeenCalled();
    submit(input);
    await waitFor(() => expect(api.mockOf('pr.create')).toHaveBeenCalledTimes(1));
  });

  it('does not create a theme until a separate Enter', async () => {
    const api = currentApiMock();
    const theme = builtinTheme('dark')!;
    api.override('themes.list', async () => ({ activeId: theme.id, active: theme, globalThemeId: theme.id, dir: '/fixture', themes: [] }));
    api.override('themes.get', async () => ({ ok: true, theme }));
    api.override('themes.activate', async () => ({ ok: true }));
    api.override('themes.create', async () => ({ ok: false, error: 'fixture stops before persistence' }));
    render(<ThemePane />);
    fireEvent.click(await screen.findByRole('button', { name: /新建主题/ }));
    const input = screen.getByPlaceholderText('新主题名，如 夜蓝');
    fireEvent.change(input, { target: { value: '候选词' } });
    confirmCandidate(input, event);
    expect(api.mockOf('themes.create')).not.toHaveBeenCalled();
    submit(input);
    await waitFor(() => expect(api.mockOf('themes.create')).toHaveBeenCalledWith('候选词'));
  });
});
