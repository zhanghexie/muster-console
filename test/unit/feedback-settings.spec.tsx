import { renderWithAppTips as render, findAppTip } from './helpers/app-tips';
import React from 'react';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { FeedbackPane } from '../../src/renderer/src/components/settings/FeedbackPane';
import { AboutPane } from '../../src/renderer/src/components/settings/AboutPane';
import { currentApiMock } from './helpers/api-mock';

it('opens the public issue tracker from settings without asking for a token', async () => {
  const api = currentApiMock();
  api.override('shell.openExternal', async () => ({ ok: true }));
  render(<FeedbackPane/>);
  expect(screen.queryByLabelText('反馈令牌')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '打开反馈项目' }));
  await waitFor(() => expect(api.mockOf('shell.openExternal'))
    .toHaveBeenCalledWith('https://github.com/zhanghexie/muster-console/issues'));
});

it('keeps feedback review available while version status is loading', async () => {
  currentApiMock().override('updater.getState', () => new Promise(() => {}));
  await act(async () => { render(<AboutPane/>); });
  expect(screen.getByRole('button', { name: '反馈审核' })).toBeTruthy();
  expect(screen.getByText('加载版本信息…')).toBeTruthy();
});

it('reports a failure to open the issue tracker', async () => {
  currentApiMock().override('shell.openExternal', async () => ({ ok: false }));
  render(<FeedbackPane/>);
  fireEvent.click(screen.getByRole('button', { name: '打开反馈项目' }));
  expect((await findAppTip()).textContent).toContain('无法打开反馈项目');
});
