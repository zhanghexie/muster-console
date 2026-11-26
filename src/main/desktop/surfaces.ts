/** Trusted platform adapter output; never populate this from tool arguments. */
export interface ObservedDesktopSurface {
  backend: string;
  nativeId: string;
  appId: string;
  processInstance: string;
  /** Adapter-proven window incarnation, not just a recyclable native handle. */
  windowInstance: string;
  title: string;
  bounds: { x: number; y: number; width: number; height: number };
  dpiScale: number;
}
export interface DesktopSurface extends ObservedDesktopSurface {
  surfaceId: string;
  surfaceGeneration: string;
  geometryRevision: string;
}
import { randomUUID } from 'node:crypto';

/** Registry of adapter observations; never infers a process identity from a capture source. */
export class DesktopSurfaceRegistry {
  private surfaces = new Map<string, DesktopSurface>();

  /** Replace one backend's complete enumeration atomically. Missing windows expire immediately. */
  replace(backend: string, observations: readonly ObservedDesktopSurface[]): void {
    if (typeof backend !== 'string' || !backend.trim() || !Array.isArray(observations)) throw new Error('Invalid desktop surface enumeration');
    const seen = new Set<string>();
    for (const item of observations) {
      const b = item?.bounds;
      if (!item || item.backend !== backend || typeof item.nativeId !== 'string' || !item.nativeId.trim() ||
          typeof item.appId !== 'string' || !item.appId.trim() || typeof item.processInstance !== 'string' || !item.processInstance.trim() ||
          typeof item.windowInstance !== 'string' || !item.windowInstance.trim() ||
          typeof item.title !== 'string' || !b || ![b.x, b.y, b.width, b.height, item.dpiScale].every(Number.isFinite) ||
          b.width <= 0 || b.height <= 0 || item.dpiScale <= 0 || seen.has(item.nativeId)) {
        throw new Error('Invalid or duplicate desktop surface');
      }
      seen.add(item.nativeId);
    }
    const next = new Map([...this.surfaces].filter(([, item]) => item.backend !== backend));
    for (const item of observations) {
      const key = JSON.stringify([backend, item.nativeId]);
      const old = this.surfaces.get(key);
      const sameProcess = !!old && old.appId === item.appId && old.processInstance === item.processInstance &&
        old.windowInstance === item.windowInstance;
      const sameGeometry = !!old && sameProcess && old.bounds.x === item.bounds.x && old.bounds.y === item.bounds.y &&
        old.bounds.width === item.bounds.width && old.bounds.height === item.bounds.height && old.dpiScale === item.dpiScale;
      next.set(key, { ...item, bounds: { ...item.bounds },
        surfaceId: sameProcess && old ? old.surfaceId : randomUUID(),
        surfaceGeneration: sameProcess && old ? old.surfaceGeneration : randomUUID(),
        geometryRevision: sameGeometry && old ? old.geometryRevision : randomUUID() });
    }
    this.surfaces = next;
  }

  list(): DesktopSurface[] {
    return [...this.surfaces.values()].map(item => ({ ...item, bounds: { ...item.bounds } }));
  }

  get(surfaceId: string): DesktopSurface | undefined {
    return this.list().find(item => item.surfaceId === surfaceId);
  }
}
