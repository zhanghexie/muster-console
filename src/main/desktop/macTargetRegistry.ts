import { randomUUID } from 'node:crypto';
import { capturePointToInput } from './captureTransform';
import type { DisplayCaptureTarget } from './displayCapture';
import type { TrustedDisplayActor } from './displayService';
import { enumerateMacWindows, readMacWindow, type MacWindowRow } from './macInventory';
import { MacWindowIdentity, type MacWindowIdentityNative } from './macWindowIdentity';
import type { MacWindowNative } from './macWindowNative';
import type { DesktopScreenRuntime } from './screenRuntime';

type Point = { x: number; y: number };
type Bounds = MacWindowRow['bounds'];
type Capture = Awaited<ReturnType<DesktopScreenRuntime['look']>>;
type Frame = Pick<Capture, 'captureId' | 'surfaceId' | 'surfaceGeneration' | 'geometryRevision' | 'width' | 'height' | 'sourceSize' | 'region' | 'expiresAt' | 'coordinateSpace'>;
type Entry = {
  window: MacWindowRow;
  generation: string;
  release(): void;
  isIdentityCurrent(): boolean;
  isCurrent(): boolean;
};
type Selection = Entry & { frame: Frame; display: DisplayCaptureTarget; actor: TrustedDisplayActor };

const PAGE_SIZE = 12;
const MAX_TARGETS = 512;
const clean = (value: string | null) => (value ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ').slice(0, 120);
const overlaps = (a: Bounds, b: Bounds) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
const contains = (bounds: Bounds, point: Point) => point.x >= bounds.x && point.x < bounds.x + bounds.width &&
  point.y >= bounds.y && point.y < bounds.y + bounds.height;
export const sameMacBounds = (a: Bounds, b: Bounds) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

/** Bind window identities before capture and publish only those still current afterwards. */
export class MacTargetRegistry {
  private readonly targets = new Map<string, Selection>();
  private readonly cleanupGroups = new Set<() => void>();
  private readonly generations = new Map<number, { identity: MacWindowIdentity; generation: string; users: number }>();
  private cleanupError?: Error;

  constructor(private readonly native: MacWindowIdentityNative & Partial<Pick<MacWindowNative, 'windowAtPoint'>>, private readonly inventory = enumerateMacWindows,
    private readonly readWindow = readMacWindow, private readonly now = Date.now) {}

  prepare(actor: TrustedDisplayActor, display: DisplayCaptureTarget, lifetime: AbortSignal, offset = 0) {
    if (this.cleanupError) throw this.cleanupError;
    if (!actor.isCurrent() || lifetime.aborted) throw new Error('Desktop capture is no longer current');
    const snapshot = this.inventory();
    const eligible = snapshot.windows.filter(row => row.layer === 0 && row.alpha !== 0 && overlaps(row.bounds, display.bounds));
    const rows = eligible.slice(offset, offset + PAGE_SIZE);
    const ids: string[] = [];
    const entries: Entry[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (!this.cleanupGroups.delete(cleanup)) return;
      clearTimeout(timer);
      lifetime.removeEventListener('abort', cleanup);
      for (const id of ids) this.targets.delete(id);
      for (const entry of entries) {
        try { entry.release(); } catch (error) { this.cleanupError ??= new Error('macOS window reference cleanup failed', { cause: error }); }
      }
    };
    this.cleanupGroups.add(cleanup);
    lifetime.addEventListener('abort', cleanup, { once: true });
    let unavailable = 0;
    for (const window of rows) {
      try {
        if (this.targets.size + entries.length >= MAX_TARGETS) throw new Error('Desktop target capacity reached');
        let generation = this.generations.get(window.windowId);
        if (!generation || generation.identity.pid !== window.pid || !generation.identity.current()) {
          generation = { identity: MacWindowIdentity.acquire(this.native, window.pid, window.windowId), generation: randomUUID(), users: 0 };
          this.generations.set(window.windowId, generation);
        }
        const selected = generation;
        selected.users++;
        const release = () => {
          if (--selected.users !== 0) return;
          if (this.generations.get(window.windowId) === selected) this.generations.delete(window.windowId);
          selected.identity.close();
        };
        const isIdentityCurrent = () => !lifetime.aborted && actor.isCurrent() && selected.identity.current();
        let geometryCurrent = true;
        const isCurrent = () => {
          if (!geometryCurrent || !isIdentityCurrent()) return false;
          const current = this.readWindow(window.windowId);
          geometryCurrent = !!current && current.pid === window.pid && current.layer === 0 && current.onScreen === true &&
            current.alpha !== 0 && sameMacBounds(current.bounds, window.bounds);
          return geometryCurrent;
        };
        entries.push({ window, release, generation: selected.generation, isIdentityCurrent, isCurrent });
      } catch { unavailable++; }
    }
    let published = false;
    return {
      register: (capture: Frame, isCaptureCurrent: () => boolean) => {
        if (published || !this.cleanupGroups.has(cleanup) || !actor.isCurrent() || !isCaptureCurrent() || capture.expiresAt <= this.now()) {
          throw new Error('Desktop capture is no longer current');
        }
        const windows = [];
        for (const entry of entries) {
          if (!entry.isCurrent()) { unavailable++; continue; }
          const id = randomUUID();
          const issued = () => this.targets.has(id) && capture.expiresAt > this.now();
          this.targets.set(id, { ...entry, frame: capture, display, actor,
            isIdentityCurrent: () => issued() && entry.isIdentityCurrent(),
            isCurrent: () => issued() && isCaptureCurrent() && entry.isCurrent() });
          ids.push(id);
          windows.push({ windowId: id, title: clean(entry.window.title), app: clean(entry.window.ownerName) });
        }
        timer = setTimeout(cleanup, Math.max(1, capture.expiresAt - this.now()));
        timer.unref?.();
        published = true;
        const nextOffset = offset + PAGE_SIZE < eligible.length ? offset + PAGE_SIZE : null;
        return { windows, unavailable, nextOffset, complete: snapshot.complete && unavailable === 0 && nextOffset === null };
      },
      close: () => { if (!published) cleanup(); },
      discard: cleanup
    };
  }

  resolve(actor: TrustedDisplayActor, id: string): Selection {
    if (this.cleanupError) throw this.cleanupError;
    const choice = this.targets.get(id);
    if (!choice || actor.sessionId !== choice.actor.sessionId || actor.taskId !== choice.actor.taskId || !actor.isCurrent() || !choice.isCurrent()) {
      throw new Error('macOS window selection is stale or unavailable; capture the display again');
    }
    return choice;
  }

  /** For foreground pointer actions, the selected window must own every endpoint. */
  pointsOnTarget(choice: Selection, points: readonly Point[]): boolean {
    if (!points.length) return true;
    const windows = this.inventory().windows;
    return points.every(point => {
      if (!contains(choice.window.bounds, point)) return false;
      // WindowServer lists click-through overlays along with input surfaces.
      // Prefer the system accessibility hit test when it resolves an exact window.
      const ax = this.native.windowAtPoint?.(point.x, point.y);
      if (ax) return ax.windowId === choice.window.windowId && ax.pid === choice.window.pid;
      const hit = windows.find(window => window.alpha !== 0 && contains(window.bounds, point));
      return hit?.windowId === choice.window.windowId && hit.pid === choice.window.pid;
    });
  }

  close(): void {
    for (const cleanup of this.cleanupGroups) cleanup();
    if (this.cleanupError) throw this.cleanupError;
  }
}

export function macCapturePoint(choice: Selection, x: number, y: number): Point {
  const { frame, display } = choice;
  if (Math.abs(frame.sourceSize.width - frame.sourceSize.height * display.bounds.width / display.bounds.height) > 2) {
    throw new Error('macOS display screenshot geometry cannot be matched to screen points');
  }
  const scaleX = display.bounds.width / frame.sourceSize.width;
  const scaleY = display.bounds.height / frame.sourceSize.height;
  return capturePointToInput({ ...frame, targetSpace: 'platform-input-v1', transform: {
    originX: display.bounds.x + frame.region.x * scaleX, originY: display.bounds.y + frame.region.y * scaleY, scaleX, scaleY
  } }, display, { x, y });
}
