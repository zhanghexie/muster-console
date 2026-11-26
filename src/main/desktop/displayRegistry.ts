import { randomUUID } from 'node:crypto';
import type { DisplayCaptureTarget } from './displayCapture';

interface RawDisplay {
  id: number;
  label?: string;
  bounds: { x: number; y: number; width: number; height: number };
  scaleFactor: number;
  rotation: number;
}
interface DisplayProvider {
  getAllDisplays(): RawDisplay[];
  on(event: string, listener: (...args: any[]) => void): unknown;
  removeListener(event: string, listener: (...args: any[]) => void): unknown;
}
interface PowerProvider {
  on(event: 'suspend' | 'resume', listener: () => void): unknown;
  removeListener(event: 'suspend' | 'resume', listener: () => void): unknown;
}
export interface DisplaySurface {
  surfaceId: string;
  surfaceGeneration: string;
  geometryRevision: string;
  title: string;
  bounds: RawDisplay['bounds'];
  scaleFactor: number;
  rotation: number;
  coordinateSpace: 'electron-dip';
}
type StoredDisplay = { nativeId: number; surface: DisplaySurface };

/** Screen metadata only. Subscribes before first enumeration and never starts capture or a portal. */
export class ElectronDisplayRegistry {
  private items = new Map<number, StoredDisplay>();
  private disposed = false;
  private suspended = false;
  private powerRevision = 0;
  private readonly onSuspend = (): void => { this.powerRevision++; this.suspended = true; this.items.clear(); };
  private readonly onResume = (): void => { this.powerRevision++; this.items.clear(); this.suspended = false; };
  private readonly onAdded = (_event: unknown, display: RawDisplay): void => { this.invalidateIdentity(display?.id); };
  private readonly onRemoved = (_event: unknown, display: RawDisplay): void => { this.invalidateIdentity(display?.id); };
  private readonly onMetrics = (_event: unknown, display: RawDisplay): void => {
    const item = this.items.get(display?.id);
    if (item) item.surface.geometryRevision = randomUUID();
    else if (!Number.isSafeInteger(display?.id)) this.items.clear();
  };

  constructor(private readonly provider: DisplayProvider, private readonly power: PowerProvider) {
    if (!provider || typeof provider.getAllDisplays !== 'function' || typeof provider.on !== 'function' || typeof provider.removeListener !== 'function') throw new Error('Invalid display provider');
    if (!power || typeof power.on !== 'function' || typeof power.removeListener !== 'function') throw new Error('Display power monitoring is required');
    try {
      power.on('suspend', this.onSuspend);
      power.on('resume', this.onResume);
      provider.on('display-added', this.onAdded);
      provider.on('display-removed', this.onRemoved);
      provider.on('display-metrics-changed', this.onMetrics);
      this.refresh();
    } catch (error) { this.dispose(); throw error; }
  }

  private invalidateIdentity(id: unknown): void {
    if (typeof id !== 'number' || !Number.isSafeInteger(id)) this.items.clear();
    else this.items.delete(id);
  }

  /** Host must invoke after any other period when display events may have been missed. */
  invalidateAll(): void {
    if (this.disposed) throw new Error('Display registry is closed');
    this.items.clear();
  }

  /** A malformed or incomplete snapshot clears old identities instead of retaining stale targets. */
  refresh(): { surfaces: DisplaySurface[]; omitted: number } {
    if (this.disposed) throw new Error('Display registry is closed');
    if (this.suspended) throw new Error('Display registry is suspended');
    const powerRevision = this.powerRevision;
    try {
      const displays = this.provider.getAllDisplays();
      if (!Array.isArray(displays)) throw new Error('Invalid display snapshot');
      const next = new Map<number, StoredDisplay>();
      let omitted = 0;
      for (const display of displays) {
        const b = display?.bounds;
        if (!display || !Number.isSafeInteger(display.id) || !b ||
            ![b.x, b.y, b.width, b.height, display.scaleFactor].every(Number.isFinite) ||
            b.width <= 0 || b.height <= 0 || display.scaleFactor <= 0 || ![0, 90, 180, 270].includes(display.rotation) ||
            (display.label !== undefined && typeof display.label !== 'string')) throw new Error('Invalid display metadata');
        // Electron reserves negative IDs for invalid or unified displays; they cannot bind a source safely.
        if (display.id < 0) { omitted++; continue; }
        if (next.has(display.id)) throw new Error('Duplicate display identity');
        const old = this.items.get(display.id), previous = old?.surface;
        const sameGeometry = previous && previous.bounds.x === b.x && previous.bounds.y === b.y &&
          previous.bounds.width === b.width && previous.bounds.height === b.height && previous.scaleFactor === display.scaleFactor && previous.rotation === display.rotation;
        next.set(display.id, { nativeId: display.id, surface: {
          surfaceId: previous?.surfaceId ?? randomUUID(), surfaceGeneration: previous?.surfaceGeneration ?? randomUUID(),
          geometryRevision: sameGeometry ? previous.geometryRevision : randomUUID(), title: display.label?.trim() || 'Display',
          bounds: { ...b }, scaleFactor: display.scaleFactor, rotation: display.rotation, coordinateSpace: 'electron-dip'
        } });
      }
      if (this.suspended || this.powerRevision !== powerRevision) throw new Error('Display power state changed during enumeration');
      this.items = next;
      return { surfaces: [...next.values()].map(item => ({ ...item.surface, bounds: { ...item.surface.bounds } })), omitted };
    } catch (error) { this.items.clear(); throw error; }
  }

  captureTarget(taskId: string, surfaceId: string): DisplayCaptureTarget {
    if (typeof taskId !== 'string' || !taskId.trim() || typeof surfaceId !== 'string' || !surfaceId.trim()) throw new Error('Invalid display capture scope');
    this.refresh();
    const item = [...this.items.values()].find(value => value.surface.surfaceId === surfaceId);
    if (!item) throw new Error('Display is no longer available');
    return { taskId, surfaceId, surfaceGeneration: item.surface.surfaceGeneration, geometryRevision: item.surface.geometryRevision,
      displayId: item.nativeId, bounds: { ...item.surface.bounds }, scaleFactor: item.surface.scaleFactor };
  }

  isCurrent(target: DisplayCaptureTarget): boolean {
    try {
      this.refresh();
      const item = this.items.get(target.displayId);
      return !!item && item.surface.surfaceId === target.surfaceId && item.surface.surfaceGeneration === target.surfaceGeneration &&
        item.surface.geometryRevision === target.geometryRevision;
    } catch { return false; }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.items.clear();
    this.power.removeListener('suspend', this.onSuspend);
    this.power.removeListener('resume', this.onResume);
    for (const [event, listener] of [['display-added', this.onAdded], ['display-removed', this.onRemoved], ['display-metrics-changed', this.onMetrics]] as const) {
      this.provider.removeListener(event, listener);
    }
  }
}
