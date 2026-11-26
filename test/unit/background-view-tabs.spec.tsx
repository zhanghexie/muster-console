import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { BackgroundViewTabs } from '../../src/renderer/src/components/BackgroundViewTabs';

describe('background view tabs', () => {
  it('selects and closes existing entries independently and makes an exiting tray inert', () => {
    const select = vi.fn(), close = vi.fn();
    const tab = { id: 'settings', label: '设置', onSelect: select, onClose: close };
    const view = render(<BackgroundViewTabs tabs={[tab]}/>);
    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    expect(select).toHaveBeenCalledTimes(1); expect(close).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '关闭 设置' }));
    expect(close).toHaveBeenCalledTimes(1); expect(select).toHaveBeenCalledTimes(1);
    view.rerender(<BackgroundViewTabs tabs={[]}/>);
    const tray = view.container.querySelector('.center-background-tabs');
    if (tray) { expect(tray.getAttribute('data-mp-stage')).toBe('out'); expect(tray.hasAttribute('inert')).toBe(true); }
    view.rerender(<BackgroundViewTabs tabs={[tab]}/>);
    expect(screen.getByRole('button', { name: '设置' })).toBeTruthy();
  });
});
