import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { KeybindingProvider } from '../../src/renderer/src/keybindings/KeybindingHost';
import { overlayDepth, resetOverlayStackForTest } from '../../src/renderer/src/keybindings/overlayStack';
import { AppConfirmDialog } from '../../src/renderer/src/components/AppConfirmDialog';
import { BoardReviewDialog } from '../../src/renderer/src/components/BoardReviewDialog';
import { ConfirmDialog } from '../../src/renderer/src/components/ConfirmDialog';
import { CreateWorkspaceModal } from '../../src/renderer/src/components/CreateWorkspaceModal';
import { EvidencePanel } from '../../src/renderer/src/components/EvidencePanel';
import { ExtensionUiDialog } from '../../src/renderer/src/components/ExtensionUiDialog';
import { GitBranchPopover } from '../../src/renderer/src/panels/GitBranchPopover';
import { GitWorkspaceProvider } from '../../src/renderer/src/panels/gitpanel/GitWorkspaceScope';
import { StoreProvider } from '../../src/renderer/src/store';
import { setInteractionPreferences } from '../../src/renderer/src/interactionPreferences';
import { MOTION } from '../../src/renderer/src/components/motion';

beforeEach(() => { resetOverlayStackForTest(); });
afterEach(() => {
  act(() => setInteractionPreferences({ motion: 'system' }));
  vi.useRealTimers();
});

const closedPanels = [
  ['app confirm', () => <AppConfirmDialog open={false} title="Confirm" onConfirm={() => {}} onCancel={() => {}} />],
  ['board review', () => <BoardReviewDialog open={false} title="Review" confirmLabel="OK" defaultNote="" onConfirm={() => {}} onCancel={() => {}} />],
  ['host confirm', () => <ConfirmDialog request={null} />],
  ['workspace', () => <CreateWorkspaceModal open={false} onClose={() => {}} onSave={async () => {}} />],
  ['evidence', () => <EvidencePanel />],
  ['extension', () => <ExtensionUiDialog request={null} onRespond={() => {}} />],
  ['git branch', () => <GitWorkspaceProvider scope={{ workspaceId: 'test', rootsRevision: 0 }}><GitBranchPopover repoPath="/test" dirty={false} open={false} onClose={() => {}} onChanged={() => {}} /></GitWorkspaceProvider>]
] as const;

for (const motion of ['system', 'reduced'] as const) {
  it.each(closedPanels)(`${motion}: closed %s never consumes terminal Esc`, async (_name, panel) => {
    setInteractionPreferences({ motion });
    const received = vi.fn();
    await act(async () => { render(<StoreProvider><KeybindingProvider>
      {panel()}<div className="xterm"><textarea aria-label="terminal" onKeyDown={received} /></div>
    </KeybindingProvider></StoreProvider>); });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(overlayDepth()).toBe(0);
    const input = screen.getByRole('textbox', { name: 'terminal' });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(received).toHaveBeenCalledOnce();
    expect(received.mock.calls[0][0].defaultPrevented).toBe(false);
  });

  it(`${motion}: close, exit completion and reopen leave no ghost Esc entries`, async () => {
    vi.useFakeTimers();
    setInteractionPreferences({ motion });
    const cancel = vi.fn();
    const tree = (open: boolean) => <KeybindingProvider><AppConfirmDialog open={open} title="Confirm" onConfirm={() => {}} onCancel={cancel} /></KeybindingProvider>;
    let view: ReturnType<typeof render>;
    await act(async () => { view = render(tree(true)); });
    expect(overlayDepth()).toBe(1);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(cancel).toHaveBeenCalledOnce();
    view!.rerender(tree(false));
    expect(overlayDepth()).toBe(0);
    act(() => vi.advanceTimersByTime(MOTION.exitMs + 80));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(overlayDepth()).toBe(0);
    view!.rerender(tree(true));
    expect(overlayDepth()).toBe(1);
    view!.unmount();
    expect(overlayDepth()).toBe(0);
  });
}
