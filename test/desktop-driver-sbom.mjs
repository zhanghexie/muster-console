import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DRIVER_VERSION } from '../scripts/desktop-driver/catalog.mjs';
import { checkSbom, writeSbom } from '../scripts/desktop-driver/sbom.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-desktop-sbom-'));
const output = path.join(temp, 'bom.json');
try {
  const document = writeSbom(output);
  assert.equal(document.bomFormat, 'CycloneDX');
  assert.equal(document.specVersion, '1.5');
  assert.equal(document.metadata.tools[0].vendor, 'Muster');
  assert.equal(document.metadata.component.name, 'muster-console');
  assert.equal(document.components.find(component => component.name === 'cua-driver')?.version, DRIVER_VERSION);
  assert.ok(document.components.some(component => component.name === 'electron'));
  checkSbom(output);
  const changed = JSON.parse(fs.readFileSync(output, 'utf8'));
  changed.components.pop();
  fs.writeFileSync(output, `${JSON.stringify(changed)}\n`);
  assert.throws(() => checkSbom(output), /SBOM differs/);
  console.log('desktop-driver SBOM: deterministic package-lock and Cua catalog document passed');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
