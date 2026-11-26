import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DRIVER_COMMIT, DRIVER_VERSION, RELEASE_URL, supportedTargets } from './catalog.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const DEFAULT_OUTPUT = path.join(root, '.tmp', 'desktop-driver', 'sbom.cdx.json');

function packageName(location, record) {
  if (typeof record.name === 'string' && record.name) return record.name;
  const marker = 'node_modules/';
  const index = location.lastIndexOf(marker);
  if (index < 0) return null;
  const tail = location.slice(index + marker.length);
  if (tail.startsWith('@')) return tail.split('/').slice(0, 2).join('/');
  return tail.split('/')[0];
}

function npmComponent(location, record) {
  const name = packageName(location, record);
  if (!name || typeof record.version !== 'string' || !record.version) return null;
  const component = { type: 'library', name, version: record.version, purl: `pkg:npm/${name}@${record.version}` };
  if (record.dev === true) component.scope = 'optional';
  if (typeof record.resolved === 'string') component.externalReferences = [{ type: 'distribution', url: record.resolved }];
  if (typeof record.integrity === 'string' && record.integrity.startsWith('sha512-')) {
    component.hashes = [{ alg: 'SHA-512', content: Buffer.from(record.integrity.slice('sha512-'.length), 'base64').toString('hex') }];
  }
  return component;
}

/** Build a deterministic CycloneDX document from package-lock and the pinned Cua catalog. */
export function buildSbom({ lockfile = path.join(root, 'package-lock.json') } = {}) {
  const lock = JSON.parse(fs.readFileSync(lockfile, 'utf8').replace(/^\uFEFF/, ''));
  const components = [];
  for (const [location, record] of Object.entries(lock.packages ?? {})) {
    if (!location || !record || location === '') continue;
    const component = npmComponent(location, record);
    if (component) components.push(component);
  }
  components.push({ type: 'application', group: 'trycua', name: 'cua-driver', version: DRIVER_VERSION,
    externalReferences: [{ type: 'vcs', url: `https://github.com/trycua/cua/tree/${DRIVER_COMMIT}/libs/cua-driver` },
      { type: 'distribution', url: RELEASE_URL }],
    properties: [{ name: 'muster:upstreamCommit', value: DRIVER_COMMIT },
      { name: 'muster:catalogTargets', value: supportedTargets().join(',') },
      { name: 'muster:noticeFiles', value: 'LICENSE,THIRD_PARTY_NOTICES.md,MPL-2.0.txt,node-runtime-NOTICE.md,SOURCES.md' },
      { name: 'muster:runtimeVerified', value: 'false' },
      { name: 'muster:signatureVerified', value: 'false' }] });
  components.sort((a, b) => `${a.type}:${a.group ?? ''}:${a.name}:${a.version}`.localeCompare(`${b.type}:${b.group ?? ''}:${b.name}:${b.version}`));
  const appVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version ?? '0.0.0';
  return { bomFormat: 'CycloneDX', specVersion: '1.5', version: 1,
    metadata: { timestamp: '1970-01-01T00:00:00.000Z', tools: [{ vendor: 'Muster', name: 'desktop-driver:sbom', version: '1.0.0' }],
      component: { type: 'application', name: 'muster-console', version: String(appVersion) },
      properties: [{ name: 'muster:cuaCatalogCommit', value: DRIVER_COMMIT }, { name: 'muster:licenseReview', value: 'incomplete' }] },
    components };
}

export function writeSbom(output = DEFAULT_OUTPUT, options = {}) {
  const document = buildSbom(options);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  return document;
}

export function checkSbom(output = DEFAULT_OUTPUT, options = {}) {
  const expected = JSON.stringify(buildSbom(options));
  const actual = JSON.stringify(JSON.parse(fs.readFileSync(output, 'utf8').replace(/^\uFEFF/, '')));
  if (expected !== actual) throw new Error(`SBOM differs from the current lockfile/catalog: ${output}`);
  return true;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const mode = process.argv[2] ?? '--check';
  const output = process.argv[3] ? path.resolve(process.argv[3]) : DEFAULT_OUTPUT;
  if (mode === '--write') { writeSbom(output); console.log(`desktop-driver SBOM written: ${output}`); }
  else if (mode === '--check') { checkSbom(output); console.log(`desktop-driver SBOM verified: ${output}`); }
  else throw new Error('Usage: node scripts/desktop-driver/sbom.mjs --write|--check [output]');
}
