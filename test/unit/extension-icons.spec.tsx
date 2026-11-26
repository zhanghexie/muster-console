import React from 'react';
import { render } from '@testing-library/react';
import { expect, it } from 'vitest';
import { ExtensionIcon } from '../../src/renderer/src/extensionIcons';
import { extensionIconValue } from '../../src/shared/extensionIcons';

it('renders a bundled extension icon as a currentColor mask span', () => {
  const { container } = render(<ExtensionIcon value={extensionIconValue('calendar')} size={18} />);
  const masked = container.querySelector('span[aria-hidden="true"]');
  expect(masked).toBeTruthy();
  const style = masked?.getAttribute('style') ?? '';
  expect(style).toContain('calendar.svg');
  expect(style).toContain('mask');
  expect(style).toContain('width: 18px');
});

it('keeps legacy short glyphs readable and unknown built-ins safe', () => {
  const { container } = render(<><ExtensionIcon value="📅" /><ExtensionIcon value="builtin-extension:missing" fallback="E" /></>);
  expect(container.textContent).toBe('📅E');
  expect(container.innerHTML).not.toContain('mask');
});
