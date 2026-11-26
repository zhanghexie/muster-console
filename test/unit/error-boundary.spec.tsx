import { renderWithAppTips as render } from './helpers/app-tips';
/**
 * P15：ErrorBoundary 把面板 label 交给 reportRendererError。
 */
import React from 'react';
import { screen } from '@testing-library/react';
import { vi } from 'vitest';
import { ErrorBoundary } from '../../src/renderer/src/components/ErrorBoundary';
import { currentApiMock } from './helpers/api-mock';

function Boom(): React.ReactElement {
  throw new Error('Maximum update depth exceeded');
}

describe('ErrorBoundary 落盘调用', () => {
  it('崩溃时调用 app.reportRendererError 并带面板 label', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const spy = currentApiMock().mockOf('app.reportRendererError');
    spy.mockResolvedValue({ ok: true });

    render(
      <ErrorBoundary label="聊天 Worker">
        <Boom />
      </ErrorBoundary>
    );

    expect(screen.getByText(/聊天 Worker崩溃/)).toBeTruthy();
    expect(spy).toHaveBeenCalled();
    const arg = spy.mock.calls[0][0] as { label: string; message: string; componentStack?: string };
    expect(arg.label).toBe('聊天 Worker');
    expect(arg.message).toMatch(/Maximum update depth/);
    errSpy.mockRestore();
  });
});
