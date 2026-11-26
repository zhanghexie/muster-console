import React from 'react';
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { composerAttachmentDraft, clearAttachmentDraft } from '../../src/renderer/src/composerAttachmentDrafts';
import { getDraft, setDraft } from '../../src/renderer/src/composerDrafts';
import { useComposerImages } from '../../src/renderer/src/components/agentComposer/useComposerImages';
import { StoreProvider, useSessionStore } from '../../src/renderer/src/store';
import { currentApiMock } from './helpers/api-mock';

class DelayedReader {
  static last: DelayedReader;
  result = 'data:image/png;base64,aW1hZ2U=';
  onload: (() => void) | null = null;
  onloadend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() { DelayedReader.last = this; }
  readAsDataURL(): void {}
  succeed(): void { this.onload?.(); this.onloadend?.(); }
  fail(): void { this.onerror?.(); this.onloadend?.(); }
}

function SessionCount(): React.JSX.Element {
  const { sessions } = useSessionStore();
  return <output data-testid="sessions">{sessions.length}</output>;
}

describe('CLI attachment drafts', () => {
  it('finishes a pending read after unmount and restores it only to the original session', () => {
    const originalReader = globalThis.FileReader;
    vi.stubGlobal('FileReader', DelayedReader);
    const scope = 'cli-session:pending-image';
    try {
      const first = renderHook(() => useComposerImages(s => s, scope, undefined, true));
      act(() => first.result.current.addImageFiles([new File(['image'], 'one.png', { type: 'image/png' })]));
      expect(first.result.current.loading).toBe(true);
      first.unmount();
      const other = renderHook(() => useComposerImages(s => s, 'cli-session:other', undefined, true));
      const restored = renderHook(() => useComposerImages(s => s, scope, undefined, true));
      expect(restored.result.current.loading).toBe(true);
      act(() => DelayedReader.last.succeed());
      expect(restored.result.current.loading).toBe(false);
      expect(restored.result.current.images).toHaveLength(1);
      expect(restored.result.current.images[0].name).toBe('one.png');
      expect(other.result.current.images).toHaveLength(0);
      restored.unmount(); other.unmount();
    } finally { clearAttachmentDraft(scope); clearAttachmentDraft('cli-session:other'); vi.stubGlobal('FileReader', originalReader); }
  });

  it('reports an error that arrived while unmounted and ignores results after deletion', () => {
    const originalReader = globalThis.FileReader;
    vi.stubGlobal('FileReader', DelayedReader);
    const scope = 'cli-session:failed-image';
    try {
      const first = renderHook(() => useComposerImages(s => s, scope, undefined, true));
      act(() => first.result.current.addImageFiles([new File(['image'], 'bad.png', { type: 'image/png' })]));
      first.unmount();
      act(() => DelayedReader.last.fail());
      const error = vi.fn();
      const restored = renderHook(() => useComposerImages(s => s, scope, error, true));
      expect(error).toHaveBeenCalledWith('bad.png: 文件读取失败');
      act(() => restored.result.current.addImageFiles([new File(['image'], 'late.png', { type: 'image/png' })]));
      restored.unmount();
      clearAttachmentDraft(scope);
      act(() => DelayedReader.last.succeed());
      expect(composerAttachmentDraft(scope).images).toHaveLength(0);
    } finally { clearAttachmentDraft(scope); vi.stubGlobal('FileReader', originalReader); }
  });

  it('releases pending attachments and text when the session disappears from the full list', async () => {
    const id = 'cli-draft-removal';
    const scope = `cli-session:${id}`;
    const session = { id, name: 'CLI', type: 'terminal', launchKind: 'agent', runtime: 'claude-code', createdAt: 1 };
    currentApiMock().override('sessions.list', async () => ({ sessions: [session], activeId: id }));
    composerAttachmentDraft(scope).images = [{ id: 'one', data: 'aQ==', mimeType: 'image/png' }];
    setDraft(scope, 'draft');
    const view = render(<StoreProvider><SessionCount /></StoreProvider>);
    await waitFor(() => expect(screen.getByTestId('sessions').textContent).toBe('1'));
    act(() => currentApiMock().emit('sessions:changed', { sessions: [], activeId: null }));
    expect(composerAttachmentDraft(scope).images).toHaveLength(0);
    expect(getDraft(scope)).toBe('');
    view.unmount(); clearAttachmentDraft(scope);
  });
});
