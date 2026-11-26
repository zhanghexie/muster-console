import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { DesktopIndicatorSnapshot } from '../../shared/desktopIndicator';
import { builtinTheme } from '../../shared/theme';
import { resolveAppearance } from '../../shared/resolvedAppearance';
import { DesktopIndicator } from './components/DesktopIndicator';
import './styles/base.css';

declare global {
  interface Window {
    desktopIndicator: {
      connect(): Promise<DesktopIndicatorSnapshot>;
      ready(revision: number): Promise<void>;
      stop(revision: number): Promise<void>;
      onChanged(callback: (state: DesktopIndicatorSnapshot) => void): () => void;
    };
  }
}

function IndicatorApp() {
  const [snapshot, setSnapshot] = useState<DesktopIndicatorSnapshot | null>(null);
  useEffect(() => {
    let live = true;
    const accept = (next: DesktopIndicatorSnapshot) => {
      if (live) setSnapshot(current => !current || next.revision > current.revision ? next : current);
    };
    const off = window.desktopIndicator.onChanged(accept);
    void window.desktopIndicator.connect().then(accept).catch(error => console.error('[desktop-indicator] connect failed', error));
    return () => { live = false; off(); };
  }, []);
  useEffect(() => {
    if (!snapshot) return;
    const theme = snapshot.theme ?? builtinTheme('dark')!;
    const root = document.documentElement;
    root.dataset.theme = theme.appearance;
    root.style.colorScheme = theme.appearance;
    const appearance = resolveAppearance(theme, { workspaceId: null, accent: '#8b7bff', enabled: false }, snapshot.revision);
    for (const [key, value] of Object.entries(appearance.cssVars)) root.style.setProperty(key, value);
    void window.desktopIndicator.ready(snapshot.revision).catch(error => console.error('[desktop-indicator] ready failed', error));
  }, [snapshot?.revision]);
  if (!snapshot) return null;
  return <DesktopIndicator {...snapshot} onStop={() => {
    void window.desktopIndicator.stop(snapshot.revision).catch(error => {
      console.error('[desktop-indicator] stop failed', error);
      setSnapshot(current => current?.revision === snapshot.revision ? { ...current, state: 'unknown' } : current);
    });
  }} />;
}

createRoot(document.getElementById('root')!).render(<IndicatorApp />);
