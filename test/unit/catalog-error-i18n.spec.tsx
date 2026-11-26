import { renderWithAppTips as render } from './helpers/app-tips';
import React from 'react';
import { act, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { TaskSessionFields } from '../../src/renderer/src/components/TaskSessionFields';
import { HarnessModelSelectionPanel } from '../../src/renderer/src/components/settings/HarnessModelSelectionPanel';
import { applyLocaleSetting } from '../../src/shared/i18n';
import type { AppConfig } from '../../src/shared/types';
import { currentApiMock } from './helpers/api-mock';
import userEvent from '@testing-library/user-event';

const source = { workspaceId: 'w', rootId: 'r', rootsRevision: 1 };
const cfg = { activeWorkspaceId: 'w', workspaces: [{ id: 'w', name: 'Fixture', path: '/workspace', roots: [{ id: 'r', path: '/workspace' }], defaultRootId: 'r', rootsRevision: 1 }] } as AppConfig;
const result = { ok: false as const, error: 'Claude 模型发现 超时' };
beforeEach(() => {
  currentApiMock().override('agentSession.getHarnessModelSelections', async () => ({}));
  currentApiMock().override('agentSession.listLocalHarnessModels', async () => result);
});
afterEach(() => { act(() => { applyLocaleSetting('zh-CN'); }); });

it('updates the scheduled-task model error when the language changes', async () => {
  render(<TaskSessionFields runtime="claude" disabled={false} guiMode="default" onGuiMode={() => {}} piMode="" onPiMode={() => {}}
    modelKey="" onModelKey={() => {}} thinking="" onThinking={() => {}} source={source}/>);
  await screen.findByText(result.error);
  act(() => { applyLocaleSetting('en'); });
  expect(screen.getByText('Claude model discovery timed out.')).toBeTruthy();
  expect(result.error).toBe('Claude 模型发现 超时');
});

it('updates the settings model error when the language changes', async () => {
  render(<HarnessModelSelectionPanel cfg={cfg} runtimeId="claude" active/>);
  await screen.findByText(result.error);
  act(() => { applyLocaleSetting('en'); });
  expect(screen.getByText('Claude model discovery timed out.')).toBeTruthy();
  expect(result.error).toBe('Claude 模型发现 超时');
});

it('opens the workspace directory used as the model catalog source', async () => {
  const api = currentApiMock(); api.override('shell.revealPath', async () => ({ ok: true }));
  render(<HarnessModelSelectionPanel cfg={cfg} runtimeId="claude" active/>);
  expect((screen.getByRole('textbox', { name: '模型目录来源' }) as HTMLInputElement).value).toBe('/workspace');
  await userEvent.click(screen.getByRole('button', { name: '打开模型目录来源的位置' }));
  expect(api.mockOf('shell.revealPath')).toHaveBeenCalledWith('/workspace');
});
