import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { extractTCallKeyPositions } from '../../../src/shared/dimensionGates';
import { en } from '../../../src/shared/i18n/locales/en';
import { storageMaintenanceCopy } from '../../../src/shared/storageMaintenance';

it('provides English translations for local-storage renderer and cleanup messages', () => {
  for (const file of ['src/renderer/src/components/settings/LocalStoragePane.tsx', 'src/main/storage/inventory.ts', 'src/main/storage/startupMaintenance.ts']) {
    const source = fs.readFileSync(path.resolve(process.cwd(), file), 'utf8');
    const missing = [...new Set(extractTCallKeyPositions(source).map(entry => entry.key).filter(key => !Object.hasOwn(en, key)))];
    expect(missing, file).toEqual([]);
  }
});

it('translates the name and impact of each Other data cleanup group', () => {
  for (const { name, effect } of Object.values(storageMaintenanceCopy)) {
    expect(en[name]).toBeTruthy();
    expect(en[effect]).toBeTruthy();
  }
});
