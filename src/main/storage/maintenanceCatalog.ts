import path from 'node:path';
import type { StorageMaintenanceId } from '../../shared/storageMaintenance';
import { userDataStorage, type StorageFilePurpose, type StoragePurpose } from '../runtimeKernel/storageRootResolver';

export interface MaintenanceMember {
  name: string;
  kind: 'file' | 'directory';
}
export interface MaintenanceRule {
  id: StorageMaintenanceId;
  members: MaintenanceMember[];
}

/** Each group owns all companions that would otherwise bring back the selected data. */
export function maintenanceCatalog(userData: string, ownsChromiumData: boolean): MaintenanceRule[] {
  const storage = userDataStorage(userData);
  const directory = (name: string): MaintenanceMember => ({ name, kind: 'directory' });
  const file = (name: string): MaintenanceMember => ({ name, kind: 'file' });
  const purpose = (id: StoragePurpose) => directory(path.basename(storage.resolve('app', id)));
  const registeredFile = (id: StorageFilePurpose) => file(path.basename(storage.file(id)));
  const database = (base: MaintenanceMember) => [base, ...['-wal', '-shm', '-journal'].map(suffix => file(base.name + suffix))];
  const cache = purpose('cache');
  const bgTasks = registeredFile('bg-tasks');
  const chromium: MaintenanceRule[] = ownsChromiumData ? [
    { id: 'chromiumCache', members: [
      ...['Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache',
        'GraphiteDawnCache', 'GrShaderCache', 'ShaderCache', 'Media Cache', 'blob_storage', 'Shared Dictionary'].map(directory),
      cache
    ] },
    { id: 'workbenchWebData', members: [
      ...['Local Storage', 'Session Storage', 'IndexedDB', 'Service Worker', 'WebStorage', 'File System', 'Network', 'databases'].map(directory),
      ...database(file('Cookies')), ...database(file('QuotaManager')), ...database(file('SharedStorage'))
    ] }
  ] : [];
  return [
    ...chromium,
    ...(!ownsChromiumData ? [{ id: 'appCache' as const, members: [cache] }] : []),
    { id: 'crashReports', members: ['Crashpad', 'Crash Reports'].map(directory) },
    { id: 'processProfiles', members: [directory(path.basename(storage.manifestPath('process-monitor-captures')))] },
    { id: 'modelCatalogs', members: [registeredFile('harness-model-catalogs'), registeredFile('provider-model-catalogs')] },
    { id: 'toolOutputs', members: [purpose('trim-cache')] },
    { id: 'evidence', members: [purpose('evidence')] },
    { id: 'desktopCaptures', members: [purpose('desktop-captures')] },
    { id: 'usageHistory', members: [registeredFile('usage-stats'), registeredFile('usage-llm-calls'), registeredFile('usage-tool-failures')] },
    { id: 'capabilityUsage', members: [registeredFile('capability-usage')] },
    { id: 'sessionReminders', members: database(registeredFile('session-reminders')) },
    { id: 'waitingTips', members: [registeredFile('waiting-tips')] },
    { id: 'backgroundTasks', members: [bgTasks, file(`${bgTasks.name}.bak`), purpose('bg-outputs')] }
  ];
}
