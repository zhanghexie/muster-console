import type { DemoRecordingBridge } from '../../../shared/demoReplay';

export const privateFields = 'input[type="password"], .llm-password-input-wrap, [autocomplete="current-password"], [autocomplete="new-password"], [data-demo-private]';
const selector = '.xterm-screen, canvas, iframe, webview, video';

/** DOM replay cannot reconstruct a GPU canvas or a separate-origin extension.
 * Store only the visible surface as a timed image node; ordinary UI remains structured DOM. */
export function recordSurfaces(bridge: DemoRecordingBridge, id: string, onFailure: (error: unknown) => void) {
  const images = new Map<HTMLElement, HTMLImageElement>();
  let stopped = false, timer: ReturnType<typeof setTimeout>;
  async function update() {
    const visible = new Set<HTMLElement>();
    try {
      if (!document.hidden) for (const target of document.querySelectorAll<HTMLElement>(selector)) {
        if (!target.checkVisibility() || target.closest(privateFields) || (target.tagName === 'CANVAS' && target.closest('.xterm-screen'))) continue;
        // Third-party browser guests may show logins or other external pages. Only local panes are sampled.
        if (target.matches('iframe,webview') && !/^(muster-[a-z-]+:|about:|file:|blob:|$)/.test(target.getAttribute('src') ?? '')) continue;
        const box = target.getBoundingClientRect(), x = Math.max(0, box.left), y = Math.max(0, box.top);
        const width = Math.min(innerWidth, box.right) - x, height = Math.min(innerHeight, box.bottom) - y;
        if (width < 3 || height < 3) continue;
        const hit = document.elementFromPoint(x + width / 2, y + height / 2);
        if (!hit || !(target.contains(hit) || hit.contains(target))) continue;
        const overlapsPrivate = [...document.querySelectorAll(privateFields)].some(el => {
          const b = el.getBoundingClientRect();
          return el.checkVisibility() && b.width && b.height && b.left < x + width && b.right > x && b.top < y + height && b.bottom > y;
        });
        if (overlapsPrivate) continue;
        visible.add(target);
        const src = await bridge.surface(id, { x, y, width, height });
        if (stopped) return;
        if (!src || !target.isConnected) continue;
        let image = images.get(target);
        if (!image) {
          image = document.createElement('img');
          image.setAttribute('aria-hidden', 'true');
          image.setAttribute('data-muster-demo-surface', '');
          Object.assign(image.style, { display: 'none', position: 'absolute', pointerEvents: 'none', maxWidth: 'none', maxHeight: 'none',
            margin: '0', padding: '0', border: '0', zIndex: getComputedStyle(target).zIndex });
          target.after(image); images.set(target, image);
        }
        const sx = target.offsetWidth / box.width, sy = target.offsetHeight / box.height;
        const geometry = { left: target.offsetLeft + (x - box.left) * sx, top: target.offsetTop + (y - box.top) * sy,
          width: width * sx, height: height * sy };
        for (const [key, value] of Object.entries(geometry)) {
          const css = value + 'px';
          if (image.style.getPropertyValue(key) !== css) image.style.setProperty(key, css);
        }
        if (image.getAttribute('src') !== src) image.src = src;
      }
    } catch (error) { if (!stopped) onFailure(error); }
    for (const [target, image] of images) {
      if (!visible.has(target) || !target.isConnected) { image.remove(); images.delete(target); }
    }
    if (!stopped) timer = setTimeout(() => void update(), 250);
  }
  timer = setTimeout(() => void update(), 250);
  return () => { stopped = true; clearTimeout(timer); for (const image of images.values()) image.remove(); images.clear(); };
}
