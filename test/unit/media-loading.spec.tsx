import React from 'react';
import { it, expect } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FileMediaPreview } from '../../src/renderer/src/components/FileMediaPreview';
import { currentApiMock } from './helpers/api-mock';

it.each(['load', 'error', 'stat-error'] as const)('图片预览 %s 都结束等待', async result => {
  currentApiMock().override('fs.stat', async () => {
    if (result === 'stat-error') throw new Error('stat offline');
    return { ok: true, isFile: true, size: 50 };
  });
  const { container } = render(<FileMediaPreview workspaceId="w" path="a.png" kind="image" />);
  expect(container.querySelectorAll('.brand-loader')).toHaveLength(1);
  await act(async () => {});
  if (result === 'load') fireEvent.load(screen.getByRole('img'));
  if (result === 'error') fireEvent.error(screen.getByRole('img'));
  await waitFor(() => expect(container.querySelector('.brand-loader')).toBeNull());
  if (result !== 'load') expect(screen.getByText('无法预览')).toBeTruthy();
});
