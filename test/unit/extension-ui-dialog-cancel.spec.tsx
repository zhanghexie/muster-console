import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StoreProvider, useUiStore } from '../../src/renderer/src/store';
import { ExtensionUiDialog } from '../../src/renderer/src/components/ExtensionUiDialog';
import { closeTopOverlay } from '../../src/renderer/src/keybindings/overlayStack';
import { currentApiMock } from './helpers/api-mock';
import type { UiDialogRequest } from '../../src/shared/uiDialog';
function Harness() { const { dialogs, respondDialog } = useUiStore(); return <ExtensionUiDialog request={dialogs[0] ?? null} onRespond={respondDialog} />; }
async function mount() { await act(async () => { render(<StoreProvider><Harness /></StoreProvider>); }); }
const prompt = (requestId: string): UiDialogRequest => ({ requestId, kind: 'prompt', title: requestId, placeholder: requestId });
const emit = (request: UiDialogRequest) => act(() => currentApiMock().emit('ui:dialog', request));
const close = (requestId: string) => act(() => currentApiMock().emit('ui:dialogClosed', { requestId }));
describe('host cancellation of extension dialogs', () => {
  it('removes only the cancelled queued id and releases Esc as the active dialog exits', async () => {
    await mount(); emit(prompt('active')); emit(prompt('queued'));
    close('queued'); expect(screen.getByRole('dialog').textContent).toContain('active');
    const input = screen.getByPlaceholderText('active');
    close('active');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(closeTopOverlay()).toBe(false);
    expect(currentApiMock().mockOf('dialogRespond')).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
  it('keeps the next dialog after a stale close and responds with its actual request id', async () => {
    const user = userEvent.setup(); await mount(); emit(prompt('first')); emit(prompt('second'));
    close('first'); close('first');
    expect(screen.getByRole('dialog').textContent).toContain('second');
    await user.type(screen.getByPlaceholderText('second'), 'answer');
    await user.click(screen.getByRole('button', { name: '确定' }));
    expect(currentApiMock().mockOf('dialogRespond')).toHaveBeenCalledWith('second', { cancelled: false, value: 'answer' });
  });
});
