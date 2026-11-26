import React from 'react';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { utils, write } from 'xlsx';
import { FileDocPreview } from '../../src/renderer/src/components/FileDocPreview';
import { applyLocaleSetting, getResolvedLocale } from '../../src/shared/i18n';

const renderWord = vi.hoisted(() => vi.fn(async (_data: ArrayBuffer, _host: HTMLElement) => ({ kind: 'word' })));
vi.mock('docx-preview', () => ({ renderAsync: renderWord }));

function workbookResponse(): Response {
  const workbook = utils.book_new();
  const first = utils.aoa_to_sheet([
    ['A < B & C', 'Merged cells', ''],
    [0.125, 'Documentation', 'Reference']
  ]);
  first.A2.z = '0.0%';
  first.B2.l = { Target: 'https://example.com/docs' };
  first.C2.l = { Target: 'urn:example:reference' };
  first['!merges'] = [utils.decode_range('B1:C1')];
  utils.book_append_sheet(workbook, first, 'Summary');
  utils.book_append_sheet(workbook, utils.aoa_to_sheet([['Detail value']]), 'Details');
  return new Response(write(workbook, { type: 'array', bookType: 'xlsx' }));
}

afterEach(() => {
  renderWord.mockReset();
  vi.unstubAllGlobals();
});

describe('FileDocPreview', () => {
  it('passes a configuration that keeps alternate HTML parts out of Word previews', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1]))));
    render(<FileDocPreview workspaceId="test" path="example.docx" kind="word" />);
    await waitFor(() => expect(renderWord).toHaveBeenCalledWith(
      expect.anything(), expect.any(HTMLDivElement), undefined,
      expect.objectContaining({ renderAltChunks: false })
    ));
  });

  it('isolates a superseded Word render when the interface locale changes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1]))));
    const pending: Array<{ host: HTMLElement; finish: (label: string) => void }> = [];
    renderWord.mockImplementation((_data, host) => new Promise(resolve => {
      pending.push({ host, finish: label => {
        // The renderer writes into its host after awaiting the document parse.
        host.replaceChildren(label);
        resolve({ kind: 'word' });
      } });
    }));
    const locale = getResolvedLocale();
    const view = render(<FileDocPreview workspaceId="test" path="example.docx" kind="word" />);
    try {
      await waitFor(() => expect(pending).toHaveLength(1));
      expect(pending[0].host.isConnected).toBe(true);
      await act(async () => { applyLocaleSetting(locale === 'en' ? 'zh-CN' : 'en'); });
      await waitFor(() => expect(pending).toHaveLength(2));
      expect(pending[1].host.isConnected).toBe(true);
      await act(async () => { pending[1].finish('Current Word render'); });
      await act(async () => { pending[0].finish('Old Word render'); });
      expect(screen.getByText('Current Word render')).toBeTruthy();
      expect(screen.queryByText('Old Word render')).toBeNull();
      expect(pending[0].host.isConnected).toBe(false);
    } finally {
      view.unmount();
      applyLocaleSetting(locale);
    }
  });

  it('preserves formatted text and merged cells and only exposes supported links', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => workbookResponse()));
    render(<FileDocPreview workspaceId="test" path="example.xlsx" kind="sheet" />);
    const table = await screen.findByRole('table');
    expect(within(table).getByText('A < B & C')).toBeTruthy();
    expect(within(table).getByText('Merged cells').getAttribute('colspan')).toBe('2');
    expect(within(table).getByText('12.5%')).toBeTruthy();
    const link = within(table).getByRole('link', { name: 'Documentation' });
    expect(link.getAttribute('href')).toBe('https://example.com/docs');
    expect(link.getAttribute('rel')).toBe('noreferrer noopener');
    expect(within(table).getByText('Reference').closest('a')).toBeNull();
  });

  it('moves focus with arrow keys and activates the focused sheet with Enter', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => workbookResponse()));
    const user = userEvent.setup();
    render(<FileDocPreview workspaceId="test" path="example.xlsx" kind="sheet" />);
    const tabs = await screen.findByRole('tablist', { name: 'example.xlsx' });
    const summary = within(tabs).getByRole('tab', { name: 'Summary', selected: true });
    const details = within(tabs).getByRole('tab', { name: 'Details', selected: false });
    await user.tab();
    expect(document.activeElement).toBe(summary);
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(details);
    expect(screen.getByRole('tabpanel', { name: 'Summary' })).toBeTruthy();
    await user.keyboard('{Enter}');
    expect(details.getAttribute('aria-selected')).toBe('true');
    await user.tab();
    const panel = screen.getByRole('tabpanel', { name: 'Details' });
    expect(details.getAttribute('aria-controls')).toBe(panel.id);
    expect(panel.getAttribute('aria-labelledby')).toBe(details.id);
    expect(document.activeElement).toBe(panel);
    expect(within(panel).getByText('Detail value')).toBeTruthy();
  });

  it('aborts the previous file transfer on replacement and the current transfer on unmount', async () => {
    const signals: AbortSignal[] = [];
    const request = vi.fn((_url: string, options?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      if (options?.signal) {
        signals.push(options.signal);
        options.signal.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
      }
    }));
    vi.stubGlobal('fetch', request);
    const view = render(<FileDocPreview workspaceId="test" path="first.xlsx" kind="sheet" />);
    view.rerender(<FileDocPreview workspaceId="test" path="second.xlsx" kind="sheet" />);
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(signals.map(signal => signal.aborted)).toEqual([true, false]);
    view.unmount();
    expect(signals.map(signal => signal.aborted)).toEqual([true, true]);
  });
});
