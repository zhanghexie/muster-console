/** Native settings underlay marker follows committed DOM, including Suspense and presence exit. */
import React, { useLayoutEffect, useRef } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { SettingsModal } from '../../src/renderer/src/components/settings/SettingsModal';
import { MOTION, usePresence } from '../../src/renderer/src/components/motion';
import type { AppConfig } from '../../src/shared/types';
import { currentApiMock } from './helpers/api-mock';

type LayoutState = { settingsPresent: boolean; marked: boolean };
type SettingsProps = React.ComponentProps<typeof SettingsModal>;
let previousMaterial: string | null;

function SettingsHost({ open, component: Page = SettingsModal, onLayout }: {
  open: boolean;
  component?: React.ComponentType<SettingsProps>;
  onLayout?: (state: LayoutState) => void;
}) {
  const presence = usePresence(open);
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    onLayout?.({
      settingsPresent: !!root.current?.querySelector(':scope > .settings-page'),
      marked: !!root.current?.classList.contains('has-settings-page')
    });
  });
  return <div ref={root} className="app-shell" data-testid="settings-shell">
    <header className="chrome-bar"><button type="button">工作台动作</button></header>
    <main className="main-view"><input aria-label="工作台草稿" defaultValue="保留草稿" /></main>
    {presence.mounted ? <React.Suspense fallback={null}>
      <Page stage={presence.stage} onClose={() => {}} />
    </React.Suspense> : null}
  </div>;
}

describe('settings native-material underlay lifetime', () => {
  beforeEach(() => {
    previousMaterial = document.documentElement.getAttribute('data-native-material');
    document.documentElement.dataset.nativeMaterial = 'mica';
    vi.useFakeTimers();
    currentApiMock().override('config.get', () => new Promise(() => {}));
    currentApiMock().override('capabilities.get', () => new Promise(() => {}));
    currentApiMock().override('themes.list', () => new Promise(() => {}));
    Element.prototype.scrollIntoView = vi.fn();
  });
  afterEach(() => {
    cleanup();
    if (previousMaterial == null) document.documentElement.removeAttribute('data-native-material');
    else document.documentElement.setAttribute('data-native-material', previousMaterial);
    vi.restoreAllMocks(); vi.useRealTimers();
  });

  it('marks before paint/focus, retains during out, and clears only when the real page unmounts', () => {
    const layouts: LayoutState[] = [];
    const onLayout = (state: LayoutState) => layouts.push(state);
    const view = render(<SettingsHost open={false} onLayout={onLayout} />);
    const shell = screen.getByTestId('settings-shell');
    const draft = screen.getByRole('textbox', { name: '工作台草稿' });
    draft.focus();
    expect(shell.classList.contains('has-settings-page')).toBe(false);
    view.rerender(<SettingsHost open onLayout={onLayout} />);
    const page = screen.getByRole('dialog', { name: '设置' });
    expect(page.parentElement).toBe(shell);
    expect(shell.classList.contains('has-settings-page')).toBe(true);
    expect(shell.querySelector(':scope > .chrome-bar')?.hasAttribute('inert')).toBe(true);
    expect(shell.querySelector(':scope > .main-view')?.hasAttribute('inert')).toBe(true);
    expect(document.activeElement).toBe(page);
    expect(page.dataset.mpStage).toBe('in');
    view.rerender(<SettingsHost open={false} onLayout={onLayout} />);
    expect(page.dataset.mpStage).toBe('out');
    expect(shell.classList.contains('has-settings-page')).toBe(true);
    expect(shell.querySelector(':scope > .main-view')?.hasAttribute('inert')).toBe(true);
    act(() => vi.advanceTimersByTime(MOTION.exitMs + 79));
    expect(shell.querySelector('.settings-page')).toBe(page);
    expect(shell.classList.contains('has-settings-page')).toBe(true);
    act(() => vi.advanceTimersByTime(1));
    expect(shell.querySelector('.settings-page')).toBeNull();
    expect(shell.classList.contains('has-settings-page')).toBe(false);
    expect(shell.querySelector(':scope > .chrome-bar')?.hasAttribute('inert')).toBe(false);
    expect(shell.querySelector(':scope > .main-view')?.hasAttribute('inert')).toBe(false);
    expect(screen.getByRole('textbox', { name: '工作台草稿' })).toBe(draft);
    expect((draft as HTMLInputElement).value).toBe('保留草稿');
    expect(layouts.some(state => state.settingsPresent)).toBe(true);
    expect(layouts.every(state => state.marked === state.settingsPresent)).toBe(true);
  });

  it('does not toggle the root marker for configuration content or first-visited tab insertion', async () => {
    let finish!: (config: AppConfig) => void;
    currentApiMock().override('config.get', () => new Promise<AppConfig>(resolve => { finish = resolve; }));
    const view = render(<SettingsHost open />);
    const shell = screen.getByTestId('settings-shell');
    const page = screen.getByRole('dialog', { name: '设置' });
    const add = vi.spyOn(shell.classList, 'add');
    const remove = vi.spyOn(shell.classList, 'remove');
    await act(async () => finish({
      defaultRuntime: 'cursor', workspace: 'E:/ws', workspaces: [], activeWorkspaceId: null,
      locale: 'zh-CN', mcp: { enabled: false, servers: [] },
      openai: { baseUrl: '', apiKey: '', model: '' }
    } as unknown as AppConfig));
    expect(shell.querySelector('.settings-tabpanes')).not.toBeNull();
    fireEvent.click(within(screen.getByRole('navigation', { name: '设置分组' })).getByRole('button', { name: /^外观/ }));
    expect(shell.querySelector('.settings-tabpane[data-settings-item="appearance"].is-shown')).not.toBeNull();
    expect(screen.getByRole('dialog', { name: '设置' })).toBe(page);
    expect(shell.classList.contains('has-settings-page')).toBe(true);
    expect(add).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    view.unmount();
    expect(remove).toHaveBeenCalledExactlyOnceWith('has-settings-page');
  });

  it('keeps the same marker and page through an interrupted exit and cleans up on host unmount', () => {
    const view = render(<React.StrictMode><SettingsHost open /></React.StrictMode>);
    const shell = screen.getByTestId('settings-shell');
    const page = screen.getByRole('dialog', { name: '设置' });
    expect(shell.classList.contains('has-settings-page')).toBe(true);
    const add = vi.spyOn(shell.classList, 'add');
    const remove = vi.spyOn(shell.classList, 'remove');
    view.rerender(<React.StrictMode><SettingsHost open={false} /></React.StrictMode>);
    act(() => vi.advanceTimersByTime(MOTION.exitMs / 2));
    view.rerender(<React.StrictMode><SettingsHost open /></React.StrictMode>);
    act(() => vi.advanceTimersByTime(MOTION.exitMs + 80));
    expect(shell.querySelector('.settings-page')).toBe(page);
    expect(page.dataset.mpStage).toBe('in');
    expect(shell.classList.contains('has-settings-page')).toBe(true);
    expect(add).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    view.unmount();
    expect(shell.classList.contains('has-settings-page')).toBe(false);
    expect(remove).toHaveBeenCalledExactlyOnceWith('has-settings-page');
  });

  it('leaves the workbench exposed while lazy settings is pending and marks only its committed DOM', async () => {
    let finish!: (module: { default: typeof SettingsModal }) => void;
    const chunk = new Promise<{ default: typeof SettingsModal }>(resolve => { finish = resolve; });
    const LazySettings = React.lazy(() => chunk);
    const view = render(<SettingsHost open component={LazySettings} />);
    const shell = screen.getByTestId('settings-shell');
    const draft = screen.getByRole('textbox', { name: '工作台草稿' });
    expect(shell.querySelector('.settings-page')).toBeNull();
    expect(shell.classList.contains('has-settings-page')).toBe(false);
    draft.focus();
    expect(document.activeElement).toBe(draft);
    await act(async () => finish({ default: SettingsModal }));
    const page = screen.getByRole('dialog', { name: '设置' });
    expect(shell.classList.contains('has-settings-page')).toBe(true);
    expect(document.activeElement).toBe(page);
    view.unmount();
    expect(shell.classList.contains('has-settings-page')).toBe(false);
  });

  it('only marks the direct app-shell parent, matching the original underlay boundary', () => {
    const view = render(<div className="app-shell" data-testid="outer-shell"><main className="main-view"/><section>
      <SettingsModal onClose={() => {}} />
    </section></div>);
    expect(screen.getByTestId('outer-shell').classList.contains('has-settings-page')).toBe(false);
    expect(screen.getByTestId('outer-shell').querySelector('.main-view')?.hasAttribute('inert')).toBe(false);
    view.unmount();
  });

  it('allows a retained modal portal to name its trusted shell and releases it in embedded mode', () => {
    function Host({ embedded }: { embedded: boolean }) {
      const [shell, setShell] = React.useState<HTMLDivElement | null>(null);
      return <div className="app-shell" ref={setShell} data-testid="portal-shell">
        <main className="main-view"/><section><SettingsModal modalShell={shell}
          presentation={embedded ? 'embedded' : 'modal'} onClose={() => {}} /></section>
      </div>;
    }
    const view = render(<Host embedded={false} />);
    const shell = screen.getByTestId('portal-shell');
    expect(shell.classList.contains('has-settings-page')).toBe(true);
    view.rerender(<Host embedded />);
    expect(shell.classList.contains('has-settings-page')).toBe(false);
    view.unmount();
  });

  it('restores each previous inert value through interrupted exit and StrictMode, touching only direct underlay siblings', () => {
    function Host({ open }: { open: boolean }) {
      const presence = usePresence(open);
      return <div className="app-shell" data-testid="inert-shell">
        <header className="chrome-bar"/>
        <main className="main-view"><div className="chrome-bar" data-testid="nested-in-main"/></main>
        <section><div className="main-view" data-testid="nested-in-other"/></section>
        <aside data-testid="unrelated-sibling"/>
        {presence.mounted ? <SettingsModal stage={presence.stage} onClose={() => {}}/> : null}
      </div>;
    }
    const view = render(<React.StrictMode><Host open={false}/></React.StrictMode>);
    const shell = screen.getByTestId('inert-shell');
    const chrome = shell.querySelector<HTMLElement>(':scope > .chrome-bar')!;
    const main = shell.querySelector<HTMLElement>(':scope > .main-view')!;
    chrome.setAttribute('inert', 'existing-owner');
    view.rerender(<React.StrictMode><Host open/></React.StrictMode>);
    expect(chrome.hasAttribute('inert')).toBe(true);
    expect(main.hasAttribute('inert')).toBe(true);
    expect(screen.getByTestId('nested-in-main').hasAttribute('inert')).toBe(false);
    expect(screen.getByTestId('nested-in-other').hasAttribute('inert')).toBe(false);
    expect(screen.getByTestId('unrelated-sibling').hasAttribute('inert')).toBe(false);
    view.rerender(<React.StrictMode><Host open={false}/></React.StrictMode>);
    act(() => vi.advanceTimersByTime(MOTION.exitMs / 2));
    expect(main.hasAttribute('inert')).toBe(true);
    view.rerender(<React.StrictMode><Host open/></React.StrictMode>);
    act(() => vi.advanceTimersByTime(MOTION.exitMs + 80));
    expect(main.hasAttribute('inert')).toBe(true);
    view.unmount();
    expect(chrome.getAttribute('inert')).toBe('existing-owner');
    expect(main.hasAttribute('inert')).toBe(false);
  });

  it('tracks late native confirmation and solid fallback while preserving original inert state', async () => {
    document.documentElement.dataset.nativeMaterial = 'solid';
    const view = render(<SettingsHost open/>);
    const shell = screen.getByTestId('settings-shell');
    const chrome = shell.querySelector<HTMLElement>(':scope > .chrome-bar')!;
    const main = shell.querySelector<HTMLElement>(':scope > .main-view')!;
    expect(main.hasAttribute('inert')).toBe(false);
    chrome.setAttribute('inert', 'solid-owner');
    await act(async () => { document.documentElement.dataset.nativeMaterial = 'vibrancy'; });
    expect(main.hasAttribute('inert')).toBe(true);
    expect(chrome.hasAttribute('inert')).toBe(true);
    await act(async () => { document.documentElement.dataset.nativeMaterial = 'solid'; });
    expect(main.hasAttribute('inert')).toBe(false);
    expect(chrome.getAttribute('inert')).toBe('solid-owner');
    await act(async () => { document.documentElement.dataset.nativeMaterial = 'mica'; });
    expect(main.hasAttribute('inert')).toBe(true);
    view.unmount();
    expect(main.hasAttribute('inert')).toBe(false);
    expect(chrome.getAttribute('inert')).toBe('solid-owner');
  });
});
