import { randomUUID } from 'node:crypto';
import { unavailableDesktopCapabilities, type DesktopRuntime } from './runtime';
import type { Win32InventoryResult } from './win32Inventory';
import type { X11InventoryResult } from './x11Inventory';
import type { MacInventoryResult } from './macInventory';

export interface DesktopMetadataObservation {
  /** Observation only: this is not a surfaceId and cannot authorize an action. */
  observationId: string;
  title: string | null;
  pid: number | null;
  appLabel: string | null;
  bounds: { x: number; y: number; width: number; height: number };
  coordinateSpace: string;
  limitations: string[];
}

/** Do not expose raw native handles or claim actionable identities before incarnation tracking exists. */
export function projectDesktopMetadata(runtime: DesktopRuntime, result: Win32InventoryResult | X11InventoryResult | MacInventoryResult): {
  runtime: DesktopRuntime; observations: DesktopMetadataObservation[]; complete: boolean; omitted: number;
  limitations: string[]; capabilities: ReturnType<typeof unavailableDesktopCapabilities>;
} {
  if (!['windows', 'macos', 'linux-x11', 'linux-wayland', 'linux-unknown', 'unsupported'].includes(runtime)) throw new Error('Invalid desktop runtime');
  if (!result || !Array.isArray(result.windows) || !Array.isArray(result.limitations) || typeof result.complete !== 'boolean' ||
      !Number.isSafeInteger(result.omitted) || result.omitted < 0) throw new Error('Invalid desktop inventory');
  const observations = result.windows.map(item => {
    const expected = runtime === 'windows' ? 'win32-screen-caller-dpi' : runtime === 'macos' ? 'coregraphics-screen-space' : runtime === 'linux-x11' ? 'x11-root-pixels' : null;
    if (!item || !expected || item.coordinateSpace !== expected || !item.bounds ||
        ![item.bounds.x, item.bounds.y, item.bounds.width, item.bounds.height].every(Number.isFinite) ||
        item.bounds.width <= 0 || item.bounds.height <= 0 || (item.title !== null && typeof item.title !== 'string') ||
        (item.pid !== null && (!Number.isSafeInteger(item.pid) || item.pid <= 0)) || !Array.isArray(item.limitations) ||
        item.limitations.some(value => typeof value !== 'string')) throw new Error('Invalid desktop observation');
    const appLabel = 'processImage' in item ? item.processImage : 'ownerName' in item ? item.ownerName : null;
    if (appLabel !== null && typeof appLabel !== 'string') throw new Error('Invalid desktop app label');
    return { observationId: randomUUID(), title: item.title, pid: item.pid, appLabel,
      bounds: { ...item.bounds }, coordinateSpace: item.coordinateSpace,
      limitations: [...item.limitations, 'metadata_only_not_actionable'] };
  });
  return { runtime, observations, complete: result.complete, omitted: result.omitted,
    limitations: [...result.limitations, 'metadata_only_not_actionable'], capabilities: unavailableDesktopCapabilities(runtime) };
}
