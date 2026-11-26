import { afterEach, expect, it } from 'vitest';
import { buildBrowserPickerScript } from '../../src/shared/browserPicker';
type PickerWindow = Window & { __maPickCancel?: () => void };
afterEach(() => { (window as PickerWindow).__maPickCancel?.(); });
it('uses the supplied host palette for its real DOM overlay and retains cancel behavior', async () => {
  const appearance = { background: '#352d33', foreground: '#ffffff', shadow: '0 4px 12px rgba(0,0,0,.3)', indicator: '#94caff', fill: 'rgba(148,202,255,.16)' };
  const pending = window.eval(buildBrowserPickerScript(appearance));
  const overlays = [...document.documentElement.querySelectorAll<HTMLDivElement>('div')].filter(el => el.style.position === 'fixed');
  expect(overlays).toHaveLength(2);
  expect(overlays[0].style.background).toBe('rgb(53, 45, 51)');
  expect(overlays[0].style.color).toBe('rgb(255, 255, 255)');
  expect(overlays[1].style.borderColor).toBe('rgb(148, 202, 255)');
  expect(overlays[1].style.background).toBe('rgba(148, 202, 255, 0.16)');
  (window as PickerWindow).__maPickCancel!();
  expect(await pending).toBeNull();
  for (const overlay of overlays) expect(overlay.isConnected).toBe(false);
});
