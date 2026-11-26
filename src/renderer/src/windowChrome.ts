import { isWebGateway } from './webGatewayEnvironment';

type ChromeColors = { panel: string; ink: string; appearance?: 'dark' | 'light' };
let requestVersion = 0;

/** Reveal the native backdrop only after the desktop host confirms it. */
export async function syncWindowChrome(colors: ChromeColors): Promise<void> {
  const version = ++requestVersion;
  const root = document.documentElement;
  const desktop = !isWebGateway();
  if (!desktop) root.dataset.nativeMaterial = 'solid';
  try {
    const result = await window.api?.app?.setChromeTheme?.(colors);
    if (version !== requestVersion) return;
    const material = result?.ok && (result.material === 'mica' || result.material === 'vibrancy')
      ? result.material
      : 'solid';
    root.dataset.nativeMaterial = desktop ? material : 'solid';
  } catch (error) {
    if (version !== requestVersion) return;
    root.dataset.nativeMaterial = 'solid';
    console.warn('[window-material] theme synchronization failed; retaining opaque surfaces', error);
  }
}
