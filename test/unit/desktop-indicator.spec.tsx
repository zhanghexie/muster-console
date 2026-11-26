import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DesktopIndicator, type DesktopIndicatorProps } from '../../src/renderer/src/components/DesktopIndicator';

const labels = { active: 'Using computer', stopping: 'Stopping', unknown: 'Result unknown', escape: 'Esc to stop',
  stop: 'Stop', escapeUnavailable: 'Use the stop button' };

it('shows the target and sends stop through the visible control', async () => {
  const onStop = vi.fn();
  const props: DesktopIndicatorProps = { state: 'active', target: 'Fixture', escapeAvailable: true, labels, onStop };
  const { rerender } = render(<DesktopIndicator {...props} />);
  expect(screen.getByText('Fixture')).toBeTruthy();
  expect(screen.getByText('Esc to stop')).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
  expect(onStop).toHaveBeenCalledTimes(1);
  rerender(<DesktopIndicator {...props} state="stopping" escapeAvailable={false} />);
  expect((screen.getByRole('button', { name: 'Stop' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByText('Use the stop button')).toBeNull();
  rerender(<DesktopIndicator {...props} escapeAvailable={false} />);
  expect(screen.getByText('Use the stop button')).toBeTruthy();
  rerender(<DesktopIndicator {...props} state="unknown" />);
  expect(screen.getByRole('status').textContent).toBe('Result unknown');
});
