import React from 'react';
import { render } from '@testing-library/react';
import { useWorkspaceMaterial } from '../../src/renderer/src/useWorkspaceMaterial';
import { applyTheme } from '../../src/renderer/src/theme';
import { builtinTheme } from '../../src/shared/theme';

function Material({ enabled }: { enabled: boolean }): null {
  useWorkspaceMaterial(enabled);
  return null;
}

afterEach(() => { delete document.documentElement.dataset.workspaceMaterial; });

it('enables the material with theme color, restores solid when disabled, and clears on unmount', () => {
  const view = render(<Material enabled />);
  expect(document.documentElement.dataset.workspaceMaterial).toBe('frosted');
  view.rerender(<Material enabled={false} />);
  expect(document.documentElement.dataset.workspaceMaterial).toBe('solid');
  view.rerender(<Material enabled />);
  expect(document.documentElement.dataset.workspaceMaterial).toBe('frosted');
  view.unmount();
  expect(document.documentElement.dataset.workspaceMaterial).toBeUndefined();
});

it('keeps the material when the production theme changes between light and dark', () => {
  render(<Material enabled />);
  applyTheme(builtinTheme('light')!);
  expect(document.documentElement.dataset.theme).toBe('light');
  expect(document.documentElement.dataset.workspaceMaterial).toBe('frosted');
  applyTheme(builtinTheme('dark')!);
  expect(document.documentElement.dataset.theme).toBe('dark');
  expect(document.documentElement.dataset.workspaceMaterial).toBe('frosted');
});
