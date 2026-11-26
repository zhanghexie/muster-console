import { randomUUID } from 'node:crypto';
import type { Win32WindowObservation } from './win32Inventory';

export interface Win32CaptureFrame {
  sessionId: string; taskId: string; captureId: string; surfaceId: string; surfaceGeneration: string; geometryRevision: string;
  expiresAt: number; width: number; height: number; sourceSize: { width: number; height: number };
  region: { x: number; y: number; width: number; height: number };
  bounds: { x: number; y: number; width: number; height: number };
  isCurrent(): boolean;
}
type Target = { id: string; frame: Win32CaptureFrame; window: Win32WindowObservation; generation: string };
interface Generations { observe(nativeId: string): string | null; current(nativeId: string, generation: string): boolean; release(nativeId: string, generation: string): void; close(): void }

/** Short-lived host-owned selection; inventory observation IDs never become operation authority. */
export class Win32Targets {
  private readonly targets = new Map<string, Target>();
  constructor(private readonly inventory: () => { windows: Win32WindowObservation[]; complete: boolean },
    private readonly generations: Generations, private readonly now = Date.now) {}

  register(raw: Win32CaptureFrame, offset = 0): { windows: Array<{ windowId: string; title: string; app: string }>; complete: boolean; nextOffset: number | null; unavailable: number } {
    if (!raw || !raw.isCurrent() || raw.expiresAt <= this.now()) throw new Error('Desktop capture is no longer current');
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000) throw new Error('Invalid desktop window offset');
    const snapshot = this.inventory();
    this.cleanup();
    if (this.targets.size >= 512) throw new Error('Desktop window selection capacity reached; wait for earlier captures to expire');
    const frame = Object.freeze({ ...raw, bounds: Object.freeze({ ...raw.bounds }), sourceSize: Object.freeze({ ...raw.sourceSize }), region: Object.freeze({ ...raw.region }) });
    const results = [];
    let eligible = 0, omitted = 0;
    // Meaningful titles first: background helper windows otherwise consume the bounded page.
    const ordered = [...snapshot.windows].sort((a, b) => Number(!!b.title.trim()) - Number(!!a.title.trim()));
    for (const window of ordered) {
      if (!window.processCreated || !window.processImage || window.limitations.includes('window_minimized') || !/^0x[0-9a-f]+$/i.test(window.nativeHandle)) continue;
      const w = window.bounds, b = frame.bounds;
      if (w.x >= b.x + b.width || w.y >= b.y + b.height || w.x + w.width <= b.x || w.y + w.height <= b.y) continue;
      if (eligible++ < offset) continue;
      if (this.targets.size >= 512 || eligible > offset + 12) break;
      const generation = this.generations.observe(window.nativeHandle);
      if (!generation) { omitted++; continue; }
      const id = randomUUID(), copy = { ...window, bounds: { ...window.bounds }, limitations: [...window.limitations] };
      this.targets.set(id, { id, frame, window: copy, generation });
      results.push({ windowId: id, title: window.title.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 120), app: window.processImage.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 120) });
    }
    const hasMore = eligible > offset + 12 || this.targets.size >= 512;
    return { windows: results, complete: snapshot.complete && !hasMore && omitted === 0, nextOffset: hasMore ? offset + Math.min(12, eligible - offset - 1) : null, unavailable: omitted };
  }

  resolve(sessionId: string, taskId: string, id: string): { frame: Win32CaptureFrame; window: Win32WindowObservation; generation: string; isCurrent(): boolean } {
    this.cleanup();
    const target = this.targets.get(id);
    if (!target || target.frame.sessionId !== sessionId || target.frame.taskId !== taskId) throw new Error('Desktop window selection is unavailable');
    const isCurrent = (): boolean => {
      try {
        if (this.targets.get(id) !== target || target.frame.expiresAt <= this.now() || !target.frame.isCurrent() ||
            !this.generations.current(target.window.nativeHandle, target.generation)) return false;
        const snapshot = this.inventory();
        const current = snapshot.windows.find(item => item.nativeHandle === target.window.nativeHandle);
        const old = target.window;
        return !!current && current.pid === old.pid && current.processCreated === old.processCreated && current.processImage === old.processImage &&
          !current.limitations.includes('window_minimized') && (['x', 'y', 'width', 'height'] as const).every(key => current.bounds[key] === old.bounds[key]) &&
          this.generations.current(target.window.nativeHandle, target.generation);
      } catch { return false; }
    };
    if (!isCurrent()) throw new Error('Desktop window selection changed; capture again');
    return { frame: target.frame, window: { ...target.window, bounds: { ...target.window.bounds }, limitations: [...target.window.limitations] },
      generation: target.generation, isCurrent };
  }

  cleanup(): void {
    const removed: Target[] = [];
    for (const [id, target] of this.targets) if (target.frame.expiresAt <= this.now() || !target.frame.isCurrent() ||
      !this.generations.current(target.window.nativeHandle, target.generation)) { this.targets.delete(id); removed.push(target); }
    for (const target of removed) if (![...this.targets.values()].some(value => value.window.nativeHandle === target.window.nativeHandle && value.generation === target.generation)) {
      this.generations.release(target.window.nativeHandle, target.generation);
    }
  }
  close(): void { this.targets.clear(); this.generations.close(); }
}

/** Maps image-local pixels (including crop offset) to Electron DIP for screen conversion. */
export function win32CapturePoint(frame: Win32CaptureFrame, x: number, y: number): { x: number; y: number } {
  if (![x, y].every(Number.isFinite) || x < 0 || y < 0 || x >= frame.width || y >= frame.height ||
      frame.sourceSize.width <= 0 || frame.sourceSize.height <= 0) throw new Error('Point is outside the desktop capture');
  return { x: Math.floor(frame.bounds.x + (frame.region.x + x) * frame.bounds.width / frame.sourceSize.width),
    y: Math.floor(frame.bounds.y + (frame.region.y + y) * frame.bounds.height / frame.sourceSize.height) };
}
