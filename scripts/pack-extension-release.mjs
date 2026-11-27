import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');

export async function withExtensionPackageSnapshot(useSnapshot) {
  const { build } = await import('esbuild');
  const tempRoot = path.join(root, '.tmp');
  await fs.mkdir(tempRoot, { recursive: true });
  const temp = await fs.mkdtemp(path.join(tempRoot, 'extension-release-build-'));
  try {
    const compiled = path.join(temp, 'snapshot.mjs');
    await build({
      entryPoints: [path.join(root, 'src/main/extensions/extensionPackageSnapshot.ts')],
      outfile: compiled, bundle: true, format: 'esm', platform: 'node', packages: 'external',
    });
    return await useSnapshot(await import(pathToFileURL(compiled)));
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}

async function packRelease(directory, output, previousDirectories, { captureExtensionPackageAsync, validateExtensionPackage, encodeExtensionPackage }) {
  const extensionId = path.basename(path.resolve(directory));
  const snapshot = await captureExtensionPackageAsync(directory);
  const manifest = validateExtensionPackage(snapshot, extensionId);
  if (!manifest.version || manifest.scope !== 'global') throw new Error('Center releases must have a version and global scope');

  const previousFingerprints = new Set();
  for (const source of previousDirectories) {
    const previous = await captureExtensionPackageAsync(source);
    validateExtensionPackage(previous, extensionId);
    if (previous.fingerprint !== snapshot.fingerprint) previousFingerprints.add(previous.fingerprint);
  }
  const artifact = encodeExtensionPackage(extensionId, snapshot);
  if (artifact.length > 100_000_000) throw new Error('Artifact exceeds the GitHub Contents API file limit');
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, artifact, { flag: 'wx' });
  console.log(JSON.stringify({
    extensionId, name: manifest.name, description: manifest.description, version: manifest.version,
    ...(manifest.icon ? { icon: manifest.icon } : {}),
    fingerprint: snapshot.fingerprint, sha256: createHash('sha256').update(artifact).digest('hex'),
    previousFingerprints: [...previousFingerprints],
  }, null, 2));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [directory, output, ...previousDirectories] = process.argv.slice(2);
  if (!directory || !output) throw new Error('Usage: node scripts/pack-extension-release.mjs <extension directory> <artifact.json> [previous extension directory ...]');
  await withExtensionPackageSnapshot(snapshot => packRelease(directory, output, previousDirectories, snapshot));
}
