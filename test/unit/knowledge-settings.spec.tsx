import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { KnowledgeProcessingSetting } from '../../src/renderer/src/components/settings/MemoryPane';
import { currentApiMock } from './helpers/api-mock';

test('processing switch preserves legacy model fields but settings no longer exposes a picker', async () => {
  const mock = currentApiMock();
  const config: any = { memoryConsolidation: { enabled: true, providerId: 'chosen', modelId: 'model' } };
  mock.mockOf('config.get').mockResolvedValue(config);
  mock.mockOf('config.update').mockRejectedValueOnce(new Error('保存失败')).mockResolvedValue({ memoryConsolidation: { ...config.memoryConsolidation, enabled: false } });
  render(<KnowledgeProcessingSetting />);
  const control = screen.getByRole('checkbox', { name: '按需自动整理记忆' }) as HTMLInputElement;
  await waitFor(() => expect(control.disabled).toBe(false));
  expect(screen.queryByRole('button', { name: '记忆子系统 LLM' })).toBeNull();
  const user = userEvent.setup();
  await user.click(control);
  expect((await screen.findByRole('alert')).textContent).toContain('保存失败');
  expect(control.checked).toBe(true);
  await user.click(control);
  await waitFor(() => expect(control.checked).toBe(false));
  expect(mock.mockOf('config.update')).toHaveBeenCalledWith({ memoryConsolidation: { enabled: false, providerId: 'chosen', modelId: 'model' } });
});
