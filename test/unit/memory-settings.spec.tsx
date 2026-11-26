import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryPane } from '../../src/renderer/src/components/settings/MemoryPane';
import { currentApiMock } from './helpers/api-mock';

test('记忆设置只保留自动整理开关，模型选择移到会话输入框', async () => {
  const mock = currentApiMock();
  let config: any = { memoryConsolidation: { enabled: true, providerId: 'legacy-provider', modelId: 'legacy-model' } };
  mock.mockOf('config.get').mockImplementation(async () => config);
  mock.mockOf('config.update').mockImplementation(async (patch: any) => {
    config = { ...config, ...patch };
    return config;
  });
  render(<MemoryPane />);
  const control = await screen.findByRole('checkbox', { name: '按需自动整理记忆' }) as HTMLInputElement;
  await waitFor(() => expect(control.disabled).toBe(false));
  expect(screen.queryByRole('button', { name: '记忆子系统 LLM' })).toBeNull();
  expect(screen.queryByText('整理模型')).toBeNull();
  expect(screen.getAllByText(/输入框/).length).toBeGreaterThan(0);
  await userEvent.setup().click(control);
  await waitFor(() => expect(config.memoryConsolidation.enabled).toBe(false));
  expect(config.memoryConsolidation.providerId).toBe('legacy-provider');
});
