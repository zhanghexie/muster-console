import { userDataStorage } from '../runtimeKernel/storageRootResolver';
import path from 'node:path';
import type { screen, powerMonitor } from 'electron';
import { DesktopAuditStore } from './auditStore';
import { ElectronDisplayRegistry } from './displayRegistry';
import { runDesktopInventory } from './inventoryProcess';
import { DesktopMetadataRuntime } from './metadataRuntime';

/** Create lazily so absent platform services cannot prevent the workbench from starting. */
export function createDesktopMetadataRuntime(userData: string, moduleDir: string,
  display: typeof screen, power: typeof powerMonitor): DesktopMetadataRuntime {
  if (!path.isAbsolute(userData) || !path.isAbsolute(moduleDir)) throw new Error('Desktop metadata paths must be absolute');
  const registry = new ElectronDisplayRegistry(display, power);
  let audit: DesktopAuditStore | undefined;
  try {
    audit = new DesktopAuditStore(path.join(userDataStorage(userData).resolve('app', 'desktop'), 'audit.sqlite'));
    return new DesktopMetadataRuntime(registry,
      signal => runDesktopInventory({ workerFile: path.join(moduleDir, 'desktop', 'inventory-worker.cjs'), signal }), audit);
  } catch (error) {
    registry.dispose(); audit?.close();
    throw error;
  }
}
