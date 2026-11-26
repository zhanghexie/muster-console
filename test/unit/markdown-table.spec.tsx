import React from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { MarkdownBody } from '../../src/renderer/src/components/MarkdownBody';

const source = '| Month | Total | Note |\n| --- | ---: | --- |\n| February | 18 | Last column |';

describe('MarkdownBody tables', () => {
  it('provides keyboard access to scrolling without replacing table semantics', async () => {
    const user = userEvent.setup();
    render(<MarkdownBody text={source} />);
    const region = screen.getByRole('region', { name: '表格' });
    await user.tab();
    expect(document.activeElement).toBe(region);
    const table = within(region).getByRole('table');
    expect(within(table).getByRole('columnheader', { name: 'Total' }).getAttribute('scope')).toBe('col');
    expect(within(table).getByRole('cell', { name: 'Last column' })).toBeTruthy();
  });

  it('leaves static display-only previews without a new focus stop', async () => {
    const user = userEvent.setup();
    render(<><MarkdownBody text={source} displayOnly /><button type="button">Continue</button></>);
    expect(screen.queryByRole('region', { name: '表格' })).toBeNull();
    expect(screen.getByRole('table')).toBeTruthy();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Continue' }));
  });
});
