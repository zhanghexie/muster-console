import { nativeImage } from 'electron';
import type { Page } from 'playwright-core';

interface Point { x: number; y: number }
interface CaptureWindow {
  innerWidth: number;
  innerHeight: number;
  devicePixelRatio: number;
  visualViewport: { scale: number } | null;
  document: { scrollingElement: CaptureRoot | null };
  getComputedStyle(element: CaptureRoot): { direction: string; scrollSnapType: string };
  requestAnimationFrame(callback: () => void): number;
}
interface CaptureRoot {
  clientWidth: number;
  clientHeight: number;
  clientLeft: number;
  scrollWidth: number;
  scrollHeight: number;
  scrollLeft: number;
  scrollTop: number;
  scrollTo(options: { left: number; top: number; behavior: 'instant' }): void;
  style: {
    getPropertyValue(name: string): string;
    getPropertyPriority(name: string): string;
    setProperty(name: string, value: string, priority: string): void;
  };
}

const CAPTURE_TIMEOUT_MS = 30_000;
const MAX_IMAGE_PIXELS = 40_000_000;
const MAX_IMAGE_DIMENSION = 32_767;
const BYTES_PER_PIXEL = 4;

/** Chromium can repeat the source surface when a webview's capture extends past its viewport. */
export async function captureFullPageScreenshot(page: Page, assertGuestCurrent: () => void, signal: AbortSignal): Promise<Buffer> {
  const deadline = Date.now() + CAPTURE_TIMEOUT_MS;
  // Keep scroll and cleanup bound to the original document if the tab navigates.
  const capture = await page.evaluateHandle(() => {
    const view = globalThis as unknown as CaptureWindow;
    const root = view.document.scrollingElement;
    if (!root || !root.clientWidth || !root.clientHeight) throw new Error('The page has no visible scrolling viewport');
    const computed = view.getComputedStyle(root);
    const originX = computed.direction === 'rtl' ? root.clientWidth - root.scrollWidth : 0;
    const start = { left: root.scrollLeft, top: root.scrollTop };
    const snap = 'scroll-snap-type';
    const disableSnap = computed.scrollSnapType !== 'none';
    const snapValue = root.style.getPropertyValue(snap), snapPriority = root.style.getPropertyPriority(snap);
    const position = (): Point => ({ x: root.scrollLeft - originX, y: root.scrollTop });
    let moved = false;
    return {
      geometry: {
        width: root.scrollWidth, height: root.scrollHeight,
        visibleWidth: root.clientWidth, visibleHeight: root.clientHeight,
        viewportWidth: view.innerWidth, viewportHeight: view.innerHeight,
        viewportScale: view.visualViewport?.scale ?? 1,
        scale: view.devicePixelRatio, insetX: root.clientLeft
      },
      position,
      async scroll({ x, y }: Point): Promise<Point> {
        if (!moved && disableSnap) root.style.setProperty(snap, 'none', 'important');
        moved = true;
        root.scrollTo({ left: originX + x, top: y, behavior: 'instant' });
        // Let the guest commit the scroll before copying from its compositor surface.
        await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, 200);
          view.requestAnimationFrame(() => view.requestAnimationFrame(() => {
            clearTimeout(timer);
            resolve();
          }));
        });
        return position();
      },
      restore(): void {
        if (!moved) return;
        try { root.scrollTo({ ...start, behavior: 'instant' }); }
        finally { if (disableSnap) root.style.setProperty(snap, snapValue, snapPriority); }
      }
    };
  });

  let completed = false;
  try {
    const geometry = await capture.evaluate(state => state.geometry);
    if (geometry.viewportScale !== 1) throw new Error('Reset pinch zoom before capturing the full page');
    const pixels = (css: number): number => Math.round(css * geometry.scale);
    const width = pixels(geometry.width), height = pixels(geometry.height);
    if (!width || !height || width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION || width * height > MAX_IMAGE_PIXELS) {
      throw new Error(`Full-page screenshot size ${width}×${height} exceeds the bitmap limit. Capture a viewport or an element instead.`);
    }
    const bitmap = Buffer.alloc(width * height * BYTES_PER_PIXEL);
    // Leave a small overlap so fractional scroll and display scales cannot open a seam.
    const columnWidth = geometry.width <= geometry.visibleWidth ? geometry.width : Math.max(1, geometry.visibleWidth - 2);
    const rowHeight = geometry.height <= geometry.visibleHeight ? geometry.height : Math.max(1, geometry.visibleHeight - 2);
    for (let y = 0; y < geometry.height; y += rowHeight) {
      for (let x = 0; x < geometry.width; x += columnWidth) {
        signal.throwIfAborted();
        assertGuestCurrent();
        const scroll = await capture.evaluate((state, point) => state.scroll(point),
          { x: Math.max(0, x - 1), y: Math.max(0, y - 1) });
        signal.throwIfAborted();
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error('Full-page screenshot timed out while capturing viewports');
        const png = await page.screenshot({ type: 'png', timeout: remaining });
        const currentScroll = await capture.evaluate(state => state.position());
        if (currentScroll.x !== scroll.x || currentScroll.y !== scroll.y) {
          throw new Error('The page scrolled during capture. Retry when the page is stable.');
        }
        const frame = nativeImage.createFromBuffer(png), frameSize = frame.getSize();
        if (frame.isEmpty() || Math.abs(frameSize.width - pixels(geometry.viewportWidth)) > 1 ||
            Math.abs(frameSize.height - pixels(geometry.viewportHeight)) > 1) {
          throw new Error('The page viewport changed during the full-page screenshot');
        }
        const sourceX = pixels(x - scroll.x + geometry.insetX), sourceY = pixels(y - scroll.y);
        const destinationX = pixels(x), destinationY = pixels(y);
        const columns = pixels(Math.min(geometry.width, x + columnWidth)) - destinationX;
        const rows = pixels(Math.min(geometry.height, y + rowHeight)) - destinationY;
        const frameBitmap = frame.toBitmap();
        if (sourceX < 0 || sourceY < 0 || sourceX + columns > frameSize.width || sourceY + rows > frameSize.height ||
            frameBitmap.length !== frameSize.width * frameSize.height * BYTES_PER_PIXEL) {
          throw new Error('The page did not scroll to cover the requested region');
        }
        for (let row = 0; row < rows; row++) {
          const from = ((sourceY + row) * frameSize.width + sourceX) * BYTES_PER_PIXEL;
          const to = ((destinationY + row) * width + destinationX) * BYTES_PER_PIXEL;
          frameBitmap.copy(bitmap, to, from, from + columns * BYTES_PER_PIXEL);
        }
      }
    }
    signal.throwIfAborted();
    assertGuestCurrent();
    const png = nativeImage.createFromBitmap(bitmap, { width, height }).toPNG();
    if (!png.length) throw new Error('Failed to encode the full-page screenshot');
    completed = true;
    return png;
  } finally {
    try { await capture.evaluate(state => state.restore()); }
    catch (error) { if (completed) throw error; }
    finally { await capture.dispose().catch(() => {}); }
  }
}
